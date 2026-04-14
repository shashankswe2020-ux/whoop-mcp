/**
 * MCP server setup and tool registration.
 *
 * Creates an McpServer with all 6 WHOOP tools registered.
 * Each tool handler calls the WHOOP API via the provided WhoopClient.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WhoopClient } from "./api/client.js";
import { WhoopApiError, WhoopNetworkError, WhoopAuthError } from "./api/client.js";
import { getProfile } from "./tools/get-profile.js";
import { getBodyMeasurement } from "./tools/get-body-measurement.js";
import { getRecoveryCollection } from "./tools/get-recovery.js";
import { getSleepCollection } from "./tools/get-sleep.js";
import { getWorkoutCollection } from "./tools/get-workout.js";
import { getCycleCollection } from "./tools/get-cycle.js";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Package version
// ---------------------------------------------------------------------------

/** Read the version from package.json at startup */
function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

/** Input schema shared by all collection endpoints (recovery, sleep, workout, cycle) */
const collectionInputSchema = z.object({
  start: z
    .string()
    .optional()
    .describe(
      "Return records after this time (inclusive). ISO 8601 format, e.g. 2026-04-01T00:00:00.000Z"
    ),
  end: z
    .string()
    .optional()
    .describe("Return records before this time (exclusive). ISO 8601 format. Defaults to now."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("Max records to return (1-25). Defaults to 10."),
  nextToken: z.string().optional().describe("Pagination token from a previous response."),
});

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------

function jsonContent(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Error response helper
// ---------------------------------------------------------------------------

/** Format a caught error into an MCP-compatible isError response */
function errorResponse(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  let message: string;

  if (error instanceof WhoopApiError) {
    const bodyStr = typeof error.body === "string" ? error.body : JSON.stringify(error.body);
    message = `WHOOP API returned ${error.statusCode} ${error.statusText}: ${bodyStr}`;
  } else if (error instanceof WhoopAuthError) {
    message = error.message;
  } else if (error instanceof WhoopNetworkError) {
    message = error.message;
  } else if (error instanceof Error) {
    message = `Unexpected error: ${error.message}`;
  } else {
    message = "An unexpected error occurred";
  }

  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

/** Wrap a tool handler with error-to-MCP-error conversion */
async function safeTool<T>(
  fn: () => Promise<T>
): Promise<
  | { content: Array<{ type: "text"; text: string }> }
  | { isError: true; content: Array<{ type: "text"; text: string }> }
> {
  try {
    return jsonContent(await fn());
  } catch (error: unknown) {
    return errorResponse(error);
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create a configured MCP server with all 6 WHOOP tools registered.
 *
 * This is a pure factory — it does not start transports, handle OAuth,
 * or read environment variables. Connect the returned server to any
 * transport (stdio, InMemoryTransport, MCP Inspector).
 *
 * @param client - WHOOP API client used by tool handlers
 */
export function createWhoopServer(client: WhoopClient): McpServer {
  const server = new McpServer({
    name: "whoop-mcp",
    version: getPackageVersion(),
  });

  // -------------------------------------------------------------------------
  // Tool 1: get_profile
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_profile",
    {
      description: "Get the authenticated user's basic profile — name and email.",
      annotations: { readOnlyHint: true },
    },
    async () => safeTool(() => getProfile(client))
  );

  // -------------------------------------------------------------------------
  // Tool 2: get_body_measurement
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_body_measurement",
    {
      description: "Get the user's body measurements — height, weight, and max heart rate.",
      annotations: { readOnlyHint: true },
    },
    async () => safeTool(() => getBodyMeasurement(client))
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
    async (args: z.infer<typeof collectionInputSchema>) =>
      safeTool(() => getRecoveryCollection(client, args))
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
    async (args: z.infer<typeof collectionInputSchema>) =>
      safeTool(() => getSleepCollection(client, args))
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
    async (args: z.infer<typeof collectionInputSchema>) =>
      safeTool(() => getWorkoutCollection(client, args))
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
    async (args: z.infer<typeof collectionInputSchema>) =>
      safeTool(() => getCycleCollection(client, args))
  );

  return server;
}
