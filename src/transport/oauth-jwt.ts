/**
 * JWT signing and verification for OAuth connector tokens (Task 13c — Slice B).
 *
 * Uses HS256 (HMAC-SHA256) with an HKDF-derived key from MCP_AUTH_TOKEN
 * (or MCP_JWT_SECRET if explicitly set). Access tokens last 24h, refresh
 * tokens last 30d.
 */

import { SignJWT, jwtVerify } from "jose";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24 hours
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const JWT_ALG = "HS256";
export const JWT_ISSUER = "whoop-mcp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TokenType = "access" | "refresh";

export interface TokenClaims {
  /** "access" or "refresh" */
  typ: TokenType;
  /** Subject — the OAuth client_id */
  sub: string;
  /** Granted scopes */
  scope: string;
  /** Optional resource indicator */
  resource?: string;
  /** Optional jti for token revocation tracking */
  jti?: string;
}

export interface SignTokenOptions {
  clientId: string;
  scopes: string[];
  resource?: string;
  ttlSeconds: number;
  type: TokenType;
  /** Optional jti — required for refresh-token rotation reuse detection */
  jti?: string;
}

export interface VerifyResult {
  /** "access" or "refresh" */
  type: TokenType;
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // seconds since epoch
  jti?: string;
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

/**
 * Sign a JWT with the given secret key. Returns a compact JWT string.
 */
export async function signToken(options: SignTokenOptions, secret: Uint8Array): Promise<string> {
  const { clientId, scopes, resource, ttlSeconds, type, jti } = options;
  const now = Math.floor(Date.now() / 1000);

  const payload: TokenClaims = {
    typ: type,
    sub: clientId,
    scope: scopes.join(" "),
  };
  if (resource) payload.resource = resource;
  if (jti) payload.jti = jti;

  let builder = new SignJWT({ ...payload })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuer(JWT_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds);
  if (jti) builder = builder.setJti(jti);
  return builder.sign(secret);
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify a JWT and return its claims. Throws if invalid or expired.
 */
export async function verifyToken(token: string, secret: Uint8Array): Promise<VerifyResult> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: JWT_ISSUER,
    algorithms: [JWT_ALG],
  });

  const typ = payload.typ;
  if (typ !== "access" && typ !== "refresh") {
    throw new Error("Invalid token type");
  }

  const sub = payload.sub;
  if (typeof sub !== "string" || !sub) {
    throw new Error("Token missing subject (sub)");
  }

  const scope = payload.scope;
  const scopes = typeof scope === "string" && scope.length > 0 ? scope.split(" ") : [];

  const exp = payload.exp;
  if (typeof exp !== "number") {
    throw new Error("Token missing expiration (exp)");
  }

  const result: VerifyResult = {
    type: typ,
    clientId: sub,
    scopes,
    expiresAt: exp,
  };

  if (typeof payload.resource === "string") {
    result.resource = payload.resource;
  }
  if (typeof payload.jti === "string") {
    result.jti = payload.jti;
  }

  return result;
}
