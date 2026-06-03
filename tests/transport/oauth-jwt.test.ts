/**
 * Tests for JWT signing/verification (Task 13c — Slice B).
 */

import { describe, it, expect } from "vitest";
import {
  signToken,
  verifyToken,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "../../src/transport/oauth-jwt.js";
import { deriveJwtSecret } from "../../src/transport/oauth-helpers.js";

const SECRET_INPUT = "test-bearer-token-12345";

async function makeSecret(): Promise<Uint8Array> {
  return deriveJwtSecret(SECRET_INPUT);
}

describe("signToken / verifyToken", () => {
  it("signs and verifies an access token", async () => {
    const secret = await makeSecret();
    const token = await signToken(
      {
        clientId: "client-abc",
        scopes: ["read:profile", "read:recovery"],
        ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
        type: "access",
      },
      secret
    );

    const result = await verifyToken(token, secret);
    expect(result.type).toBe("access");
    expect(result.clientId).toBe("client-abc");
    expect(result.scopes).toEqual(["read:profile", "read:recovery"]);
  });

  it("signs and verifies a refresh token", async () => {
    const secret = await makeSecret();
    const token = await signToken(
      {
        clientId: "client-abc",
        scopes: ["read:all"],
        ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
        type: "refresh",
      },
      secret
    );

    const result = await verifyToken(token, secret);
    expect(result.type).toBe("refresh");
    expect(result.clientId).toBe("client-abc");
  });

  it("includes resource claim when provided", async () => {
    const secret = await makeSecret();
    const token = await signToken(
      {
        clientId: "client-abc",
        scopes: [],
        resource: "https://api.example.com",
        ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
        type: "access",
      },
      secret
    );

    const result = await verifyToken(token, secret);
    expect(result.resource).toBe("https://api.example.com");
  });

  it("rejects token signed with different secret", async () => {
    const secret1 = await deriveJwtSecret("token-a");
    const secret2 = await deriveJwtSecret("token-b");

    const token = await signToken(
      {
        clientId: "client-abc",
        scopes: [],
        ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
        type: "access",
      },
      secret1
    );

    await expect(verifyToken(token, secret2)).rejects.toThrow();
  });

  it("rejects expired token", async () => {
    const secret = await makeSecret();
    // Sign with ttl = -1 second (already expired)
    const token = await signToken(
      {
        clientId: "client-abc",
        scopes: [],
        ttlSeconds: -1,
        type: "access",
      },
      secret
    );

    await expect(verifyToken(token, secret)).rejects.toThrow();
  });

  it("rejects malformed token", async () => {
    const secret = await makeSecret();
    await expect(verifyToken("not-a-jwt", secret)).rejects.toThrow();
    await expect(verifyToken("", secret)).rejects.toThrow();
  });

  it("rejects token with wrong issuer", async () => {
    const secret = await makeSecret();
    // Sign manually with a different issuer using jose directly
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ typ: "access", sub: "x", scope: "" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("other-issuer")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret);

    await expect(verifyToken(token, secret)).rejects.toThrow();
  });

  it("token expiresAt is in the future for valid token", async () => {
    const secret = await makeSecret();
    const token = await signToken(
      {
        clientId: "client-abc",
        scopes: [],
        ttlSeconds: 3600,
        type: "access",
      },
      secret
    );

    const result = await verifyToken(token, secret);
    const now = Math.floor(Date.now() / 1000);
    expect(result.expiresAt).toBeGreaterThan(now);
    expect(result.expiresAt).toBeLessThanOrEqual(now + 3601);
  });

  it("empty scopes array yields empty scopes on verify", async () => {
    const secret = await makeSecret();
    const token = await signToken(
      {
        clientId: "client-abc",
        scopes: [],
        ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
        type: "access",
      },
      secret
    );

    const result = await verifyToken(token, secret);
    expect(result.scopes).toEqual([]);
  });

  it("multiple scopes are space-separated and round-trip correctly", async () => {
    const secret = await makeSecret();
    const scopes = ["read:profile", "read:sleep", "read:recovery"];
    const token = await signToken(
      {
        clientId: "client-abc",
        scopes,
        ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
        type: "access",
      },
      secret
    );

    const result = await verifyToken(token, secret);
    expect(result.scopes).toEqual(scopes);
  });
});
