/**
 * OAuth2 Authorization Code flow for the WHOOP API.
 *
 * Orchestrates: build auth URL → open browser → wait for callback code
 * → exchange code for tokens → save to token store. Also handles token refresh.
 */

import type { OAuthTokens } from "./token-store.js";
import {
  WHOOP_AUTH_URL,
  WHOOP_TOKEN_URL,
  WHOOP_REDIRECT_URI,
  WHOOP_REQUIRED_SCOPES,
} from "../api/endpoints.js";
import { exec } from "node:child_process";

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
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri ?? WHOOP_REDIRECT_URI,
  });

  const response = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const description =
      typeof errorBody.error_description === "string"
        ? errorBody.error_description
        : "unknown error";
    throw new Error(
      `Token exchange failed (${response.status}): ${description}`,
    );
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
  config: OAuthConfig,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const response = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const description =
      typeof errorBody.error_description === "string"
        ? errorBody.error_description
        : "unknown error";
    throw new Error(
      `Token refresh failed (${response.status}): ${description}`,
    );
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
 * Best-effort — if the open command fails, the URL is logged to stderr
 * so the user can copy/paste it manually. Never throws.
 */
export function openBrowser(url: string): void {
  try {
    const command =
      process.platform === "darwin"
        ? `open "${url}"`
        : process.platform === "win32"
          ? `start "${url}"`
          : `xdg-open "${url}"`;

    exec(command);
  } catch {
    // Best-effort — log the URL for manual copy/paste
    console.error(
      `\nCould not open browser automatically. Please open this URL manually:\n${url}\n`,
    );
  }
}
