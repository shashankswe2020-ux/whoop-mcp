/**
 * Integration test: tools / resources / prompts work over the HTTP transport.
 *
 * Spins up a real `createWhoopServer` connected to a real `createHttpServer`
 * and connects an SDK `Client` over `StreamableHTTPClientTransport` with
 * bearer auth. Verifies tool list, resource list, prompt list, and a tool
 * call all flow end-to-end.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer } from "../../src/transport/http.js";
import { createWhoopServer } from "../../src/server.js";
import type { WhoopClient } from "../../src/api/client.js";

function makeMockWhoopClient(): WhoopClient {
  return {
    get: <T>(): Promise<T> =>
      Promise.resolve({
        user_id: 42,
        email: "test@example.com",
        first_name: "T",
        last_name: "User",
      } as T),
  };
}

describe("HTTP transport — MCP integration", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("lists tools, resources, and prompts over HTTP with bearer auth", async () => {
    const mockClient = makeMockWhoopClient();
    const { server: mcpServer } = createWhoopServer(mockClient);

    const httpResult = await createHttpServer({
      authToken: "test-bearer-token",
      port: 0,
    });
    await mcpServer.connect(httpResult.transport);

    const addr = httpResult.server.address();
    if (!addr || typeof addr === "string") throw new Error("server has no port");

    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${addr.port}/mcp`),
      {
        requestInit: { headers: { Authorization: "Bearer test-bearer-token" } },
      }
    );

    cleanup = async (): Promise<void> => {
      await client.close().catch(() => {});
      await httpResult.close();
    };

    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThanOrEqual(6);
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain("get_profile");

    const resources = await client.listResources();
    expect(resources.resources.length).toBeGreaterThanOrEqual(1);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.length).toBeGreaterThanOrEqual(1);

    // Round-trip a real tool call
    const result = await client.callTool({ name: "get_profile", arguments: {} });
    expect(result.isError).not.toBe(true);
  }, 15_000);

  it("forwards OAuth metadata requests to the mounted oauthHandler", async () => {
    const { createOAuthApp } = await import("../../src/transport/oauth-connector.js");
    const { deriveJwtSecret } = await import("../../src/transport/oauth-helpers.js");
    const jwtSecret = await deriveJwtSecret("a".repeat(32));
    const oauth = createOAuthApp({
      connectorPassword: "twelve-or-more-chars",
      publicUrl: "https://example.com",
      allowedRedirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      jwtSecret,
      scopes: ["mcp"],
      client: {
        clientId: "whoop-mcp-connector",
        clientName: "WHOOP MCP Connector",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      },
    });

    const httpResult = await createHttpServer({
      authToken: "test-bearer-token",
      port: 0,
      oauthHandler: oauth.app as unknown as Parameters<typeof createHttpServer>[0]["oauthHandler"],
    });
    cleanup = async (): Promise<void> => {
      oauth.close();
      await httpResult.close();
    };

    const addr = httpResult.server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const r = await fetch(`http://127.0.0.1:${addr.port}/.well-known/oauth-authorization-server`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { issuer: string };
    expect(body.issuer).toMatch(/^https:\/\/example\.com\/?$/);
  });

  it("stateless mode: repeated initialize + tool listing without a session id", async () => {
    // Reproduces the claude.ai web/mobile pattern: a fresh `initialize` every
    // turn, no Mcp-Session-Id reused. A single shared stateful transport rejects
    // the 2nd initialize with 400; the per-request stateless factory must not.
    const authToken = "test-bearer-token-0123456789abcdef";
    const httpResult = await createHttpServer({
      authToken,
      port: 0,
      createMcpServer: () => createWhoopServer(makeMockWhoopClient()).server,
    });
    cleanup = async (): Promise<void> => {
      await httpResult.close();
    };
    const addr = httpResult.server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const mcpUrl = `http://127.0.0.1:${addr.port}/mcp`;

    const post = (method: string, id: number, params?: unknown): Promise<Response> =>
      fetch(mcpUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method, id, ...(params ? { params } : {}) }),
      });

    const initParams = {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    };

    // Two independent initialize requests with NO session id reuse — both must
    // succeed (the old shared stateful transport 400s on the second).
    const init1 = await post("initialize", 1, initParams);
    expect(init1.status).toBe(200);
    const init2 = await post("initialize", 2, initParams);
    expect(init2.status).toBe(200);

    // A tool listing on a fresh stateless request returns the tool set.
    const list = await post("tools/list", 3, {});
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).toContain("get_profile");
  }, 15_000);

  it("accepts a connector-issued JWT at /mcp and rejects a forged one", async () => {
    // Reproduces the claude.ai web/mobile path: the connector signs a JWT
    // access token that /mcp must accept alongside the static admin bearer.
    const { OAuthConnectorProvider } = await import("../../src/transport/oauth-connector.js");
    const { deriveJwtSecret } = await import("../../src/transport/oauth-helpers.js");
    const { signToken, ACCESS_TOKEN_TTL_SECONDS } = await import(
      "../../src/transport/oauth-jwt.js"
    );
    const { safeTokenCompare } = await import("../../src/transport/http.js");

    const jwtSecret = await deriveJwtSecret("a".repeat(40));
    const provider = new OAuthConnectorProvider({
      client: {
        clientId: "whoop-mcp-connector",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      },
      allowedRedirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      jwtSecret,
      scopes: ["mcp"],
    });

    const jwt = await signToken(
      {
        clientId: "whoop-mcp-connector",
        scopes: ["mcp"],
        ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
        type: "access",
      },
      jwtSecret
    );

    const authToken = "static-admin-token-0123456789abcdef";
    const verifyBearer = async (token: string): Promise<boolean> => {
      if (safeTokenCompare(token, authToken)) return true;
      try {
        await provider.verifyAccessToken(token);
        return true;
      } catch {
        return false;
      }
    };

    const { server: mcpServer } = createWhoopServer(makeMockWhoopClient());
    const httpResult = await createHttpServer({ authToken, port: 0, verifyBearer });
    await mcpServer.connect(httpResult.transport);
    cleanup = async (): Promise<void> => {
      provider.stop();
      await httpResult.close();
    };

    const addr = httpResult.server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const mcpUrl = `http://127.0.0.1:${addr.port}/mcp`;
    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });

    // Valid connector JWT clears the auth gate (may be a non-401 transport code).
    const good = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initBody,
    });
    expect(good.status).not.toBe(401);

    // A forged token is rejected at the gate.
    const bad = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer forged.jwt.token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initBody,
    });
    expect(bad.status).toBe(401);
  });
});
