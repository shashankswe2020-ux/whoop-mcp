import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWhoopServer, type CreateServerOptions } from "../src/server.js";
import { HYROX_STATIONS } from "../src/performance/schemas.js";
import { nights, performanceClient, redditHyroxDay } from "./helpers/performance-fixtures.js";

const READ_TOOLS = [
  "audit_performance_data",
  "get_hyrox_performance",
  "get_hyrox_session_report",
  "get_race_readiness",
  "get_triathlon_performance",
  "verify_claim",
];
const WRITE_TOOLS = ["annotate_workout", "log_race_result", "open_performance_dashboard"];

let root: string;
let dir: string;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "whoop-server-perf-"));
  dir = join(root, "state");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function connect(options: CreateServerOptions): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const { sleep, recovery } = nights("2026-10-20", 30, { recovery: 70 });
  const { server } = createWhoopServer(
    performanceClient({ workouts: redditHyroxDay(), sleep, recovery }),
    options
  );
  const client = new Client({ name: "perf-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ text: string }>)[0]!.text;
}

describe("hybrid race performance tools over MCP", () => {
  it("remote mode exposes only the six read-only tools, all working without a store", async () => {
    const { client, close } = await connect({});
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of READ_TOOLS) expect(names).toContain(name);
      for (const name of WRITE_TOOLS) expect(names).not.toContain(name);

      const calls: Array<[string, Record<string, unknown>]> = [
        ["get_hyrox_session_report", { date: "2026-10-15" }],
        ["get_hyrox_performance", {}],
        ["get_triathlon_performance", {}],
        ["get_race_readiness", { sport: "hyrox" }],
        ["audit_performance_data", {}],
        [
          "verify_claim",
          {
            metric: "workout_count",
            claimed_value: 10,
            period: { start: "2026-10-15", end: "2026-10-16" },
          },
        ],
      ];
      for (const [name, args] of calls) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, `${name}: ${text(result)}`).not.toBe(true);
        expect(JSON.parse(text(result))).toEqual(result.structuredContent);
        expect(result.structuredContent).toMatchObject({ store: { status: "not_configured" } });
      }
    } finally {
      await close();
    }
  });

  it("local mode adds the write tools with correct hints and output schemas", async () => {
    const { client, close } = await connect({ localPerformance: { directory: dir } });
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      for (const name of READ_TOOLS) expect(byName.get(name)!.annotations?.readOnlyHint).toBe(true);
      for (const name of WRITE_TOOLS)
        expect(byName.get(name)!.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
        });
      for (const name of [...READ_TOOLS, ...WRITE_TOOLS])
        expect(byName.get(name)!.outputSchema).toMatchObject({
          type: "object",
          $schema: "https://json-schema.org/draft/2020-12/schema",
        });
    } finally {
      await close();
    }
  });

  it("an annotation made over MCP is visible in the audit and changes the count", async () => {
    const { client, close } = await connect({ localPerformance: { directory: dir } });
    try {
      const annotated = await client.callTool({
        name: "annotate_workout",
        arguments: {
          workout_id: "run-1",
          action: "relabel",
          discipline: "hyrox",
          reason: "hyrox_sim",
        },
      });
      expect(annotated.isError, text(annotated)).not.toBe(true);

      const audit = await client.callTool({ name: "audit_performance_data", arguments: {} });
      expect(audit.structuredContent).toMatchObject({
        store: { status: "available" },
        unconfirmed_candidates: [],
        audit_log: {
          entries: [{ actor: "mcp_tool", action: "annotate_workout", workout_id: "run-1" }],
        },
      });

      const claim = await client.callTool({
        name: "verify_claim",
        arguments: {
          metric: "hyrox_sessions",
          claimed_value: 1,
          period: { start: "2026-10-15", end: "2026-10-16" },
        },
      });
      expect(claim.structuredContent).toMatchObject({ verdict: "confirmed" });
    } finally {
      await close();
    }
  });

  it("returns validation messages verbatim and store errors without paths", async () => {
    const { client, close } = await connect({ localPerformance: { directory: dir } });
    try {
      const stations = HYROX_STATIONS.map((station) => ({ station, seconds: 200 })).reverse();
      const invalid = await client.callTool({
        name: "log_race_result",
        arguments: {
          sport: "hyrox",
          date: "2026-10-04",
          name: "HYROX Mumbai",
          category: "open_men",
          total_seconds: 4000,
          splits: { runs: Array.from({ length: 8 }, () => 300), stations },
        },
      });
      expect(invalid.isError).toBe(true);
      expect(text(invalid)).toMatch(
        /^Invalid input: splits\.stations: Stations must be in official order/
      );

      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "performance.json"), "{broken");
      const broken = await client.callTool({
        name: "annotate_workout",
        arguments: { workout_id: "run-4", action: "exclude", reason: "misclassified" },
      });
      expect(broken.isError).toBe(true);
      expect(text(broken)).toMatch(/^Local performance data error: .*Nothing was changed\.$/);
      expect(text(broken)).not.toContain(root);

      const read = await client.callTool({ name: "get_hyrox_performance", arguments: {} });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({ store: { status: "error" } });
    } finally {
      await close();
    }
  });

  it("opens the dashboard over MCP without a real browser and serves the same data", async () => {
    const staticDir = join(root, "static");
    await mkdir(staticDir, { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html>");
    const openBrowser = vi.fn();
    const { client, close } = await connect({
      localPerformance: { directory: dir, openBrowser, dashboardStaticDir: staticDir },
    });
    try {
      const opened = await client.callTool({
        name: "open_performance_dashboard",
        arguments: { view: "audit" },
      });
      expect(opened.isError, text(opened)).not.toBe(true);
      const { url } = opened.structuredContent as { url: string };
      expect(openBrowser).toHaveBeenCalledWith(url);

      const token = new URL(url).hash.replace(/^#token=/, "");
      const response = await fetch(new URL("/api/audit", url), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      const viaMcp = await client.callTool({ name: "audit_performance_data", arguments: {} });
      expect(await response.json()).toEqual(viaMcp.structuredContent);
    } finally {
      await close();
    }
  });

  it("aggregate privacy mode exposes none of the race tools", async () => {
    const { client, close } = await connect({
      privacyMode: "aggregate",
      localPerformance: { directory: dir },
    });
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) expect(names).not.toContain(name);
    } finally {
      await close();
    }
  });
});
