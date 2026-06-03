import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";

import {
  OAuthConnectorProvider,
  type ConnectorClientConfig,
} from "../../src/transport/oauth-connector.js";
import { AuthCodeStore } from "../../src/transport/oauth-helpers.js";

// Helpers
function makeProvider(
  overrides: Partial<{
    redirectUris: string[];
    allowedRedirectUris: string[];
    scopes: string[];
    authCodeStore: AuthCodeStore;
  }> = {}
): { provider: OAuthConnectorProvider; client: ConnectorClientConfig; secret: Uint8Array } {
  const client: ConnectorClientConfig = {
    clientId: "claude-ai-connector",
    redirectUris: overrides.redirectUris ?? ["https://claude.ai/api/mcp/callback"],
    clientName: "Claude AI Connector",
  };
  const secret = new Uint8Array(randomBytes(32));
  const provider = new OAuthConnectorProvider({
    client,
    allowedRedirectUris: overrides.allowedRedirectUris ?? client.redirectUris,
    jwtSecret: secret,
    scopes: overrides.scopes ?? ["read:profile", "read:recovery"],
    ...(overrides.authCodeStore && { authCodeStore: overrides.authCodeStore }),
  });
  return { provider, client, secret };
}

// Mock Express Response just enough to capture redirects
function mockRes(): { redirect: ReturnType<typeof vi.fn>; getRedirect: () => string | undefined } {
  let redirected: string | undefined;
  const redirect = vi.fn((url: string) => {
    redirected = url;
  });
  return { redirect, getRedirect: () => redirected };
}

describe("OAuthConnectorProvider", () => {
  describe("clientsStore", () => {
    it("returns the registered client by id", () => {
      const { provider, client } = makeProvider();
      const found = provider.clientsStore.getClient(client.clientId);
      expect(found).toBeDefined();
      expect(found?.client_id).toBe(client.clientId);
      expect(found?.redirect_uris).toEqual(client.redirectUris);
      expect(found?.grant_types).toContain("authorization_code");
      expect(found?.grant_types).toContain("refresh_token");
    });

    it("returns undefined for unknown client id", () => {
      const { provider } = makeProvider();
      expect(provider.clientsStore.getClient("unknown")).toBeUndefined();
    });
  });

  describe("authorize", () => {
    it("issues a code and redirects with code+state", async () => {
      const { provider, client } = makeProvider();
      const fullClient = provider.clientsStore.getClient(client.clientId)!;
      const res = mockRes();

      await provider.authorize(
        fullClient,
        {
          codeChallenge: "abc123challenge",
          redirectUri: "https://claude.ai/api/mcp/callback",
          state: "xyz-state",
          scopes: ["read:profile"],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { redirect: res.redirect } as any
      );

      const url = res.getRedirect();
      expect(url).toBeDefined();
      const parsed = new URL(url!);
      expect(parsed.origin + parsed.pathname).toBe("https://claude.ai/api/mcp/callback");
      expect(parsed.searchParams.get("code")).toBeTruthy();
      expect(parsed.searchParams.get("state")).toBe("xyz-state");
    });

    it("rejects redirect_uri not in allowlist", async () => {
      const { provider, client } = makeProvider();
      const fullClient = provider.clientsStore.getClient(client.clientId)!;
      const res = mockRes();

      await expect(
        provider.authorize(
          fullClient,
          {
            codeChallenge: "abc123",
            redirectUri: "https://evil.example.com/callback",
            state: "s",
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { redirect: res.redirect } as any
        )
      ).rejects.toThrow(/ALLOWED_REDIRECT_URIS/);
    });

    it("rejects when codeChallenge is missing", async () => {
      const { provider, client } = makeProvider();
      const fullClient = provider.clientsStore.getClient(client.clientId)!;
      const res = mockRes();

      await expect(
        provider.authorize(
          fullClient,
          {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            codeChallenge: "" as any,
            redirectUri: "https://claude.ai/api/mcp/callback",
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { redirect: res.redirect } as any
        )
      ).rejects.toThrow(/code_challenge/);
    });

    it("omits state from redirect when not provided", async () => {
      const { provider, client } = makeProvider();
      const fullClient = provider.clientsStore.getClient(client.clientId)!;
      const res = mockRes();

      await provider.authorize(
        fullClient,
        {
          codeChallenge: "abc",
          redirectUri: "https://claude.ai/api/mcp/callback",
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { redirect: res.redirect } as any
      );

      const url = new URL(res.getRedirect()!);
      expect(url.searchParams.has("state")).toBe(false);
      expect(url.searchParams.get("code")).toBeTruthy();
    });
  });

  describe("challengeForAuthorizationCode", () => {
    it("returns the codeChallenge for a valid code", async () => {
      const { provider, client } = makeProvider();
      const fullClient = provider.clientsStore.getClient(client.clientId)!;
      const res = mockRes();
      await provider.authorize(
        fullClient,
        {
          codeChallenge: "challenge-xyz",
          redirectUri: "https://claude.ai/api/mcp/callback",
          state: "s",
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { redirect: res.redirect } as any
      );
      const code = new URL(res.getRedirect()!).searchParams.get("code")!;

      const challenge = await provider.challengeForAuthorizationCode(fullClient, code);
      expect(challenge).toBe("challenge-xyz");
    });

    it("throws for unknown code", async () => {
      const { provider, client } = makeProvider();
      const fullClient = provider.clientsStore.getClient(client.clientId)!;
      await expect(
        provider.challengeForAuthorizationCode(fullClient, "no-such-code")
      ).rejects.toThrow(/Invalid or expired/);
    });
  });

  describe("exchangeAuthorizationCode", () => {
    let provider: OAuthConnectorProvider;
    let fullClient: import("@modelcontextprotocol/sdk/shared/auth.js").OAuthClientInformationFull;
    let code: string;
    const redirectUri = "https://claude.ai/api/mcp/callback";

    beforeEach(async () => {
      const made = makeProvider();
      provider = made.provider;
      fullClient = provider.clientsStore.getClient(made.client.clientId)!;
      const res = mockRes();
      await provider.authorize(
        fullClient,
        {
          codeChallenge: "challenge",
          redirectUri,
          state: "s",
          scopes: ["read:profile", "read:recovery"],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { redirect: res.redirect } as any
      );
      code = new URL(res.getRedirect()!).searchParams.get("code")!;
    });

    it("returns access + refresh tokens for a valid code", async () => {
      const tokens = await provider.exchangeAuthorizationCode(
        fullClient,
        code,
        "verifier",
        redirectUri
      );
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.refresh_token).toBeTruthy();
      expect(tokens.token_type).toBe("Bearer");
      expect(tokens.expires_in).toBeGreaterThan(0);
      expect(tokens.scope).toBe("read:profile read:recovery");
    });

    it("rejects replay of consumed code", async () => {
      await provider.exchangeAuthorizationCode(fullClient, code, "v", redirectUri);
      await expect(
        provider.exchangeAuthorizationCode(fullClient, code, "v", redirectUri)
      ).rejects.toThrow(/already-consumed|expired|Invalid/);
    });

    it("rejects mismatched redirect_uri", async () => {
      await expect(
        provider.exchangeAuthorizationCode(
          fullClient,
          code,
          "v",
          "https://attacker.example.com/callback"
        )
      ).rejects.toThrow(/redirect_uri/);
    });

    it("rejects when code belongs to different client", async () => {
      const otherClient: import("@modelcontextprotocol/sdk/shared/auth.js").OAuthClientInformationFull =
        {
          ...fullClient,
          client_id: "different-client",
        };
      await expect(
        provider.exchangeAuthorizationCode(otherClient, code, "v", redirectUri)
      ).rejects.toThrow(/different client/);
    });

    it("rejects unknown code", async () => {
      await expect(
        provider.exchangeAuthorizationCode(fullClient, "no-such-code", "v", redirectUri)
      ).rejects.toThrow(/Invalid|expired/);
    });
  });

  describe("exchangeRefreshToken", () => {
    let provider: OAuthConnectorProvider;
    let fullClient: import("@modelcontextprotocol/sdk/shared/auth.js").OAuthClientInformationFull;
    let refreshToken: string;

    beforeEach(async () => {
      const made = makeProvider();
      provider = made.provider;
      fullClient = provider.clientsStore.getClient(made.client.clientId)!;
      const res = mockRes();
      await provider.authorize(
        fullClient,
        {
          codeChallenge: "c",
          redirectUri: "https://claude.ai/api/mcp/callback",
          state: "s",
          scopes: ["read:profile", "read:recovery"],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { redirect: res.redirect } as any
      );
      const code = new URL(res.getRedirect()!).searchParams.get("code")!;
      const tokens = await provider.exchangeAuthorizationCode(
        fullClient,
        code,
        "v",
        "https://claude.ai/api/mcp/callback"
      );
      refreshToken = tokens.refresh_token!;
    });

    it("issues a fresh access token", async () => {
      const next = await provider.exchangeRefreshToken(fullClient, refreshToken);
      expect(next.access_token).toBeTruthy();
      expect(next.refresh_token).toBeTruthy();
      expect(next.token_type).toBe("Bearer");
    });

    it("allows narrowing scopes", async () => {
      const next = await provider.exchangeRefreshToken(fullClient, refreshToken, ["read:profile"]);
      expect(next.scope).toBe("read:profile");
    });

    it("rejects upgrading to scopes not in original grant", async () => {
      await expect(
        provider.exchangeRefreshToken(fullClient, refreshToken, ["read:workout"])
      ).rejects.toThrow(/not in original grant/);
    });

    it("rejects access token used as refresh token", async () => {
      const made2 = makeProvider();
      const fullClient2 = made2.provider.clientsStore.getClient(made2.client.clientId)!;
      const res = mockRes();
      await made2.provider.authorize(
        fullClient2,
        {
          codeChallenge: "c",
          redirectUri: "https://claude.ai/api/mcp/callback",
          state: "s",
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { redirect: res.redirect } as any
      );
      const code = new URL(res.getRedirect()!).searchParams.get("code")!;
      const tokens = await made2.provider.exchangeAuthorizationCode(
        fullClient2,
        code,
        "v",
        "https://claude.ai/api/mcp/callback"
      );

      await expect(
        made2.provider.exchangeRefreshToken(fullClient2, tokens.access_token)
      ).rejects.toThrow(/not a refresh token/);
    });

    it("rejects refresh token from different client", async () => {
      const otherClient: import("@modelcontextprotocol/sdk/shared/auth.js").OAuthClientInformationFull =
        {
          ...fullClient,
          client_id: "different-client",
        };
      await expect(provider.exchangeRefreshToken(otherClient, refreshToken)).rejects.toThrow(
        /different client/
      );
    });
  });

  describe("verifyAccessToken", () => {
    it("returns AuthInfo for a valid access token", async () => {
      const { provider, client } = makeProvider();
      const fullClient = provider.clientsStore.getClient(client.clientId)!;
      const res = mockRes();
      await provider.authorize(
        fullClient,
        {
          codeChallenge: "c",
          redirectUri: "https://claude.ai/api/mcp/callback",
          state: "s",
          scopes: ["read:profile"],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { redirect: res.redirect } as any
      );
      const code = new URL(res.getRedirect()!).searchParams.get("code")!;
      const tokens = await provider.exchangeAuthorizationCode(
        fullClient,
        code,
        "v",
        "https://claude.ai/api/mcp/callback"
      );

      const info = await provider.verifyAccessToken(tokens.access_token);
      expect(info.token).toBe(tokens.access_token);
      expect(info.clientId).toBe(client.clientId);
      expect(info.scopes).toEqual(["read:profile"]);
      expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("rejects refresh token used as access token", async () => {
      const { provider, client } = makeProvider();
      const fullClient = provider.clientsStore.getClient(client.clientId)!;
      const res = mockRes();
      await provider.authorize(
        fullClient,
        {
          codeChallenge: "c",
          redirectUri: "https://claude.ai/api/mcp/callback",
          state: "s",
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { redirect: res.redirect } as any
      );
      const code = new URL(res.getRedirect()!).searchParams.get("code")!;
      const tokens = await provider.exchangeAuthorizationCode(
        fullClient,
        code,
        "v",
        "https://claude.ai/api/mcp/callback"
      );

      await expect(provider.verifyAccessToken(tokens.refresh_token!)).rejects.toThrow(
        /not an access token/
      );
    });

    it("rejects garbage tokens", async () => {
      const { provider } = makeProvider();
      await expect(provider.verifyAccessToken("not-a-jwt")).rejects.toThrow();
    });
  });

  describe("stop", () => {
    it("stops the auth code cleanup timer", () => {
      const store = new AuthCodeStore();
      const { provider } = makeProvider({ authCodeStore: store });
      provider.stop();
      // No assertion needed — if this throws or hangs the process, the test fails
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests: createOAuthApp end-to-end
// ---------------------------------------------------------------------------

import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { createOAuthApp } from "../../src/transport/oauth-connector.js";

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function startApp(opts?: { connectorPassword?: string; redirectUri?: string }): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  password: string;
  redirectUri: string;
  clientId: string;
}> {
  const password = opts?.connectorPassword ?? "test-connector-pwd-123";
  const redirectUri = opts?.redirectUri ?? "https://claude.ai/api/mcp/callback";
  const clientId = "claude-ai-connector";
  const secret = new Uint8Array(randomBytes(32));

  const { app, close: closeProvider } = createOAuthApp({
    connectorPassword: password,
    publicUrl: "https://mcp.example.com",
    allowedRedirectUris: [redirectUri],
    jwtSecret: secret,
    scopes: ["read:profile", "read:recovery"],
    client: {
      clientId,
      redirectUris: [redirectUri],
      clientName: "Claude AI Connector",
    },
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("bad address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    password,
    redirectUri,
    clientId,
    close: async () => {
      closeProvider();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe("createOAuthApp (integration)", () => {
  it("rejects too-short connector password at startup", () => {
    expect(() =>
      createOAuthApp({
        connectorPassword: "short",
        publicUrl: "https://mcp.example.com",
        allowedRedirectUris: ["https://claude.ai/cb"],
        jwtSecret: new Uint8Array(32),
        scopes: [],
        client: { clientId: "c", redirectUris: ["https://claude.ai/cb"] },
      })
    ).toThrow(/at least 12/);
  });

  it("rejects non-https publicUrl at startup", () => {
    expect(() =>
      createOAuthApp({
        connectorPassword: "long-enough-password",
        publicUrl: "http://mcp.example.com",
        allowedRedirectUris: ["https://claude.ai/cb"],
        jwtSecret: new Uint8Array(32),
        scopes: [],
        client: { clientId: "c", redirectUris: ["https://claude.ai/cb"] },
      })
    ).toThrow(/https/);
  });

  it("serves OAuth metadata at /.well-known/oauth-authorization-server", async () => {
    const ctx = await startApp();
    try {
      const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.issuer).toBe("https://mcp.example.com/");
      expect(body.authorization_endpoint).toContain("/authorize");
      expect(body.token_endpoint).toContain("/token");
      expect(body.code_challenge_methods_supported).toContain("S256");
    } finally {
      await ctx.close();
    }
  });

  it("GET /authorize renders the password prompt with hidden OAuth params", async () => {
    const ctx = await startApp();
    try {
      const url = new URL(`${ctx.baseUrl}/authorize`);
      url.searchParams.set("client_id", ctx.clientId);
      url.searchParams.set("redirect_uri", ctx.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", "abc");
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", "xyz-state");

      const res = await fetch(url, { redirect: "manual" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain('name="connector_password"');
      expect(html).toContain('value="' + ctx.clientId + '"');
      expect(html).toContain('value="xyz-state"');
      expect(html).toContain('value="' + ctx.redirectUri + '"');
    } finally {
      await ctx.close();
    }
  });

  it("POST /authorize with wrong password re-renders form with 401", async () => {
    const ctx = await startApp();
    try {
      const body = new URLSearchParams({
        client_id: ctx.clientId,
        redirect_uri: ctx.redirectUri,
        response_type: "code",
        code_challenge: "abc",
        code_challenge_method: "S256",
        state: "s",
        connector_password: "wrong-password!",
      });
      const res = await fetch(`${ctx.baseUrl}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        redirect: "manual",
      });
      expect(res.status).toBe(401);
      const html = await res.text();
      expect(html).toContain("Incorrect password");
    } finally {
      await ctx.close();
    }
  });

  it("completes the full authorize → token flow with valid PKCE", async () => {
    const ctx = await startApp();
    try {
      const { verifier, challenge } = pkcePair();
      const state = "state-" + randomBytes(8).toString("hex");

      // 1. POST /authorize with correct password → redirect with code
      const authBody = new URLSearchParams({
        client_id: ctx.clientId,
        redirect_uri: ctx.redirectUri,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        scope: "read:profile read:recovery",
        connector_password: ctx.password,
      });
      const authRes = await fetch(`${ctx.baseUrl}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: authBody,
        redirect: "manual",
      });
      expect(authRes.status).toBeGreaterThanOrEqual(300);
      expect(authRes.status).toBeLessThan(400);
      const location = authRes.headers.get("location");
      expect(location).toBeTruthy();
      const redirected = new URL(location!);
      expect(redirected.origin + redirected.pathname).toBe(ctx.redirectUri);
      expect(redirected.searchParams.get("state")).toBe(state);
      const code = redirected.searchParams.get("code");
      expect(code).toBeTruthy();

      // 2. POST /token with code + verifier → access + refresh tokens
      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: ctx.redirectUri,
        client_id: ctx.clientId,
        code_verifier: verifier,
      });
      const tokenRes = await fetch(`${ctx.baseUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody,
      });
      expect(tokenRes.status).toBe(200);
      const tokens = await tokenRes.json();
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.refresh_token).toBeTruthy();
      expect(tokens.token_type).toBe("Bearer");
      expect(tokens.expires_in).toBeGreaterThan(0);
    } finally {
      await ctx.close();
    }
  });

  it("rejects /token with wrong PKCE verifier", async () => {
    const ctx = await startApp();
    try {
      const { challenge } = pkcePair();

      const authBody = new URLSearchParams({
        client_id: ctx.clientId,
        redirect_uri: ctx.redirectUri,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "s",
        connector_password: ctx.password,
      });
      const authRes = await fetch(`${ctx.baseUrl}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: authBody,
        redirect: "manual",
      });
      const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

      const wrongVerifier = randomBytes(32).toString("base64url");
      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: ctx.redirectUri,
        client_id: ctx.clientId,
        code_verifier: wrongVerifier,
      });
      const tokenRes = await fetch(`${ctx.baseUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody,
      });
      expect(tokenRes.status).toBeGreaterThanOrEqual(400);
      expect(tokenRes.status).toBeLessThan(500);
    } finally {
      await ctx.close();
    }
  });

  it("rejects /token replay of a used authorization code", async () => {
    const ctx = await startApp();
    try {
      const { verifier, challenge } = pkcePair();
      const authBody = new URLSearchParams({
        client_id: ctx.clientId,
        redirect_uri: ctx.redirectUri,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "s",
        connector_password: ctx.password,
      });
      const authRes = await fetch(`${ctx.baseUrl}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: authBody,
        redirect: "manual",
      });
      const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

      const tokenBody = (): URLSearchParams =>
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: ctx.redirectUri,
          client_id: ctx.clientId,
          code_verifier: verifier,
        });

      const first = await fetch(`${ctx.baseUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody(),
      });
      expect(first.status).toBe(200);

      const second = await fetch(`${ctx.baseUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody(),
      });
      expect(second.status).toBeGreaterThanOrEqual(400);
    } finally {
      await ctx.close();
    }
  });

  it("password page sets anti-clickjacking headers", async () => {
    const ctx = await startApp();
    try {
      const url = new URL(`${ctx.baseUrl}/authorize`);
      url.searchParams.set("client_id", ctx.clientId);
      url.searchParams.set("redirect_uri", ctx.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", "abc");
      url.searchParams.set("code_challenge_method", "S256");
      const res = await fetch(url, { redirect: "manual" });
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'none'");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await ctx.close();
    }
  });
});

describe("Refresh token rotation (reuse detection)", () => {
  it("rejects a refresh token that has already been used", async () => {
    const { provider, client } = makeProvider();
    const fullClient = provider.clientsStore.getClient(client.clientId)!;
    const res = mockRes();
    await provider.authorize(
      fullClient,
      {
        codeChallenge: "c",
        redirectUri: "https://claude.ai/api/mcp/callback",
        state: "s",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { redirect: res.redirect } as any
    );
    const code = new URL(res.getRedirect()!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(
      fullClient,
      code,
      "v",
      "https://claude.ai/api/mcp/callback"
    );
    const refresh1 = tokens.refresh_token!;

    // First use succeeds and rotates the refresh token
    const next = await provider.exchangeRefreshToken(fullClient, refresh1);
    expect(next.refresh_token).toBeTruthy();
    expect(next.refresh_token).not.toBe(refresh1);

    // Second use of the SAME (now-consumed) refresh token must be rejected
    await expect(provider.exchangeRefreshToken(fullClient, refresh1)).rejects.toThrow(
      /replay|already been used/
    );
  });

  it("accepts the rotated refresh token after the first use", async () => {
    const { provider, client } = makeProvider();
    const fullClient = provider.clientsStore.getClient(client.clientId)!;
    const res = mockRes();
    await provider.authorize(
      fullClient,
      {
        codeChallenge: "c",
        redirectUri: "https://claude.ai/api/mcp/callback",
        state: "s",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { redirect: res.redirect } as any
    );
    const code = new URL(res.getRedirect()!).searchParams.get("code")!;
    const t1 = await provider.exchangeAuthorizationCode(
      fullClient,
      code,
      "v",
      "https://claude.ai/api/mcp/callback"
    );
    const t2 = await provider.exchangeRefreshToken(fullClient, t1.refresh_token!);
    const t3 = await provider.exchangeRefreshToken(fullClient, t2.refresh_token!);
    expect(t3.access_token).toBeTruthy();
    expect(t3.refresh_token).toBeTruthy();
    expect(t3.refresh_token).not.toBe(t2.refresh_token);
  });

  it("rejects refresh exchange that requests a different resource than the original grant", async () => {
    const { provider, client } = makeProvider();
    const fullClient = provider.clientsStore.getClient(client.clientId)!;
    const res = mockRes();
    await provider.authorize(
      fullClient,
      {
        codeChallenge: "c",
        redirectUri: "https://claude.ai/api/mcp/callback",
        state: "s",
        resource: new URL("https://api.example.com/data"),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { redirect: res.redirect } as any
    );
    const code = new URL(res.getRedirect()!).searchParams.get("code")!;
    const t1 = await provider.exchangeAuthorizationCode(
      fullClient,
      code,
      "v",
      "https://claude.ai/api/mcp/callback"
    );

    await expect(
      provider.exchangeRefreshToken(
        fullClient,
        t1.refresh_token!,
        undefined,
        new URL("https://api.example.com/admin")
      )
    ).rejects.toThrow(/resource indicator/);
  });
});
