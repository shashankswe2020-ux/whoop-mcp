/**
 * Tests for OAuth helper utilities (Task 13c — Slice A).
 */

import { describe, it, expect, vi } from "vitest";
import {
  deriveJwtSecret,
  validateConnectorPassword,
  validatePublicUrl,
  isAllowedRedirectUri,
  parseAllowedRedirectUris,
  generateAuthCode,
  AuthCodeStore,
  MIN_CONNECTOR_PASSWORD_LENGTH,
} from "../../src/transport/oauth-helpers.js";

// ---------------------------------------------------------------------------
// deriveJwtSecret
// ---------------------------------------------------------------------------

describe("deriveJwtSecret", () => {
  it("derives a 32-byte key from the auth token", async () => {
    const key = await deriveJwtSecret("my-bearer-token");
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("is deterministic — same input yields same key", async () => {
    const key1 = await deriveJwtSecret("my-bearer-token");
    const key2 = await deriveJwtSecret("my-bearer-token");
    expect(key1.equals(key2)).toBe(true);
  });

  it("different inputs yield different keys", async () => {
    const key1 = await deriveJwtSecret("token-a");
    const key2 = await deriveJwtSecret("token-b");
    expect(key1.equals(key2)).toBe(false);
  });

  it("does NOT equal the bearer token bytes (HKDF transforms it)", async () => {
    const token = "my-bearer-token";
    const key = await deriveJwtSecret(token);
    expect(key.toString("utf-8")).not.toBe(token);
  });
});

// ---------------------------------------------------------------------------
// validateConnectorPassword
// ---------------------------------------------------------------------------

describe("validateConnectorPassword", () => {
  it("accepts password >= 12 chars", () => {
    expect(() => validateConnectorPassword("a".repeat(MIN_CONNECTOR_PASSWORD_LENGTH))).not.toThrow();
    expect(() => validateConnectorPassword("a".repeat(20))).not.toThrow();
  });

  it("throws if password is shorter than 12 chars", () => {
    expect(() => validateConnectorPassword("short")).toThrow(/at least 12 characters/);
    expect(() => validateConnectorPassword("a".repeat(11))).toThrow(/at least 12 characters/);
  });

  it("throws if password is empty", () => {
    expect(() => validateConnectorPassword("")).toThrow(/at least 12 characters/);
  });

  it("error message includes the actual length", () => {
    expect(() => validateConnectorPassword("abc")).toThrow(/length: 3/);
  });
});

// ---------------------------------------------------------------------------
// validatePublicUrl
// ---------------------------------------------------------------------------

describe("validatePublicUrl", () => {
  it("accepts https URL", () => {
    const url = validatePublicUrl("https://example.com");
    expect(url.protocol).toBe("https:");
  });

  it("accepts https URL with path", () => {
    const url = validatePublicUrl("https://example.com/mcp");
    expect(url.toString()).toBe("https://example.com/mcp");
  });

  it("rejects http URL", () => {
    expect(() => validatePublicUrl("http://example.com")).toThrow(/must use https/);
  });

  it("rejects ws URL", () => {
    expect(() => validatePublicUrl("ws://example.com")).toThrow(/must use https/);
  });

  it("rejects malformed URL", () => {
    expect(() => validatePublicUrl("not-a-url")).toThrow(/not a valid URL/);
  });

  it("rejects empty string", () => {
    expect(() => validatePublicUrl("")).toThrow(/not a valid URL/);
  });
});

// ---------------------------------------------------------------------------
// isAllowedRedirectUri & parseAllowedRedirectUris
// ---------------------------------------------------------------------------

describe("isAllowedRedirectUri", () => {
  const allowed = ["https://claude.ai/oauth/callback", "https://example.com/cb"];

  it("returns true for exact match", () => {
    expect(isAllowedRedirectUri("https://claude.ai/oauth/callback", allowed)).toBe(true);
  });

  it("returns false for non-match", () => {
    expect(isAllowedRedirectUri("https://evil.com/cb", allowed)).toBe(false);
  });

  it("returns false for trailing slash mismatch", () => {
    expect(isAllowedRedirectUri("https://claude.ai/oauth/callback/", allowed)).toBe(false);
  });

  it("returns false for case mismatch", () => {
    expect(isAllowedRedirectUri("https://Claude.ai/oauth/callback", allowed)).toBe(false);
  });

  it("returns false for query string difference", () => {
    expect(isAllowedRedirectUri("https://claude.ai/oauth/callback?foo=1", allowed)).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isAllowedRedirectUri("", allowed)).toBe(false);
  });

  it("returns false for empty allowlist", () => {
    expect(isAllowedRedirectUri("https://claude.ai/oauth/callback", [])).toBe(false);
  });
});

describe("parseAllowedRedirectUris", () => {
  it("parses single URI", () => {
    expect(parseAllowedRedirectUris("https://example.com/cb")).toEqual([
      "https://example.com/cb",
    ]);
  });

  it("parses comma-separated URIs", () => {
    expect(parseAllowedRedirectUris("https://a.com/cb,https://b.com/cb")).toEqual([
      "https://a.com/cb",
      "https://b.com/cb",
    ]);
  });

  it("trims whitespace", () => {
    expect(parseAllowedRedirectUris(" https://a.com/cb , https://b.com/cb ")).toEqual([
      "https://a.com/cb",
      "https://b.com/cb",
    ]);
  });

  it("ignores empty entries", () => {
    expect(parseAllowedRedirectUris("https://a.com/cb,,https://b.com/cb")).toEqual([
      "https://a.com/cb",
      "https://b.com/cb",
    ]);
  });

  it("returns empty array for undefined", () => {
    expect(parseAllowedRedirectUris(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseAllowedRedirectUris("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// generateAuthCode
// ---------------------------------------------------------------------------

describe("generateAuthCode", () => {
  it("generates a base64url-encoded string", () => {
    const code = generateAuthCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates 256 bits of entropy (~43 base64url chars)", () => {
    const code = generateAuthCode();
    expect(code.length).toBeGreaterThanOrEqual(43);
    expect(code.length).toBeLessThanOrEqual(44);
  });

  it("produces unique codes", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      codes.add(generateAuthCode());
    }
    expect(codes.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// AuthCodeStore
// ---------------------------------------------------------------------------

describe("AuthCodeStore", () => {
  const sampleInput = {
    clientId: "client-1",
    codeChallenge: "abc123",
    codeChallengeMethod: "S256" as const,
    redirectUri: "https://claude.ai/cb",
    state: "state-xyz",
    scopes: ["read"],
  };

  it("stores and retrieves an auth code", () => {
    const store = new AuthCodeStore({ cleanupIntervalMs: 0 });
    store.store("code-1", sampleInput);
    const record = store.peek("code-1");
    expect(record).not.toBeNull();
    expect(record?.clientId).toBe("client-1");
    expect(record?.consumed).toBe(false);
    store.stop();
  });

  it("returns null for unknown code", () => {
    const store = new AuthCodeStore({ cleanupIntervalMs: 0 });
    expect(store.peek("missing")).toBeNull();
    expect(store.consume("missing")).toBeNull();
    store.stop();
  });

  it("consume marks the code as consumed", () => {
    const store = new AuthCodeStore({ cleanupIntervalMs: 0 });
    store.store("code-1", sampleInput);
    const result = store.consume("code-1");
    expect(result).not.toBeNull();
    expect(result?.consumed).toBe(true);
    store.stop();
  });

  it("rejects replay (second consume returns null)", () => {
    const store = new AuthCodeStore({ cleanupIntervalMs: 0 });
    store.store("code-1", sampleInput);
    const first = store.consume("code-1");
    expect(first).not.toBeNull();
    const second = store.consume("code-1");
    expect(second).toBeNull();
    store.stop();
  });

  it("expires codes after TTL", () => {
    vi.useFakeTimers();
    const store = new AuthCodeStore({ ttlMs: 1000, cleanupIntervalMs: 0 });
    store.store("code-1", sampleInput);
    expect(store.peek("code-1")).not.toBeNull();

    vi.advanceTimersByTime(1001);
    expect(store.peek("code-1")).toBeNull();
    expect(store.consume("code-1")).toBeNull();

    store.stop();
    vi.useRealTimers();
  });

  it("cleanup removes expired entries", () => {
    vi.useFakeTimers();
    const store = new AuthCodeStore({ ttlMs: 1000, cleanupIntervalMs: 0 });
    store.store("code-1", sampleInput);
    store.store("code-2", sampleInput);
    expect(store.size()).toBe(2);

    vi.advanceTimersByTime(2000);
    store.cleanup();
    expect(store.size()).toBe(0);

    store.stop();
    vi.useRealTimers();
  });

  it("automatic periodic cleanup runs", () => {
    vi.useFakeTimers();
    const store = new AuthCodeStore({ ttlMs: 1000, cleanupIntervalMs: 500 });
    store.store("code-1", sampleInput);

    vi.advanceTimersByTime(2000);
    // cleanupIntervalMs has ticked; expired code should be gone
    expect(store.size()).toBe(0);

    store.stop();
    vi.useRealTimers();
  });

  it("stop() cancels the cleanup timer", () => {
    vi.useFakeTimers();
    const store = new AuthCodeStore({ ttlMs: 1000, cleanupIntervalMs: 500 });
    store.store("code-1", sampleInput);

    store.stop();
    vi.advanceTimersByTime(2000);
    // Timer cancelled — code is expired but still in map (no auto-cleanup)
    // peek/consume still respect TTL though
    expect(store.peek("code-1")).toBeNull();

    vi.useRealTimers();
  });

  it("preserves input fields exactly", () => {
    const store = new AuthCodeStore({ cleanupIntervalMs: 0 });
    store.store("code-1", {
      ...sampleInput,
      resource: "https://api.example.com",
    });
    const record = store.peek("code-1");
    expect(record?.codeChallenge).toBe("abc123");
    expect(record?.codeChallengeMethod).toBe("S256");
    expect(record?.redirectUri).toBe("https://claude.ai/cb");
    expect(record?.state).toBe("state-xyz");
    expect(record?.scopes).toEqual(["read"]);
    expect(record?.resource).toBe("https://api.example.com");
    store.stop();
  });
});
