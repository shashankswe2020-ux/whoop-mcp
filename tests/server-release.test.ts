import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWhoopServer } from "../src/server.js";
import { analyticsClient } from "./helpers/analytics-fixtures.js";

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
      expect(tools).toHaveLength(16);
      expect(tools.every((tool) => tool.outputSchema?.type === "object")).toBe(true);
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
