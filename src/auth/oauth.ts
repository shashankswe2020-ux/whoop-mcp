/**
 * OAuth2 Authorization Code flow for the WHOOP API.
 *
 * Orchestrates: build auth URL → open browser → wait for callback code
 * → exchange code for tokens → save to token store. Also handles token refresh.
 */

import type { OAuthTokens } from "./token-store.js";
import { loadTokens, saveTokens, isTokenExpired } from "./token-store.js";
import { startCallbackServer } from "./callback-server.js";
import {
  WHOOP_AUTH_URL,
  WHOOP_TOKEN_URL,
  WHOOP_REDIRECT_URI,
  WHOOP_REQUIRED_SCOPES,
} from "../api/endpoints.js";
import { WhoopNetworkError } from "../api/client.js";
import { acquireOAuthFlowLock } from "./oauth-lock.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the OAuth flow */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Override the default redirect URI. Default: WHOOP_REDIRECT_URI */
  redirectUri?: string;
  /** Token storage directory. Default: ~/.whoop-mcp/ */
  tokenDir?: string;
  /** Callback server port, if provided, must match the redirect URI. */
  port?: number;
}

/** Raw token response from the WHOOP token endpoint */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

interface LocalRedirect {
  host: string;
  port: number;
  callbackPath: string;
}

function parseLocalRedirect(config: OAuthConfig): LocalRedirect {
  const value = config.redirectUri ?? WHOOP_REDIRECT_URI;
  let redirectUri: URL;

  try {
    redirectUri = new URL(value);
  } catch {
    throw new Error("WHOOP_REDIRECT_URI must be a valid URL");
  }

  if (redirectUri.protocol !== "http:") {
    throw new Error("WHOOP_REDIRECT_URI must use HTTP");
  }
  if (redirectUri.username || redirectUri.password) {
    throw new Error("WHOOP_REDIRECT_URI must not include credentials");
  }
  if (value.includes("?") || value.includes("#")) {
    throw new Error("WHOOP_REDIRECT_URI must not include a query string or fragment");
  }
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)) {
    throw new Error("WHOOP_REDIRECT_URI must use localhost, 127.0.0.1, or [::1]");
  }

  const loopbackHosts: Record<string, string> = {
    localhost: "127.0.0.1",
    "127.0.0.1": "127.0.0.1",
    "[::1]": "::1",
  };
  const host = loopbackHosts[redirectUri.hostname];
  if (!host) {
    throw new Error("WHOOP_REDIRECT_URI must use localhost, 127.0.0.1, or [::1]");
  }

  const port = Number(redirectUri.port || "80");
  if (port < 1) {
    throw new Error("WHOOP_REDIRECT_URI must use a port between 1 and 65535");
  }
  if (config.port !== undefined && config.port !== port) {
    throw new Error("OAuth callback port must match WHOOP_REDIRECT_URI");
  }

  return { host, port, callbackPath: redirectUri.pathname };
}

// ---------------------------------------------------------------------------
// buildAuthorizationUrl
// ---------------------------------------------------------------------------

/**
 * Build the WHOOP authorization URL with all required parameters.
 *
 * Constructs a properly-encoded URL that the user will be redirected to
 * in order to authorize the application.
 */
export function buildAuthorizationUrl(
  config: OAuthConfig,
  state: string,
  codeChallenge?: string
): string {
  const url = new URL(WHOOP_AUTH_URL);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri ?? WHOOP_REDIRECT_URI);
  url.searchParams.set("scope", WHOOP_REQUIRED_SCOPES);
  url.searchParams.set("state", state);
  if (codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  return url.toString();
}

// ---------------------------------------------------------------------------
// exchangeCodeForTokens
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for tokens.
 *
 * POSTs to the WHOOP token endpoint with `application/x-www-form-urlencoded`
 * body per OAuth2 spec.
 */
export async function exchangeCodeForTokens(
  code: string,
  config: OAuthConfig,
  codeVerifier?: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri ?? WHOOP_REDIRECT_URI,
  });
  if (codeVerifier) {
    body.set("code_verifier", codeVerifier);
  }

  const response = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const description =
      typeof errorBody.error_description === "string"
        ? errorBody.error_description
        : "unknown error";
    throw new Error(`Token exchange failed (${response.status}): ${description}`);
  }

  return (await response.json()) as TokenResponse;
}

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------

/**
 * Use the refresh token to obtain a new access token.
 *
 * POSTs to the WHOOP token endpoint with `grant_type=refresh_token`.
 */
export async function refreshAccessToken(
  refreshToken: string,
  config: OAuthConfig
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: "offline",
  });

  let response: Response;
  try {
    response = await fetch(WHOOP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (error) {
    // fetch throws on transport-level failures (DNS, TCP, TLS) — distinct from auth failure.
    throw new WhoopNetworkError(error);
  }

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const description =
      typeof errorBody.error_description === "string"
        ? errorBody.error_description
        : "unknown error";
    throw new Error(`Token refresh failed (${response.status}): ${description}`);
  }

  return (await response.json()) as TokenResponse;
}

// ---------------------------------------------------------------------------
// toOAuthTokens
// ---------------------------------------------------------------------------

/**
 * Convert the raw TokenResponse into our OAuthTokens shape for storage.
 *
 * Computes `expires_at` (absolute epoch ms) from `expires_in` (relative seconds).
 *
 * Per RFC 6749 §6, the authorization server MAY issue a new refresh token on
 * refresh — but is not required to. If the response omits `refresh_token`,
 * pass `existingRefreshToken` to preserve the current one so the token file
 * stays valid on the next load.
 */
export function toOAuthTokens(response: TokenResponse, existingRefreshToken?: string): OAuthTokens {
  return {
    access_token: response.access_token,
    refresh_token: response.refresh_token || existingRefreshToken || "",
    expires_at: Date.now() + response.expires_in * 1000,
    token_type: response.token_type,
  };
}

// ---------------------------------------------------------------------------
// openBrowser
// ---------------------------------------------------------------------------

/**
 * Open a URL in the user's default browser.
 *
 * Uses `spawn` with argument arrays to avoid shell injection.
 * Throws if the URL is malformed or not http(s) — callers must pass a
 * trusted scheme. Otherwise best-effort: spawn errors are logged, not thrown.
 */
export function openBrowser(url: string): void {
  // Reject non-http(s) schemes (e.g. javascript:, file:, vbscript:) before spawn.
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Refusing to open browser for non-HTTP(S) URL scheme: ${parsed.protocol}`);
  }
  // Fragments can carry credentials (the dashboard token), so they never reach logs.
  const hashIndex = url.indexOf("#");
  const manualHint =
    hashIndex === -1
      ? `Please open this URL manually:\n${url}`
      : `Open the full link returned by the tool (its access part is not logged):\n${url.slice(0, hashIndex)}`;
  try {
    const commands: Record<string, [string, string[]]> = {
      darwin: ["open", [url]],
      // Pass empty title argument ("") to avoid Windows `start` parsing pitfalls.
      win32: ["cmd", ["/c", "start", '""', url]],
      linux: ["xdg-open", [url]],
    };

    const [cmd, args] = commands[process.platform] ?? ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    // spawn emits 'error' asynchronously when the command can't be found
    // (e.g. running in a headless container with no xdg-open). Without a
    // handler, Node treats this as an unhandled error and crashes the process.
    child.on("error", () => {
      console.error(`\nCould not open browser automatically. ${manualHint}\n`);
    });
    child.unref();
  } catch {
    // Best-effort — log the URL for manual copy/paste
    console.error(`\nCould not open browser automatically. ${manualHint}\n`);
  }
}

// ---------------------------------------------------------------------------
// authenticate
// ---------------------------------------------------------------------------

/**
 * Main entry point. Returns a valid access token.
 *
 * - If valid (non-expired) tokens exist on disk → returns `access_token`
 * - If tokens exist but are expired → refreshes and returns new `access_token`
 * - If no tokens or refresh fails → starts full OAuth flow
 */
export async function authenticate(config: OAuthConfig): Promise<string> {
  // Validate required credentials
  if (!config.clientId) {
    throw new Error("Missing WHOOP_CLIENT_ID. Set it in your environment variables.");
  }
  if (!config.clientSecret) {
    throw new Error("Missing WHOOP_CLIENT_SECRET. Set it in your environment variables.");
  }

  // 1. Check for existing tokens
  const existing = await loadTokens(config.tokenDir);

  if (existing) {
    // 2a. If valid, return immediately
    if (!isTokenExpired(existing)) {
      console.error("Using cached WHOOP tokens (not expired).");
      return existing.access_token;
    }

    // 2b. If expired, try to refresh
    console.error("Cached tokens expired, attempting refresh...");
    try {
      const refreshed = await refreshAccessToken(existing.refresh_token, config);
      const tokens = toOAuthTokens(refreshed, existing.refresh_token);
      await saveTokens(tokens, config.tokenDir);
      console.error("Token refresh successful.");
      return tokens.access_token;
    } catch (error: unknown) {
      // Network failures shouldn't force the user through a fresh OAuth flow — let the caller retry.
      if (error instanceof WhoopNetworkError) {
        throw error;
      }
      // Log the refresh failure so it's diagnosable, then fall through to full OAuth flow
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`Token refresh failed, starting full OAuth flow: ${message}`);
    }
  } else {
    console.error("No cached tokens found, starting OAuth flow...");
  }

  // 3. Full OAuth flow
  return performOAuthFlowWithLock(config);
}

async function performOAuthFlowWithLock(config: OAuthConfig): Promise<string> {
  const lock = await acquireOAuthFlowLock(config.tokenDir);
  try {
    const tokens = await loadTokens(config.tokenDir);
    if (tokens && !isTokenExpired(tokens)) {
      console.error("Using WHOOP tokens created by another process.");
      return tokens.access_token;
    }
    return await performOAuthFlow(config);
  } finally {
    await lock.release();
  }
}

/**
 * Run the full OAuth Authorization Code flow:
 * start callback server → open browser → wait for code → exchange → save.
 */
async function performOAuthFlow(config: OAuthConfig): Promise<string> {
  const state = randomBytes(16).toString("hex");
  const pkce = generatePkcePair();
  const redirect = parseLocalRedirect(config);

  // Start the callback server before opening the browser
  const callbackHandle = startCallbackServer({
    host: redirect.host,
    port: redirect.port,
    callbackPath: redirect.callbackPath,
    expectedState: state,
  });

  // Build the authorization URL and open the browser
  const authUrl = buildAuthorizationUrl(config, state, pkce.codeChallenge);
  openBrowser(authUrl);

  console.error(
    `\nWaiting for WHOOP authorization...\nIf the browser didn't open, visit:\n${authUrl}\n`
  );

  // Wait for the callback
  const { code } = await callbackHandle.result;

  // Exchange the code for tokens
  const tokenResponse = await exchangeCodeForTokens(code, config, pkce.codeVerifier);
  const tokens = toOAuthTokens(tokenResponse);
  await saveTokens(tokens, config.tokenDir);

  return tokens.access_token;
}

function generatePkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}
