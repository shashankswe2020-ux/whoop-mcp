/**
 * End-to-end integration test for HTTP transport.
 *
 * Exercises the full MCP wire protocol — initialize → tools/list → tools/call —
 * over the real HTTP transport with a real McpServer wired to `get_profile`.
 * The underlying WHOOP API is mocked at the global `fetch` level so no
 * external network call is made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer, type HttpServerResult } from "../../src/transport/http.js";
import { createWhoopClient } from "../../src/api/client.js";
import { createWhoopServer } from "../../src/server.js";
import type { UserProfile } from "../../src/api/types.js";

const AUTH_TOKEN = "integration-test-token-1234567890abcdef";

const PROFILE_FIXTURE: UserProfile = {
  user_id: 12345,
  email: "athlete@example.com",
  first_name: "Test",
  last_name: "Athlete",
};

function getServerUrl(http: HttpServerResult): URL {
  const addr = http.server.address();
  if (!addr || typeof addr === "string") throw new Error("server not listening");
  return new URL(`http://127.0.0.1:${addr.port}/mcp`);
}

describe("HTTP transport — MCP integration", () => {
  let httpResult: HttpServerResult | null = null;
  let client: Client | null = null;
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    // Intercept only WHOOP API calls; pass through localhost so the MCP
    // client transport (which also uses fetch) reaches our HTTP server.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.startsWith("https://api.prod.whoop.com")) {
          return new Response(JSON.stringify(PROFILE_FIXTURE), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return realFetch(input as Parameters<typeof realFetch>[0], init);
      })
    );
  });

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => {});
      client = null;
    }
    if (httpResult) {
      await httpResult.close().catch(() => {});
      httpResult = null;
    }
    vi.unstubAllGlobals();
  });

  it("initialize → tools/list → tools/call get_profile returns mocked WHOOP data", async () => {
    // Wire a real WhoopClient + McpServer behind the HTTP transport.
    const whoopClient = createWhoopClient({ accessToken: "fake-access-token" });
    const { server: mcpServer } = createWhoopServer(whoopClient, { disableResources: true });

    httpResult = await createHttpServer({
      authToken: AUTH_TOKEN,
      port: 0,
      host: "127.0.0.1",
      sseReauthIntervalMs: 0,
    });
    await mcpServer.connect(httpResult.transport);

    client = new Client({ name: "integration-test-client", version: "0.0.0" });
    const clientTransport = new StreamableHTTPClientTransport(getServerUrl(httpResult), {
      requestInit: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
    });
    await client.connect(clientTransport);

    const toolList = await client.listTools();
    const profileTool = toolList.tools.find((t) => t.name === "get_profile");
    expect(profileTool).toBeDefined();

    const result = await client.callTool({ name: "get_profile", arguments: {} });
    expect(result.isError).not.toBe(true);

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    const payload = JSON.parse(content[0]?.text ?? "{}") as UserProfile;
    expect(payload).toEqual(PROFILE_FIXTURE);
  });
});
