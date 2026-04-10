import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stat, rm, readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthTokens } from "../../src/auth/token-store.js";
import { isTokenExpired, saveTokens } from "../../src/auth/token-store.js";

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

// ---------------------------------------------------------------------------
// Task 3b: Save tokens to disk
// ---------------------------------------------------------------------------

describe("saveTokens", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "whoop-mcp-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  const sampleTokens: OAuthTokens = {
    access_token: "access_abc",
    refresh_token: "refresh_xyz",
    expires_at: Date.now() + 3600_000,
    token_type: "Bearer",
  };

  it("writes valid JSON to the token file", async () => {
    await saveTokens(sampleTokens, tempDir);

    const raw = await readFile(join(tempDir, "tokens.json"), "utf-8");
    const parsed = JSON.parse(raw) as OAuthTokens;

    expect(parsed.access_token).toBe("access_abc");
    expect(parsed.refresh_token).toBe("refresh_xyz");
    expect(parsed.token_type).toBe("Bearer");
    expect(parsed.expires_at).toBe(sampleTokens.expires_at);
  });

  it("creates the directory if it does not exist", async () => {
    const nestedDir = join(tempDir, "nested");
    await saveTokens(sampleTokens, nestedDir);

    const dirStat = await stat(nestedDir);
    expect(dirStat.isDirectory()).toBe(true);
  });

  it("creates the directory with 0700 permissions", async () => {
    const nestedDir = join(tempDir, "nested");
    await saveTokens(sampleTokens, nestedDir);

    const dirStat = await stat(nestedDir);
    // 0o700 = owner rwx, group/other none. mode & 0o777 masks file type bits.
    const dirMode = dirStat.mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it("creates the token file with 0600 permissions", async () => {
    await saveTokens(sampleTokens, tempDir);

    const fileStat = await stat(join(tempDir, "tokens.json"));
    const fileMode = fileStat.mode & 0o777;
    expect(fileMode).toBe(0o600);
  });

  it("overwrites existing token file", async () => {
    await saveTokens(sampleTokens, tempDir);

    const updatedTokens: OAuthTokens = {
      ...sampleTokens,
      access_token: "new_access",
    };
    await saveTokens(updatedTokens, tempDir);

    const raw = await readFile(join(tempDir, "tokens.json"), "utf-8");
    const parsed = JSON.parse(raw) as OAuthTokens;
    expect(parsed.access_token).toBe("new_access");
  });
});
