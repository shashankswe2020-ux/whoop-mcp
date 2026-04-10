/**
 * OAuth2 Authorization Code flow for the WHOOP API.
 *
 * Orchestrates: build auth URL → open browser → wait for callback code
 * → exchange code for tokens → save to token store. Also handles token refresh.
 */

import {
  WHOOP_AUTH_URL,
  WHOOP_TOKEN_URL,
  WHOOP_REDIRECT_URI,
  WHOOP_REQUIRED_SCOPES,
} from "../api/endpoints.js";

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
