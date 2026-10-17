import { afterEach, describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWhoopServer } from "../src/server.js";
import { analyticsClient } from "./helpers/analytics-fixtures.js";
import { createTelemetry } from "../src/telemetry/telemetry.js";
import {
  WhoopApiError,
  WhoopAuthError,
  WhoopNetworkError,
  type WhoopClient,
} from "../src/api/client.js";
import { z } from "zod";

afterEach(() => vi.unstubAllGlobals());

describe("MCP command telemetry", () => {
  it.each([
    "success",
    "handler_error",
    "invalid_output",
    "aggregate",
    "collector_error",
    "collector_stalled",
  ])("records only safe tool outcomes: %s", async (scenario) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    if (scenario === "collector_error") fetchMock.mockRejectedValue(new Error("collector secret"));
    let stalledSignal: AbortSignal | undefined;
    if (scenario === "collector_stalled")
      fetchMock.mockImplementation((_url: string, options: RequestInit) => {
        stalledSignal = options.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          stalledSignal!.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      });
    vi.stubGlobal("fetch", fetchMock);
    const telemetry = createTelemetry({
      WHOOP_MCP_TELEMETRY: "1",
      WHOOP_MCP_TELEMETRY_ENDPOINT: "https://collector.example/events",
    });
    const whoopClient: WhoopClient =
      scenario === "handler_error"
        ? { get: vi.fn().mockRejectedValue(new Error("health secret")) }
        : scenario === "invalid_output"
          ? { get: vi.fn().mockResolvedValue({ private: "health secret" }) }
          : scenario === "aggregate"
            ? analyticsClient()
            : {
                get: vi.fn().mockResolvedValue({
                  user_id: 12345,
                  email: "jane@example.com",
                  first_name: "Jane",
                  last_name: "Doe",
                }),
              };
    const { server } = createWhoopServer(whoopClient, {
      privacyMode: scenario === "aggregate" ? "aggregate" : "standard",
      telemetry,
    });
    const client = new Client({ name: "telemetry-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect((await client.callTool({ name: "unknown_private_tool", arguments: {} })).isError).toBe(
        true
      );
      expect(
        (
          await client.callTool({
            name: "get_sleep_by_id",
            arguments: { id: "private invalid id" },
          })
        ).isError
      ).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      const name = scenario === "aggregate" ? "get_baselines" : "get_profile";
      const result = await client.callTool({ name, arguments: {} });
      const failed = scenario === "handler_error" || scenario === "invalid_output";
      expect(Boolean(result.isError)).toBe(failed);
      if (scenario === "collector_stalled") expect(stalledSignal?.aborted).toBe(false);
      await telemetry.flush();
      if (scenario === "aggregate") expect(fetchMock).not.toHaveBeenCalled();
      else {
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const options = fetchMock.mock.calls[0]![1] as RequestInit;
        expect(JSON.parse(options.body as string)).toEqual({
          schema_version: 1,
          package_version: expect.any(String),
          kind: "tool",
          name,
          outcome: failed ? "error" : "success",
          ...(failed
            ? {
                error_category: scenario === "invalid_output" ? "output_contract" : "unexpected",
              }
            : {}),
        });
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    [new WhoopAuthError(new Error("private")), "api_auth"],
    [new WhoopApiError(401, "Unauthorized", null), "api_auth"],
    [new WhoopApiError(429, "Too Many Requests", null), "api_rate_limit"],
    [new WhoopApiError(400, "Bad Request", null), "api_client"],
    [new WhoopApiError(500, "Server Error", null), "api_server"],
    [new WhoopNetworkError(new Error("private")), "network"],
    [new z.ZodError([]), "invalid_data"],
    [new Error("private"), "unexpected"],
  ])("records a coarse category for %s", async (failure, errorCategory) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const telemetry = createTelemetry({
      WHOOP_MCP_TELEMETRY: "1",
      WHOOP_MCP_TELEMETRY_ENDPOINT: "https://collector.example/events",
    });
    const { server } = createWhoopServer(
      { get: vi.fn().mockRejectedValue(failure) },
      { telemetry }
    );
    const client = new Client({ name: "telemetry-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect((await client.callTool({ name: "get_profile", arguments: {} })).isError).toBe(true);
      await telemetry.flush();
      const options = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(JSON.parse(options.body as string)).toMatchObject({
        kind: "tool",
        name: "get_profile",
        outcome: "error",
        error_category: errorCategory,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function connected(
  aggregate: boolean,
  run: (client: Client) => Promise<void>
): Promise<void> {
  const { server } = createWhoopServer(analyticsClient(), {
    privacyMode: aggregate ? "aggregate" : "standard",
  });
  const client = new Client({ name: "release-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("release MCP contracts", () => {
  it("advertises output schemas and returns equivalent structured/text results", async () => {
    await connected(false, async (client) => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(22);
      expect(tools.every((tool) => tool.outputSchema?.type === "object")).toBe(true);
      expect(
        tools.every(
          (tool) => tool.outputSchema?.$schema === "https://json-schema.org/draft/2020-12/schema"
        )
      ).toBe(true);
      for (const name of ["get_baselines", "get_sleep_debt", "get_today"]) {
        const result = await client.callTool({ name, arguments: {} });
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        expect(JSON.parse(content[0]!.text)).toEqual(result.structuredContent);
      }
    });
  });
  it("exposes only aggregate capabilities and projects both output channels", async () => {
    await connected(true, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "compare_periods",
        "get_baselines",
        "get_sleep_debt",
        "get_trend",
        "get_weekly_summary",
      ]);
      expect(tools.every((tool) => tool.outputSchema?.type === "object")).toBe(true);
      expect(
        tools.every(
          (tool) => tool.outputSchema?.$schema === "https://json-schema.org/draft/2020-12/schema"
        )
      ).toBe(true);
      for (const name of ["get_baselines", "get_sleep_debt"]) {
        const result = await client.callTool({ name, arguments: {} });
        expect(result.isError).not.toBe(true);
        const text = JSON.stringify(result);
        for (const field of [
          "latest",
          'nights"',
          "standing_debt",
          "user_id",
          "sleep_id",
          "source_updated_at",
        ])
          expect(text).not.toContain(field);
        expect(text).not.toContain("observed_period");
        const data = result.structuredContent as { period: { start: string; end: string } | null };
        if (data.period) expect(data.period.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      const denied = await client.callTool({ name: "get_profile", arguments: {} });
      expect(denied.isError).toBe(true);
      await expect(client.readResource({ uri: "whoop://v2/user/profile" })).rejects.toThrow();
      await expect(client.getPrompt({ name: "health_check" })).rejects.toThrow();
    });
  });
  it("rejects invalid privacy configuration", () => {
    expect(() =>
      createWhoopServer(analyticsClient(), { privacyMode: "raw" as "standard" })
    ).toThrow();
  });
});
