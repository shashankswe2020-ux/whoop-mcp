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
    get: <T,>(): Promise<T> =>
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

    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      { capabilities: {} }
    );
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
      oauthHandler: oauth.app as unknown as Parameters<
        typeof createHttpServer
      >[0]["oauthHandler"],
    });
    cleanup = async (): Promise<void> => {
      oauth.close();
      await httpResult.close();
    };

    const addr = httpResult.server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const r = await fetch(
      `http://127.0.0.1:${addr.port}/.well-known/oauth-authorization-server`
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { issuer: string };
    expect(body.issuer).toMatch(/^https:\/\/example\.com\/?$/);
  });
});
