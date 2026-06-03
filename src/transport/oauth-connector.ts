/**
 * OAuth 2.1 connector provider for claude.ai web/mobile (Task 13c).
 *
 * Implements the SDK's `OAuthServerProvider` interface. The connector lets
 * claude.ai web/mobile clients authenticate to the MCP server via OAuth 2.1
 * + PKCE S256, with a connector password as the user-facing credential.
 *
 * Architecture:
 * - One static OAuth client registered at startup (claude.ai connector).
 * - Authorization codes stored in-memory with 60s TTL, one-time use.
 * - Access/refresh tokens are signed JWTs (HS256, HKDF-derived key).
 * - redirect_uri is validated as exact string match against the allowlist
 *   on BOTH `/authorize` and `/token`.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import express, { type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import {
  AuthCodeStore,
  UsedJtiStore,
  generateAuthCode,
  generateJti,
  isAllowedRedirectUri,
  validateConnectorPassword,
  validatePublicUrl,
} from "./oauth-helpers.js";
import {
  signToken,
  verifyToken,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "./oauth-jwt.js";

// ---------------------------------------------------------------------------
// Static client store — registers a single connector client at startup
// ---------------------------------------------------------------------------

export interface ConnectorClientConfig {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  clientName?: string;
}

class StaticClientsStore implements OAuthRegisteredClientsStore {
  private readonly client: OAuthClientInformationFull;

  constructor(config: ConnectorClientConfig) {
    this.client = {
      client_id: config.clientId,
      redirect_uris: config.redirectUris,
      ...(config.clientSecret !== undefined && { client_secret: config.clientSecret }),
      ...(config.clientName !== undefined && { client_name: config.clientName }),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return clientId === this.client.client_id ? this.client : undefined;
  }
}

// ---------------------------------------------------------------------------
// Provider options
// ---------------------------------------------------------------------------

export interface OAuthConnectorOptions {
  /** Static client config (single registered claude.ai connector) */
  client: ConnectorClientConfig;
  /** Allowed redirect URIs (exact match) */
  allowedRedirectUris: string[];
  /** JWT signing key (32 bytes) — derived via HKDF or set explicitly */
  jwtSecret: Uint8Array;
  /** Default scopes granted on successful auth */
  scopes: string[];
  /** Auth code store (injectable for tests) */
  authCodeStore?: AuthCodeStore;
  /** Consumed-jti store for refresh-token rotation reuse detection */
  usedJtiStore?: UsedJtiStore;
}

// ---------------------------------------------------------------------------
// OAuthConnectorProvider
// ---------------------------------------------------------------------------

export class OAuthConnectorProvider implements OAuthServerProvider {
  private readonly _clientsStore: StaticClientsStore;
  private readonly _authCodes: AuthCodeStore;
  private readonly _usedJtis: UsedJtiStore;
  private readonly _allowedRedirectUris: string[];
  private readonly _jwtSecret: Uint8Array;
  private readonly _scopes: string[];

  constructor(options: OAuthConnectorOptions) {
    this._clientsStore = new StaticClientsStore(options.client);
    this._authCodes = options.authCodeStore ?? new AuthCodeStore();
    this._usedJtis = options.usedJtiStore ?? new UsedJtiStore();
    this._allowedRedirectUris = options.allowedRedirectUris;
    this._jwtSecret = options.jwtSecret;
    this._scopes = options.scopes;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  /**
   * Begin authorization. The SDK has already validated `client_id`, `state`,
   * `code_challenge`, and `code_challenge_method=S256` before reaching here.
   *
   * We additionally enforce that `redirect_uri` exactly matches our allowlist
   * (the SDK's check is against the client's registered URIs, but we want a
   * second layer using `ALLOWED_REDIRECT_URIS` for defense in depth).
   *
   * Note: the password prompt UI is implemented separately as a route that
   * sits in front of the SDK's authorize handler; by the time we get here,
   * password verification has already passed (or this is being called by a
   * trusted internal flow).
   */
  async authorize(
    _client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Enforce PKCE S256 (defense in depth — SDK already enforces this in the
    // schema, but we make the contract explicit here)
    if (!params.codeChallenge) {
      throw new Error("PKCE code_challenge is required");
    }

    // Validate redirect_uri against our allowlist
    if (!isAllowedRedirectUri(params.redirectUri, this._allowedRedirectUris)) {
      throw new Error(`redirect_uri not in ALLOWED_REDIRECT_URIS: ${params.redirectUri}`);
    }

    // Generate a one-time authorization code
    const code = generateAuthCode();
    this._authCodes.store(code, {
      clientId: _client.client_id,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: "S256",
      redirectUri: params.redirectUri,
      state: params.state ?? "",
      scopes: params.scopes ?? this._scopes,
      ...(params.resource !== undefined && { resource: params.resource.toString() }),
    });

    // Build redirect URL with code (and state if provided)
    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) {
      redirectUrl.searchParams.set("state", params.state);
    }

    res.redirect(redirectUrl.toString());
  }

  /**
   * Return the codeChallenge stored when the authorization began.
   * Used by the SDK's PKCE verifier check.
   */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = this._authCodes.peek(authorizationCode);
    if (!record) {
      throw new Error("Invalid or expired authorization code");
    }
    return record.codeChallenge;
  }

  /**
   * Exchange an authorization code for access + refresh tokens.
   * Marks the code as consumed (replay protection).
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    const record = this._authCodes.consume(authorizationCode);
    if (!record) {
      throw new Error("Invalid, expired, or already-consumed authorization code");
    }

    // redirect_uri must exactly match what was used in /authorize AND must be
    // in our allowlist
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new Error("redirect_uri does not match the value used during /authorize");
    }
    if (!isAllowedRedirectUri(record.redirectUri, this._allowedRedirectUris)) {
      throw new Error("redirect_uri not in allowlist");
    }

    // Code must belong to the requesting client
    if (record.clientId !== client.client_id) {
      throw new Error("Authorization code was issued to a different client");
    }

    return this._issueTokens(client.client_id, record.scopes, record.resource);
  }

  /**
   * Exchange a refresh token for a new access token (and rotated refresh).
   */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const verified = await verifyToken(refreshToken, this._jwtSecret);

    if (verified.type !== "refresh") {
      throw new Error("Token is not a refresh token");
    }
    if (verified.clientId !== client.client_id) {
      throw new Error("Refresh token was issued to a different client");
    }

    // Reuse detection: refresh tokens MUST carry a jti and MUST NOT be replayed.
    // Per OAuth 2.1 §4.14 / RFC 6819 §5.2.2, a replayed refresh token signals
    // potential token theft.
    if (!verified.jti) {
      throw new Error("Refresh token missing jti — cannot enforce rotation");
    }
    if (this._usedJtis.has(verified.jti)) {
      throw new Error("Refresh token has already been used (replay detected)");
    }
    this._usedJtis.add(verified.jti, verified.expiresAt);

    // If scopes are requested, they must be a subset of the original grant
    const grantedScopes = verified.scopes;
    let newScopes = grantedScopes;
    if (scopes && scopes.length > 0) {
      for (const s of scopes) {
        if (!grantedScopes.includes(s)) {
          throw new Error(`Requested scope not in original grant: ${s}`);
        }
      }
      newScopes = scopes;
    }

    // Resource indicator MUST match the original grant exactly (RFC 8707 §2.2).
    // Caller-supplied resource cannot upgrade or alter the binding.
    if (resource !== undefined && resource.toString() !== verified.resource) {
      throw new Error("resource indicator does not match the original grant");
    }
    return this._issueTokens(client.client_id, newScopes, verified.resource);
  }

  /**
   * Verify a presented bearer token (JWT) and return AuthInfo for the request.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const verified = await verifyToken(token, this._jwtSecret);

    if (verified.type !== "access") {
      throw new Error("Token is not an access token");
    }

    const info: AuthInfo = {
      token,
      clientId: verified.clientId,
      scopes: verified.scopes,
      expiresAt: verified.expiresAt,
    };
    if (verified.resource !== undefined) {
      info.resource = new URL(verified.resource);
    }
    return info;
  }

  /**
   * Internal: shut down the auth code cleanup timer.
   * Call when stopping the server.
   */
  stop(): void {
    this._authCodes.stop();
    this._usedJtis.stop();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _issueTokens(
    clientId: string,
    scopes: string[],
    resource: string | undefined
  ): Promise<OAuthTokens> {
    const accessOpts = {
      clientId,
      scopes,
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
      type: "access" as const,
      ...(resource !== undefined && { resource }),
    };
    // Refresh tokens always get a fresh jti so each one is uniquely revocable
    const refreshOpts = {
      clientId,
      scopes,
      ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
      type: "refresh" as const,
      jti: generateJti(),
      ...(resource !== undefined && { resource }),
    };

    const [accessToken, refreshToken] = await Promise.all([
      signToken(accessOpts, this._jwtSecret),
      signToken(refreshOpts, this._jwtSecret),
    ]);

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

// ---------------------------------------------------------------------------
// Express app factory: password-prompt UI in front of the SDK's auth router
// ---------------------------------------------------------------------------

const HTML_FORBIDDEN = /[&<>"']/g;
const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(HTML_FORBIDDEN, (c) => HTML_ENTITIES[c] ?? c);
}

/** Constant-time password compare (hashes both sides to avoid length leak). */
function comparePassword(provided: string, expected: string): boolean {
  if (provided.length === 0 || expected.length === 0) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const AUTHORIZE_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
] as const;

function renderPasswordPage(params: Record<string, string>, error?: string): string {
  const hidden = AUTHORIZE_PARAMS.map((k) => {
    const v = params[k];
    if (v === undefined) return "";
    return `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`;
  }).join("\n      ");

  const errorBlock = error
    ? `<p style="color:#c00;margin:0 0 12px 0;">${escapeHtml(error)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WHOOP MCP — Authorize Connection</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f7f7f8; margin: 0; display: flex; align-items: center;
      justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: #fff; border-radius: 12px; padding: 32px; max-width: 400px;
      width: 100%; box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.04); }
    h1 { font-size: 18px; margin: 0 0 8px 0; }
    p { color: #555; font-size: 14px; line-height: 1.5; margin: 0 0 16px 0; }
    label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
    input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid #ddd;
      border-radius: 6px; font-size: 14px; box-sizing: border-box; }
    button { margin-top: 16px; width: 100%; padding: 10px; border: 0;
      border-radius: 6px; background: #111; color: #fff; font-size: 14px;
      font-weight: 500; cursor: pointer; }
    button:hover { background: #333; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize WHOOP MCP connection</h1>
    <p>Enter the connector password to grant this client access to your WHOOP data.</p>
    ${errorBlock}
    <form method="POST" action="/authorize" autocomplete="off">
      ${hidden}
      <label for="connector_password">Connector password</label>
      <input id="connector_password" name="connector_password" type="password"
             required autofocus>
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

/** Apply anti-clickjacking + tight CSP headers to the password-prompt response. */
function applyAuthorizePageHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  );
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export interface CreateOAuthAppOptions {
  /** Plain-text connector password (validated; must be ≥12 chars) */
  connectorPassword: string;
  /** Public origin (must be https://) — used as OAuth issuer */
  publicUrl: string;
  /** Allowed redirect URIs (exact match) */
  allowedRedirectUris: string[];
  /** JWT signing secret (32 bytes from HKDF or MCP_JWT_SECRET) */
  jwtSecret: Uint8Array;
  /** Default scopes granted to the connector */
  scopes: string[];
  /** Static client config */
  client: ConnectorClientConfig;
  /**
   * Configures Express's `trust proxy` setting so `express-rate-limit` and
   * `req.ip` reflect the real client IP behind a reverse proxy. Pass a number
   * of trusted hops (recommended) or a CIDR/IP string. Defaults to `false`
   * (no proxy trust) for safe local-dev behaviour.
   */
  trustProxy?: boolean | number | string | string[];
  /** Pre-built provider (for tests) — overrides internal construction */
  provider?: OAuthConnectorProvider;
}

export interface CreateOAuthAppResult {
  app: express.Express;
  provider: OAuthConnectorProvider;
  /** Stops periodic timers (auth code cleanup) */
  close: () => void;
}

/**
 * Build an Express app exposing the OAuth 2.1 connector endpoints:
 *   GET  /authorize       — password prompt page
 *   POST /authorize       — password verification → SDK authorize handler
 *   POST /token           — SDK token handler (PKCE-verified)
 *   POST /register        — SDK dynamic client registration
 *   GET  /.well-known/oauth-authorization-server  — metadata
 *
 * Caller is responsible for mounting on an HTTP server and adding /mcp routes.
 *
 * @throws Error if connectorPassword is too short or publicUrl isn't https://
 */
export function createOAuthApp(options: CreateOAuthAppOptions): CreateOAuthAppResult {
  // Startup validation — fail fast on misconfiguration
  validateConnectorPassword(options.connectorPassword);
  const publicUrl = validatePublicUrl(options.publicUrl);

  const provider =
    options.provider ??
    new OAuthConnectorProvider({
      client: options.client,
      allowedRedirectUris: options.allowedRedirectUris,
      jwtSecret: options.jwtSecret,
      scopes: options.scopes,
    });

  const app = express();
  app.disable("x-powered-by");
  if (options.trustProxy !== undefined) {
    app.set("trust proxy", options.trustProxy);
  }

  // Body parser for the password form (also used downstream by SDK)
  const formParser = express.urlencoded({ extended: false });

  // Per-endpoint rate limits (override the SDK's built-in rate limiting)
  const authorizeLimiter = rateLimit({
    windowMs: 60_000,
    limit: 3,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const tokenLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // GET /authorize — render password prompt with OAuth params as hidden fields
  app.get("/authorize", authorizeLimiter, (req: Request, res: Response) => {
    const params: Record<string, string> = {};
    for (const k of AUTHORIZE_PARAMS) {
      const v = req.query[k];
      if (typeof v === "string") params[k] = v;
    }
    applyAuthorizePageHeaders(res);
    res.status(200).send(renderPasswordPage(params));
  });

  // POST /authorize — verify password, then forward to SDK authorize handler
  app.post(
    "/authorize",
    authorizeLimiter,
    formParser,
    (req: Request, res: Response, next: NextFunction) => {
      const body = req.body as Record<string, unknown>;
      const provided = typeof body.connector_password === "string" ? body.connector_password : "";

      if (!comparePassword(provided, options.connectorPassword)) {
        const params: Record<string, string> = {};
        for (const k of AUTHORIZE_PARAMS) {
          const v = body[k];
          if (typeof v === "string") params[k] = v;
        }
        applyAuthorizePageHeaders(res);
        res.status(401).send(renderPasswordPage(params, "Incorrect password. Try again."));
        return;
      }

      // Strip the password before forwarding so it never reaches downstream logs
      delete body.connector_password;
      next();
    }
  );

  // Apply a separate token rate limit before the SDK router handles /token
  app.post("/token", tokenLimiter);

  // SDK auth router: handles /authorize (POST forwarded), /token, /register,
  // metadata endpoints. Disable its own rate limiting since we set our own.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      authorizationOptions: { rateLimit: false },
      tokenOptions: { rateLimit: false },
    })
  );

  return {
    app,
    provider,
    close: () => provider.stop(),
  };
}
