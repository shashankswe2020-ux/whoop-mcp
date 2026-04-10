/**
 * MCP server setup and tool registration.
 *
 * Creates an McpServer with all 6 WHOOP tools registered as stubs.
 * Tool handlers will be replaced with real implementations in Tasks 7a–7f.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WhoopClient } from "./api/client.js";

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

/** Input schema shared by all collection endpoints (recovery, sleep, workout, cycle) */
const collectionInputSchema = z.object({
  start: z
    .string()
    .optional()
    .describe(
      "Return records after this time (inclusive). ISO 8601 format, e.g. 2026-04-01T00:00:00.000Z",
    ),
  end: z
    .string()
    .optional()
    .describe(
      "Return records before this time (exclusive). ISO 8601 format. Defaults to now.",
    ),
  limit: z
    .number()
    .optional()
    .describe("Max records to return (1-25). Defaults to 10."),
  nextToken: z
    .string()
    .optional()
    .describe("Pagination token from a previous response."),
});

// ---------------------------------------------------------------------------
// Stub response
// ---------------------------------------------------------------------------

const STUB_RESPONSE = {
  content: [{ type: "text" as const, text: "Not implemented yet" }],
  isError: true,
};

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create a configured MCP server with all 6 WHOOP tools registered.
 *
 * Tool handlers are stubs that return "Not implemented yet" — they will
 * be replaced with real implementations in Tasks 7a–7f.
 *
 * @param _client - WHOOP API client (unused by stubs, will be used by real handlers)
 */
export function createWhoopServer(_client: WhoopClient): McpServer {
  const server = new McpServer({
    name: "whoop-mcp",
    version: "0.1.0",
  });

  // -------------------------------------------------------------------------
  // Tool 1: get_profile
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_profile",
    {
      description:
        "Get the authenticated user's basic profile — name and email.",
      annotations: { readOnlyHint: true },
    },
    async () => STUB_RESPONSE,
  );

  // -------------------------------------------------------------------------
  // Tool 2: get_body_measurement
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_body_measurement",
    {
      description:
        "Get the user's body measurements — height, weight, and max heart rate.",
      annotations: { readOnlyHint: true },
    },
    async () => STUB_RESPONSE,
  );

  // -------------------------------------------------------------------------
  // Tool 3: get_recovery_collection
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_recovery_collection",
    {
      description:
        "Get recovery scores for a date range. Returns HRV, resting heart rate, SpO2, and skin temp for each day.",
      inputSchema: collectionInputSchema,
      annotations: { readOnlyHint: true },
    },
    async () => STUB_RESPONSE,
  );

  // -------------------------------------------------------------------------
  // Tool 4: get_sleep_collection
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_sleep_collection",
    {
      description:
        "Get sleep records for a date range. Returns sleep stages, duration, respiratory rate, and performance scores.",
      inputSchema: collectionInputSchema,
      annotations: { readOnlyHint: true },
    },
    async () => STUB_RESPONSE,
  );

  // -------------------------------------------------------------------------
  // Tool 5: get_workout_collection
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_workout_collection",
    {
      description:
        "Get workout records for a date range. Returns strain, heart rate zones, calories, and sport type.",
      inputSchema: collectionInputSchema,
      annotations: { readOnlyHint: true },
    },
    async () => STUB_RESPONSE,
  );

  // -------------------------------------------------------------------------
  // Tool 6: get_cycle_collection
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_cycle_collection",
    {
      description:
        "Get physiological cycles for a date range. Returns strain, calories, and heart rate data per cycle.",
      inputSchema: collectionInputSchema,
      annotations: { readOnlyHint: true },
    },
    async () => STUB_RESPONSE,
  );

  return server;
}
