/**
 * OAuth helper utilities (Task 13c).
 *
 * Pure functions and small classes for OAuth connector logic:
 * - HKDF-derived JWT signing key
 * - Connector password validation
 * - Public URL validation (HTTPS-only)
 * - redirect_uri allowlist validation
 * - AuthCodeStore (one-time use, TTL, periodic cleanup)
 */

import { hkdf, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_CONNECTOR_PASSWORD_LENGTH = 12;
export const AUTH_CODE_TTL_MS = 60_000; // 60 seconds
export const AUTH_CODE_CLEANUP_INTERVAL_MS = 30_000; // 30 seconds
export const HKDF_SALT = "whoop-mcp-jwt-v1";
export const HKDF_INFO = "jwt-signing";
export const HKDF_KEY_LENGTH = 32;

// ---------------------------------------------------------------------------
// HKDF-derived JWT signing key
// ---------------------------------------------------------------------------

/**
 * Derive a JWT signing key from the bearer token using HKDF-SHA256.
 *
 * Never use the bearer token directly as JWT signing material — HKDF ensures
 * the JWT secret is cryptographically separate from the bearer token, even
 * though both come from the same input.
 *
 * If MCP_JWT_SECRET is explicitly set, callers should use that instead and
 * skip this derivation.
 */
export function deriveJwtSecret(authToken: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    hkdf("sha256", authToken, HKDF_SALT, HKDF_INFO, HKDF_KEY_LENGTH, (err, key) => {
      if (err) reject(err);
      else resolve(Buffer.from(key));
    });
  });
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Validate the connector password meets minimum length.
 * Throws a descriptive error if too short.
 */
export function validateConnectorPassword(password: string): void {
  if (password.length < MIN_CONNECTOR_PASSWORD_LENGTH) {
    throw new Error(
      `MCP_CONNECTOR_PASSWORD must be at least ${MIN_CONNECTOR_PASSWORD_LENGTH} characters. ` +
        `Provided length: ${password.length}.`
    );
  }
}

/**
 * Validate that the public URL is HTTPS.
 * Throws if not — HTTP origins are rejected to prevent token leakage.
 */
export function validatePublicUrl(publicUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error(`PUBLIC_URL is not a valid URL: ${publicUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `PUBLIC_URL must use https:// (got ${parsed.protocol}). ` +
        "OAuth requires HTTPS to prevent token interception."
    );
  }
  return parsed;
}

/**
 * Validate redirect_uri against the configured allowlist.
 * Performs exact string match — no normalization, no scheme/host rewriting.
 * Returns true if allowed, false otherwise.
 */
export function isAllowedRedirectUri(redirectUri: string, allowed: string[]): boolean {
  if (!redirectUri) return false;
  return allowed.includes(redirectUri);
}

/**
 * Parse the comma-separated ALLOWED_REDIRECT_URIS env var.
 * Trims whitespace; ignores empty entries.
 */
export function parseAllowedRedirectUris(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Auth code generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically secure authorization code.
 * 256 bits of entropy, base64url-encoded.
 */
export function generateAuthCode(): string {
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// AuthCodeStore — one-time use, TTL, periodic cleanup
// ---------------------------------------------------------------------------

export interface AuthCodeRecord {
  clientId: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  redirectUri: string;
  state: string;
  scopes: string[];
  expiresAt: number;
  consumed: boolean;
  resource?: string;
}

export interface AuthCodeInput {
  clientId: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  redirectUri: string;
  state: string;
  scopes: string[];
  resource?: string;
}

/**
 * In-memory store for OAuth authorization codes.
 * Codes are one-time use; consuming a code marks it consumed but does not
 * delete it (allows replay detection within the TTL window).
 */
export class AuthCodeStore {
  private codes = new Map<string, AuthCodeRecord>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly ttlMs: number;

  constructor(options: { ttlMs?: number; cleanupIntervalMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? AUTH_CODE_TTL_MS;
    const cleanupIntervalMs = options.cleanupIntervalMs ?? AUTH_CODE_CLEANUP_INTERVAL_MS;

    if (cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
      // Don't keep the process alive for cleanup
      this.cleanupTimer.unref();
    }
  }

  /**
   * Store a new authorization code.
   */
  store(code: string, input: AuthCodeInput): void {
    this.codes.set(code, {
      ...input,
      expiresAt: Date.now() + this.ttlMs,
      consumed: false,
    });
  }

  /**
   * Look up an authorization code without consuming it.
   * Returns null if missing, expired, or consumed.
   */
  peek(code: string): AuthCodeRecord | null {
    const record = this.codes.get(code);
    if (!record) return null;
    if (record.expiresAt < Date.now()) return null;
    if (record.consumed) return null;
    return record;
  }

  /**
   * Consume an authorization code. Returns the record if it was valid and
   * unconsumed; returns null otherwise. Replay attempts return null.
   */
  consume(code: string): AuthCodeRecord | null {
    const record = this.codes.get(code);
    if (!record) return null;
    if (record.expiresAt < Date.now()) return null;
    if (record.consumed) return null;
    record.consumed = true;
    return record;
  }

  /**
   * Delete entries that are well past expiry.
   * Keeps recently-consumed entries briefly (within TTL) to detect replay.
   */
  cleanup(): void {
    const cutoff = Date.now();
    for (const [code, record] of this.codes.entries()) {
      // Allow consumed entries to live until TTL expires (replay window),
      // then delete. Unconsumed expired entries delete immediately.
      if (record.expiresAt < cutoff) {
        this.codes.delete(code);
      }
    }
  }

  /**
   * Stop the cleanup timer. Call when shutting down.
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Number of codes currently stored (for tests).
   */
  size(): number {
    return this.codes.size;
  }
}

// ---------------------------------------------------------------------------
// UsedJtiStore — tracks consumed refresh-token jti values for reuse detection
// (OAuth 2.1 / RFC 6819 §5.2.2)
// ---------------------------------------------------------------------------

/** Generate a 128-bit random jti suitable for refresh-token rotation tracking. */
export function generateJti(): string {
  return randomBytes(16).toString("base64url");
}

interface UsedJtiRecord {
  /** Epoch milliseconds when the JWT exp passes */
  expiresAt: number;
}

/**
 * In-memory store of consumed refresh-token jtis. Entries are retained until
 * the underlying JWT's natural exp passes — after that, the JWT signature
 * check would fail anyway, so we can drop the record without losing
 * reuse-detection coverage.
 */
export class UsedJtiStore {
  private readonly used = new Map<string, UsedJtiRecord>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options: { cleanupIntervalMs?: number } = {}) {
    const interval = options.cleanupIntervalMs ?? AUTH_CODE_CLEANUP_INTERVAL_MS;
    if (interval > 0) {
      this.cleanupTimer = setInterval(() => this.cleanup(), interval);
      this.cleanupTimer.unref();
    }
  }

  /** True if this jti has previously been consumed and is still within TTL. */
  has(jti: string): boolean {
    const record = this.used.get(jti);
    if (!record) return false;
    if (record.expiresAt <= Date.now()) {
      this.used.delete(jti);
      return false;
    }
    return true;
  }

  /** Mark a jti as consumed; expiresAt is the JWT's exp (epoch seconds). */
  add(jti: string, expiresAtSeconds: number): void {
    this.used.set(jti, { expiresAt: expiresAtSeconds * 1000 });
  }

  cleanup(): void {
    const now = Date.now();
    for (const [jti, record] of this.used.entries()) {
      if (record.expiresAt <= now) this.used.delete(jti);
    }
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  size(): number {
    return this.used.size;
  }
}
