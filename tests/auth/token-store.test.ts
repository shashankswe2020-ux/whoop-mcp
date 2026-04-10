import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OAuthTokens } from "../../src/auth/token-store.js";
import { isTokenExpired } from "../../src/auth/token-store.js";

// ---------------------------------------------------------------------------
// Task 3a: Token types + expiry check
// ---------------------------------------------------------------------------

describe("OAuthTokens", () => {
  it("accepts a valid token object", () => {
    const tokens: OAuthTokens = {
      access_token: "abc123",
      refresh_token: "def456",
      expires_at: Date.now() + 3600 * 1000,
      token_type: "Bearer",
    };

    expect(tokens.access_token).toBe("abc123");
    expect(tokens.refresh_token).toBe("def456");
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_at).toBeGreaterThan(Date.now());
  });
});

describe("isTokenExpired", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const NOW = new Date("2026-04-10T12:00:00.000Z").getTime();
  const BUFFER_MS = 60_000; // 60 seconds

  it("returns true when token is already expired", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW - 1000, // expired 1s ago
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(true);
  });

  it("returns true when token expires within the 60s buffer", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW + 30_000, // expires in 30s (within 60s buffer)
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(true);
  });

  it("returns true when token expires exactly at the buffer boundary", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW + BUFFER_MS, // expires exactly at buffer
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(true);
  });

  it("returns false when token expires well beyond the buffer", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW + 3600_000, // expires in 1 hour
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(false);
  });

  it("returns false when token expires 1ms beyond the buffer", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW + BUFFER_MS + 1, // just past the buffer
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(false);
  });
});
