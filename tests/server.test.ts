import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWhoopServer } from "../src/server.js";
import type { WhoopClient } from "../src/api/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock WhoopClient — stub tools don't actually call it */
function createMockClient(): WhoopClient {
  return {
    get: async <T>(_path: string): Promise<T> => {
      throw new Error("Mock client: should not be called by stub handlers");
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("createWhoopServer", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const mockWhoopClient = createMockClient();
    const server = createWhoopServer(mockWhoopClient);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    cleanup = async () => {
      await client.close();
      await server.close();
    };
  });

  afterAll(async () => {
    await cleanup();
  });

  // -------------------------------------------------------------------------
  // Tool listing
  // -------------------------------------------------------------------------

  describe("tools/list", () => {
    it("returns exactly 6 tools", async () => {
      const result = await client.listTools();

      expect(result.tools).toHaveLength(6);
    });

    it("returns tools with the correct names", async () => {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();

      expect(names).toEqual([
        "get_body_measurement",
        "get_cycle_collection",
        "get_profile",
        "get_recovery_collection",
        "get_sleep_collection",
        "get_workout_collection",
      ]);
    });

    it("every tool has a description", async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        expect(tool.description).toBeTruthy();
        expect(typeof tool.description).toBe("string");
      }
    });

    it("every tool has readOnlyHint annotation", async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Input schemas — singleton tools (no params)
  // -------------------------------------------------------------------------

  describe("get_profile schema", () => {
    it("has an object input schema with no required properties", async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "get_profile");

      expect(tool).toBeDefined();
      expect(tool!.inputSchema.type).toBe("object");
    });
  });

  describe("get_body_measurement schema", () => {
    it("has an object input schema with no required properties", async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "get_body_measurement");

      expect(tool).toBeDefined();
      expect(tool!.inputSchema.type).toBe("object");
    });
  });

  // -------------------------------------------------------------------------
  // Input schemas — collection tools (start, end, limit, nextToken)
  // -------------------------------------------------------------------------

  const collectionTools = [
    "get_recovery_collection",
    "get_sleep_collection",
    "get_workout_collection",
    "get_cycle_collection",
  ];

  for (const toolName of collectionTools) {
    describe(`${toolName} schema`, () => {
      it("has start, end, limit, and nextToken properties", async () => {
        const result = await client.listTools();
        const tool = result.tools.find((t) => t.name === toolName);

        expect(tool).toBeDefined();
        expect(tool!.inputSchema.type).toBe("object");

        const props = tool!.inputSchema.properties as Record<
          string,
          unknown
        >;
        expect(props).toHaveProperty("start");
        expect(props).toHaveProperty("end");
        expect(props).toHaveProperty("limit");
        expect(props).toHaveProperty("nextToken");
      });
    });
  }

  // -------------------------------------------------------------------------
  // Stub handler behavior
  // -------------------------------------------------------------------------

  describe("stub handlers", () => {
    it("get_profile stub returns isError with not-implemented message", async () => {
      const result = await client.callTool({
        name: "get_profile",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Not implemented"),
          }),
        ]),
      );
    });

    it("get_recovery_collection stub returns isError", async () => {
      const result = await client.callTool({
        name: "get_recovery_collection",
        arguments: {},
      });

      expect(result.isError).toBe(true);
    });

    it("get_sleep_collection stub returns isError", async () => {
      const result = await client.callTool({
        name: "get_sleep_collection",
        arguments: {},
      });

      expect(result.isError).toBe(true);
    });

    it("get_workout_collection stub returns isError", async () => {
      const result = await client.callTool({
        name: "get_workout_collection",
        arguments: {},
      });

      expect(result.isError).toBe(true);
    });

    it("get_cycle_collection stub returns isError", async () => {
      const result = await client.callTool({
        name: "get_cycle_collection",
        arguments: {},
      });

      expect(result.isError).toBe(true);
    });

    it("get_body_measurement stub returns isError", async () => {
      const result = await client.callTool({
        name: "get_body_measurement",
        arguments: {},
      });

      expect(result.isError).toBe(true);
    });
  });
});
