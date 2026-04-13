/**
 * OAuth2 Authorization Code flow for the WHOOP API.
 *
 * Orchestrates: build auth URL → open browser → wait for callback code
 * → exchange code for tokens → save to token store. Also handles token refresh.
 */

import type { OAuthTokens } from "./token-store.js";
import {
  loadTokens,
  saveTokens,
  isTokenExpired,
} from "./token-store.js";
import { startCallbackServer } from "./callback-server.js";
import {
  WHOOP_AUTH_URL,
  WHOOP_TOKEN_URL,
  WHOOP_REDIRECT_URI,
  WHOOP_REQUIRED_SCOPES,
} from "../api/endpoints.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";

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
  /** Callback server port. Default: 3000 */
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
): string {
  const url = new URL(WHOOP_AUTH_URL);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri ?? WHOOP_REDIRECT_URI);
  url.searchParams.set("scope", WHOOP_REQUIRED_SCOPES);
  url.searchParams.set("state", state);

  return url.toString();
}

// ---------------------------------------------------------------------------
// Client authentication helpers
// ---------------------------------------------------------------------------

/**
 * Build an HTTP Basic Authorization header from client credentials.
 *
 * Per RFC 6749 §2.3.1, the client_id and client_secret are URL-encoded,
 * joined with ':', and Base64-encoded.
 */
function basicAuthHeader(clientId: string, clientSecret: string): string {
  const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  return `Basic ${encoded}`;
}

/**
 * Format a token endpoint error into a human-readable message.
 *
 * Includes `error_description` and `error_hint` when available from the
 * WHOOP/Hydra error response for easier troubleshooting.
 */
function formatTokenError(
  context: string,
  status: number,
  errorBody: Record<string, unknown>,
): string {
  const description =
    typeof errorBody.error_description === "string"
      ? errorBody.error_description
      : "unknown error";
  const hint =
    typeof errorBody.error_hint === "string"
      ? ` Hint: ${errorBody.error_hint}`
      : "";
  return `${context} failed (${status}): ${description}${hint}`;
}

/**
 * Send a token request to the WHOOP token endpoint with automatic
 * client authentication method fallback.
 *
 * WHOOP's OAuth server (ORY Hydra) is strict about how client credentials
 * are sent. The `token_endpoint_auth_method` configured on the WHOOP
 * developer app determines the expected method:
 *
 * 1. **client_secret_basic** (default) — credentials in Authorization header
 * 2. **client_secret_post** — credentials in the POST body
 *
 * This function tries `client_secret_basic` first (the OAuth2 spec default
 * per RFC 6749 §2.3.1 and Hydra's default), then falls back to
 * `client_secret_post` if the server responds with `invalid_client`.
 */
async function tokenRequest(
  params: URLSearchParams,
  config: OAuthConfig,
  context: string,
): Promise<TokenResponse> {
  // 1. Try client_secret_basic (RFC 6749 recommended, Hydra default)
  const basicResponse = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(config.clientId, config.clientSecret),
    },
    body: params.toString(),
  });

  if (basicResponse.ok) {
    return (await basicResponse.json()) as TokenResponse;
  }

  const basicError = (await basicResponse.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  // 2. If invalid_client, the app may require client_secret_post instead
  if (basicError.error === "invalid_client") {
    const postParams = new URLSearchParams(params);
    postParams.set("client_id", config.clientId);
    postParams.set("client_secret", config.clientSecret);

    const postResponse = await fetch(WHOOP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: postParams.toString(),
    });

    if (postResponse.ok) {
      return (await postResponse.json()) as TokenResponse;
    }

    const postError = (await postResponse.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    throw new Error(formatTokenError(context, postResponse.status, postError));
  }

  throw new Error(formatTokenError(context, basicResponse.status, basicError));
}

// ---------------------------------------------------------------------------
// exchangeCodeForTokens
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for tokens.
 *
 * POSTs to the WHOOP token endpoint with `application/x-www-form-urlencoded`
 * body per OAuth2 spec. Automatically handles both `client_secret_basic` and
 * `client_secret_post` authentication methods.
 */
export async function exchangeCodeForTokens(
  code: string,
  config: OAuthConfig,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri ?? WHOOP_REDIRECT_URI,
  });

  return tokenRequest(body, config, "Token exchange");
}

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------

/**
 * Use the refresh token to obtain a new access token.
 *
 * POSTs to the WHOOP token endpoint with `grant_type=refresh_token`.
 * Automatically handles both `client_secret_basic` and `client_secret_post`
 * authentication methods.
 */
export async function refreshAccessToken(
  refreshToken: string,
  config: OAuthConfig,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  return tokenRequest(body, config, "Token refresh");
}

// ---------------------------------------------------------------------------
// toOAuthTokens
// ---------------------------------------------------------------------------

/**
 * Convert the raw TokenResponse into our OAuthTokens shape for storage.
 *
 * Computes `expires_at` (absolute epoch ms) from `expires_in` (relative seconds).
 */
export function toOAuthTokens(response: TokenResponse): OAuthTokens {
  return {
    access_token: response.access_token,
    refresh_token: response.refresh_token,
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
 * Best-effort — if the open command fails, the URL is logged to stderr
 * so the user can copy/paste it manually. Never throws.
 */
export function openBrowser(url: string): void {
  try {
    const commands: Record<string, [string, string[]]> = {
      darwin: ["open", [url]],
      win32: ["cmd", ["/c", "start", url]],
      linux: ["xdg-open", [url]],
    };

    const [cmd, args] = commands[process.platform] ?? ["xdg-open", [url]];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Best-effort — log the URL for manual copy/paste
    console.error(
      `\nCould not open browser automatically. Please open this URL manually:\n${url}\n`,
    );
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
    throw new Error(
      "Missing WHOOP_CLIENT_ID. Set it in your environment variables.",
    );
  }
  if (!config.clientSecret) {
    throw new Error(
      "Missing WHOOP_CLIENT_SECRET. Set it in your environment variables.",
    );
  }

  // 1. Check for existing tokens
  const existing = await loadTokens(config.tokenDir);

  if (existing) {
    // 2a. If valid, return immediately
    if (!isTokenExpired(existing)) {
      return existing.access_token;
    }

    // 2b. If expired, try to refresh
    try {
      const refreshed = await refreshAccessToken(
        existing.refresh_token,
        config,
      );
      const tokens = toOAuthTokens(refreshed);
      await saveTokens(tokens, config.tokenDir);
      return tokens.access_token;
    } catch (error: unknown) {
      // Log the refresh failure so it's diagnosable, then fall through to full OAuth flow
      console.error("Token refresh failed, starting full OAuth flow:", error);
    }
  }

  // 3. Full OAuth flow
  return performOAuthFlow(config);
}

/**
 * Run the full OAuth Authorization Code flow:
 * start callback server → open browser → wait for code → exchange → save.
 */
async function performOAuthFlow(config: OAuthConfig): Promise<string> {
  const state = randomBytes(16).toString("hex");
  const port = config.port ?? 3000;

  // Start the callback server before opening the browser
  const callbackHandle = startCallbackServer({
    port,
    expectedState: state,
  });

  // Build the authorization URL and open the browser
  const authUrl = buildAuthorizationUrl(config, state);
  openBrowser(authUrl);

  console.error(
    `\nWaiting for WHOOP authorization...\nIf the browser didn't open, visit:\n${authUrl}\n`,
  );

  // Wait for the callback
  const { code } = await callbackHandle.result;

  // Exchange the code for tokens
  const tokenResponse = await exchangeCodeForTokens(code, config);
  const tokens = toOAuthTokens(tokenResponse);
  await saveTokens(tokens, config.tokenDir);

  return tokens.access_token;
}
