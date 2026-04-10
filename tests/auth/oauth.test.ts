/**
 * Tests for the OAuth2 flow module.
 *
 * Mocks: fetch (token exchange), child_process (browser open),
 * callback-server, and token-store as needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  type OAuthConfig,
  type TokenResponse,
} from "../../src/auth/oauth.js";
import {
  WHOOP_AUTH_URL,
  WHOOP_REDIRECT_URI,
  WHOOP_REQUIRED_SCOPES,
  WHOOP_TOKEN_URL,
} from "../../src/api/endpoints.js";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TEST_CONFIG: OAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
};

// ---------------------------------------------------------------------------
// buildAuthorizationUrl
// ---------------------------------------------------------------------------

describe("buildAuthorizationUrl", () => {
  it("uses WHOOP_AUTH_URL as the base", () => {
    const url = new URL(buildAuthorizationUrl(TEST_CONFIG, "state-1"));
    expect(`${url.origin}${url.pathname}`).toBe(WHOOP_AUTH_URL);
  });

  it("includes response_type=code", () => {
    const url = new URL(buildAuthorizationUrl(TEST_CONFIG, "state-1"));
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("includes client_id from config", () => {
    const url = new URL(buildAuthorizationUrl(TEST_CONFIG, "state-1"));
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
  });

  it("includes the default redirect_uri when not overridden", () => {
    const url = new URL(buildAuthorizationUrl(TEST_CONFIG, "state-1"));
    expect(url.searchParams.get("redirect_uri")).toBe(WHOOP_REDIRECT_URI);
  });

  it("uses a custom redirect_uri when provided in config", () => {
    const config: OAuthConfig = {
      ...TEST_CONFIG,
      redirectUri: "http://localhost:9999/custom-callback",
    };
    const url = new URL(buildAuthorizationUrl(config, "state-1"));
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:9999/custom-callback",
    );
  });

  it("includes all required scopes", () => {
    const url = new URL(buildAuthorizationUrl(TEST_CONFIG, "state-1"));
    expect(url.searchParams.get("scope")).toBe(WHOOP_REQUIRED_SCOPES);
  });

  it("includes the state parameter for CSRF protection", () => {
    const url = new URL(buildAuthorizationUrl(TEST_CONFIG, "my-csrf-state"));
    expect(url.searchParams.get("state")).toBe("my-csrf-state");
  });

  it("produces a properly encoded URL", () => {
    const urlString = buildAuthorizationUrl(TEST_CONFIG, "state with spaces");
    // Should not throw when parsed
    const url = new URL(urlString);
    expect(url.searchParams.get("state")).toBe("state with spaces");
  });
});

// ---------------------------------------------------------------------------
// exchangeCodeForTokens
// ---------------------------------------------------------------------------

const MOCK_TOKEN_RESPONSE: TokenResponse = {
  access_token: "access-token-123",
  refresh_token: "refresh-token-456",
  expires_in: 3600,
  token_type: "Bearer",
  scope: WHOOP_REQUIRED_SCOPES,
};

describe("exchangeCodeForTokens", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to WHOOP_TOKEN_URL with application/x-www-form-urlencoded", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_TOKEN_RESPONSE),
    });

    await exchangeCodeForTokens("auth-code", TEST_CONFIG);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WHOOP_TOKEN_URL);
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/x-www-form-urlencoded",
      }),
    );
  });

  it("includes grant_type, code, client_id, client_secret, and redirect_uri in the body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_TOKEN_RESPONSE),
    });

    await exchangeCodeForTokens("auth-code-xyz", TEST_CONFIG);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(options.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-xyz");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("redirect_uri")).toBe(WHOOP_REDIRECT_URI);
  });

  it("uses custom redirect_uri from config", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_TOKEN_RESPONSE),
    });

    const config: OAuthConfig = {
      ...TEST_CONFIG,
      redirectUri: "http://localhost:9999/custom",
    };
    await exchangeCodeForTokens("code", config);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(options.body as string);
    expect(body.get("redirect_uri")).toBe("http://localhost:9999/custom");
  });

  it("returns the parsed TokenResponse on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_TOKEN_RESPONSE),
    });

    const result = await exchangeCodeForTokens("code", TEST_CONFIG);
    expect(result).toEqual(MOCK_TOKEN_RESPONSE);
  });

  it("throws a descriptive error on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          error: "invalid_grant",
          error_description: "Authorization code expired",
        }),
    });

    await expect(
      exchangeCodeForTokens("expired-code", TEST_CONFIG),
    ).rejects.toThrow(/token exchange failed.*400/i);
  });

  it("includes error_description in the thrown error when available", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          error: "invalid_grant",
          error_description: "Code has been used already",
        }),
    });

    await expect(
      exchangeCodeForTokens("used-code", TEST_CONFIG),
    ).rejects.toThrow(/Code has been used already/);
  });
});

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------

describe("refreshAccessToken", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to WHOOP_TOKEN_URL with grant_type=refresh_token", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_TOKEN_RESPONSE),
    });

    await refreshAccessToken("refresh-token-abc", TEST_CONFIG);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WHOOP_TOKEN_URL);
    expect(options.method).toBe("POST");

    const body = new URLSearchParams(options.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-token-abc");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
  });

  it("uses application/x-www-form-urlencoded content type", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_TOKEN_RESPONSE),
    });

    await refreshAccessToken("refresh-token", TEST_CONFIG);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(options.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/x-www-form-urlencoded",
      }),
    );
  });

  it("returns the parsed TokenResponse on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_TOKEN_RESPONSE),
    });

    const result = await refreshAccessToken("refresh-token", TEST_CONFIG);
    expect(result).toEqual(MOCK_TOKEN_RESPONSE);
  });

  it("throws a descriptive error on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () =>
        Promise.resolve({
          error: "invalid_grant",
          error_description: "Refresh token has expired",
        }),
    });

    await expect(
      refreshAccessToken("expired-refresh", TEST_CONFIG),
    ).rejects.toThrow(/token refresh failed.*401/i);
  });

  it("includes error_description in the thrown error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () =>
        Promise.resolve({
          error: "invalid_grant",
          error_description: "Refresh token revoked",
        }),
    });

    await expect(
      refreshAccessToken("revoked-token", TEST_CONFIG),
    ).rejects.toThrow(/Refresh token revoked/);
  });
});
