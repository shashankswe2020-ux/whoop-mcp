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
  toOAuthTokens,
  openBrowser,
  authenticate,
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
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:9999/custom-callback");
  });

  it("includes all required scopes", () => {
    const url = new URL(buildAuthorizationUrl(TEST_CONFIG, "state-1"));
    expect(url.searchParams.get("scope")).toBe(WHOOP_REQUIRED_SCOPES);
  });

  it("includes the state parameter for CSRF protection", () => {
    const url = new URL(buildAuthorizationUrl(TEST_CONFIG, "my-csrf-state"));
    expect(url.searchParams.get("state")).toBe("my-csrf-state");
  });

  it("includes PKCE parameters when code challenge is provided", () => {
    const url = new URL(buildAuthorizationUrl(TEST_CONFIG, "state-1", "pkce-challenge"));
    expect(url.searchParams.get("code_challenge")).toBe("pkce-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
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
      })
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
    expect(body.get("code_verifier")).toBeNull();
  });

  it("includes code_verifier in the body when provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_TOKEN_RESPONSE),
    });

    await exchangeCodeForTokens("auth-code-xyz", TEST_CONFIG, "pkce-verifier");

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(options.body as string);
    expect(body.get("code_verifier")).toBe("pkce-verifier");
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

    await expect(exchangeCodeForTokens("expired-code", TEST_CONFIG)).rejects.toThrow(
      /token exchange failed.*400/i
    );
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

    await expect(exchangeCodeForTokens("used-code", TEST_CONFIG)).rejects.toThrow(
      /Code has been used already/
    );
  });

  it("falls back to 'unknown error' when error_description is not a string", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          error: "invalid_grant",
          // error_description is missing entirely
        }),
    });

    await expect(exchangeCodeForTokens("bad-code", TEST_CONFIG)).rejects.toThrow(/unknown error/);
  });

  it("falls back to 'unknown error' when error body JSON parse fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not JSON")),
    });

    await expect(exchangeCodeForTokens("server-error-code", TEST_CONFIG)).rejects.toThrow(
      /unknown error/
    );
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
      })
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

    await expect(refreshAccessToken("expired-refresh", TEST_CONFIG)).rejects.toThrow(
      /token refresh failed.*401/i
    );
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

    await expect(refreshAccessToken("revoked-token", TEST_CONFIG)).rejects.toThrow(
      /Refresh token revoked/
    );
  });

  it("falls back to 'unknown error' when error_description is not a string", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () =>
        Promise.resolve({
          error: "server_error",
          // error_description is not present
        }),
    });

    await expect(refreshAccessToken("bad-refresh", TEST_CONFIG)).rejects.toThrow(/unknown error/);
  });

  it("falls back to 'unknown error' when error body JSON parse fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not JSON")),
    });

    await expect(refreshAccessToken("error-refresh", TEST_CONFIG)).rejects.toThrow(/unknown error/);
  });
});

// ---------------------------------------------------------------------------
// toOAuthTokens
// ---------------------------------------------------------------------------

describe("toOAuthTokens", () => {
  it("computes expires_at from expires_in (seconds → epoch ms)", () => {
    const NOW = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    const result = toOAuthTokens(MOCK_TOKEN_RESPONSE);

    expect(result.expires_at).toBe(NOW + 3600 * 1000);

    vi.restoreAllMocks();
  });

  it("copies access_token, refresh_token, and token_type directly", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const result = toOAuthTokens(MOCK_TOKEN_RESPONSE);

    expect(result.access_token).toBe("access-token-123");
    expect(result.refresh_token).toBe("refresh-token-456");
    expect(result.token_type).toBe("Bearer");

    vi.restoreAllMocks();
  });

  it("returns the correct shape matching OAuthTokens", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const result = toOAuthTokens(MOCK_TOKEN_RESPONSE);

    expect(result).toEqual({
      access_token: "access-token-123",
      refresh_token: "refresh-token-456",
      expires_at: 1_700_000_000_000 + 3600 * 1000,
      token_type: "Bearer",
    });

    vi.restoreAllMocks();
  });

  it("falls back to existingRefreshToken when response has no refresh_token", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const responseWithoutRefresh = {
      ...MOCK_TOKEN_RESPONSE,
      refresh_token: "",
    };
    const result = toOAuthTokens(responseWithoutRefresh, "existing-refresh");

    expect(result.refresh_token).toBe("existing-refresh");

    vi.restoreAllMocks();
  });

  it("prefers response refresh_token over existingRefreshToken when both present", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const result = toOAuthTokens(MOCK_TOKEN_RESPONSE, "old-refresh");

    expect(result.refresh_token).toBe("refresh-token-456");

    vi.restoreAllMocks();
  });

  it("uses empty string when neither response nor existing has a refresh_token", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const responseWithoutRefresh = {
      ...MOCK_TOKEN_RESPONSE,
      refresh_token: "",
    };
    const result = toOAuthTokens(responseWithoutRefresh);

    expect(result.refresh_token).toBe("");

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// openBrowser
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
  })),
}));

describe("openBrowser", () => {
  let mockSpawn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import("node:child_process");
    mockSpawn = cp.spawn as unknown as ReturnType<typeof vi.fn>;
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue({ unref: vi.fn() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls spawn with 'open' and url argument on macOS", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });

    openBrowser("https://example.com/auth");

    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledWith(
      "open",
      ["https://example.com/auth"],
      expect.objectContaining({ detached: true, stdio: "ignore" })
    );

    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("calls spawn with 'xdg-open' on Linux", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });

    openBrowser("https://example.com/auth");

    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledWith(
      "xdg-open",
      ["https://example.com/auth"],
      expect.objectContaining({ detached: true, stdio: "ignore" })
    );

    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("calls spawn with 'cmd' on Windows", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });

    openBrowser("https://example.com/auth");

    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledWith(
      "cmd",
      ["/c", "start", "https://example.com/auth"],
      expect.objectContaining({ detached: true, stdio: "ignore" })
    );

    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("does not throw if spawn fails", () => {
    mockSpawn.mockImplementation(() => {
      throw new Error("Command not found");
    });

    // Should not throw
    expect(() => openBrowser("https://example.com/auth")).not.toThrow();
  });

  it("does not use shell interpolation (no injection risk)", () => {
    const maliciousUrl = 'https://example.com"; rm -rf / #';
    openBrowser(maliciousUrl);

    expect(mockSpawn).toHaveBeenCalledOnce();
    // URL is passed as a separate argument, not interpolated into a shell string
    const args = mockSpawn.mock.calls[0] as unknown[];
    expect(args[1]).toContain(maliciousUrl);
  });
});

// ---------------------------------------------------------------------------
// authenticate
// ---------------------------------------------------------------------------

vi.mock("../../src/auth/token-store.js", () => ({
  loadTokens: vi.fn(),
  saveTokens: vi.fn(),
  isTokenExpired: vi.fn(),
}));

vi.mock("../../src/auth/callback-server.js", () => ({
  startCallbackServer: vi.fn(),
}));

import { loadTokens, saveTokens, isTokenExpired } from "../../src/auth/token-store.js";
import { startCallbackServer } from "../../src/auth/callback-server.js";
import type { OAuthTokens } from "../../src/auth/token-store.js";

const mockLoadTokens = loadTokens as ReturnType<typeof vi.fn>;
const mockSaveTokens = saveTokens as ReturnType<typeof vi.fn>;
const mockIsTokenExpired = isTokenExpired as ReturnType<typeof vi.fn>;
const mockStartCallbackServer = startCallbackServer as ReturnType<typeof vi.fn>;

const VALID_TOKENS: OAuthTokens = {
  access_token: "existing-access-token",
  refresh_token: "existing-refresh-token",
  expires_at: Date.now() + 3_600_000,
  token_type: "Bearer",
};

describe("authenticate", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockSpawn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const cp = await import("node:child_process");
    mockSpawn = cp.spawn as unknown as ReturnType<typeof vi.fn>;
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue({ unref: vi.fn() });
    mockLoadTokens.mockReset();
    mockSaveTokens.mockReset();
    mockIsTokenExpired.mockReset();
    mockStartCallbackServer.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns existing access_token if tokens are valid (not expired)", async () => {
    mockLoadTokens.mockResolvedValueOnce(VALID_TOKENS);
    mockIsTokenExpired.mockReturnValueOnce(false);

    const token = await authenticate(TEST_CONFIG);

    expect(token).toBe("existing-access-token");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockStartCallbackServer).not.toHaveBeenCalled();
  });

  it("refreshes and returns new access_token if tokens are expired", async () => {
    const expiredTokens: OAuthTokens = {
      ...VALID_TOKENS,
      expires_at: Date.now() - 1000,
    };
    mockLoadTokens.mockResolvedValueOnce(expiredTokens);
    mockIsTokenExpired.mockReturnValueOnce(true);
    mockSaveTokens.mockResolvedValueOnce(undefined);

    // Mock the refresh fetch call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_TOKEN_RESPONSE),
    });

    const token = await authenticate(TEST_CONFIG);

    expect(token).toBe("access-token-123");
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockSaveTokens).toHaveBeenCalledOnce();
    expect(mockStartCallbackServer).not.toHaveBeenCalled();
  });

  it("runs full OAuth flow when no tokens exist", async () => {
    mockLoadTokens.mockResolvedValueOnce(null);
    mockSaveTokens.mockResolvedValueOnce(undefined);

    // Mock callback server
    mockStartCallbackServer.mockReturnValueOnce({
      port: 3000,
      result: Promise.resolve({
        code: "new-auth-code",
        state: "mock-state", // Will be ignored — authenticate generates its own
      }),
    });

    // Mock token exchange fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_TOKEN_RESPONSE),
    });

    const token = await authenticate(TEST_CONFIG);

    expect(token).toBe("access-token-123");
    expect(mockStartCallbackServer).toHaveBeenCalledOnce();
    expect(mockSaveTokens).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledOnce();

    const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
    const authUrlArg = spawnArgs.find((arg) => arg.startsWith("http"));
    expect(authUrlArg).toBeTruthy();
    const authUrl = new URL(authUrlArg as string);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(options.body as string);
    expect(body.get("code_verifier")).toBeTruthy();
  });

  it("falls back to full OAuth flow when refresh fails", async () => {
    const expiredTokens: OAuthTokens = {
      ...VALID_TOKENS,
      expires_at: Date.now() - 1000,
    };
    mockLoadTokens.mockResolvedValueOnce(expiredTokens);
    mockIsTokenExpired.mockReturnValueOnce(true);
    mockSaveTokens.mockResolvedValueOnce(undefined);

    // Mock the refresh fetch — fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () =>
        Promise.resolve({
          error: "invalid_grant",
          error_description: "Refresh token expired",
        }),
    });

    // Mock callback server for fallback flow
    mockStartCallbackServer.mockReturnValueOnce({
      port: 3000,
      result: Promise.resolve({
        code: "fallback-auth-code",
        state: "mock-state",
      }),
    });

    // Mock token exchange fetch — succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_TOKEN_RESPONSE),
    });

    const token = await authenticate(TEST_CONFIG);

    expect(token).toBe("access-token-123");
    expect(mockStartCallbackServer).toHaveBeenCalledOnce();
    // fetch called twice: once for failed refresh, once for successful exchange
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws a clear error if clientId is missing", async () => {
    const badConfig = { ...TEST_CONFIG, clientId: "" };
    await expect(authenticate(badConfig)).rejects.toThrow(/WHOOP_CLIENT_ID|client.*id/i);
  });

  it("throws a clear error if clientSecret is missing", async () => {
    const badConfig = { ...TEST_CONFIG, clientSecret: "" };
    await expect(authenticate(badConfig)).rejects.toThrow(/WHOOP_CLIENT_SECRET|client.*secret/i);
  });
});
