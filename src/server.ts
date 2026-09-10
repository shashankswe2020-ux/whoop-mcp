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
import { getSleepById } from "./tools/get-sleep-by-id.js";
import { getWorkoutById } from "./tools/get-workout-by-id.js";
import { getCycleById } from "./tools/get-cycle-by-id.js";
import { getWeeklySummary } from "./tools/get-weekly-summary.js";
import { comparePeriods } from "./tools/compare-periods.js";
import { getTrend } from "./tools/get-trend.js";
import { getToday } from "./tools/get-today.js";
import { getCalendar } from "./tools/get-calendar.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";
import { ISO_8601_REGEX } from "./tools/date-utils.js";
import { readFileSync } from "node:fs";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { getBaselines, baselinesInputSchema } from "./tools/get-baselines.js";
import { getSleepDebt, sleepDebtInputSchema } from "./tools/get-sleep-debt.js";
import {
  outputSchemas,
  aggregateOutputSchemas,
  privacyModeSchema,
  projectAggregateDates,
  type PrivacyMode,
} from "./tools/output-contracts.js";

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

/** Input schema for string ID lookup (sleep, workout) */
const stringIdSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "ID must contain only alphanumeric characters, hyphens, and underscores"
    )
    .describe("The record ID to look up."),
});

/** Input schema for numeric ID lookup (cycle) */
const numericIdSchema = z.object({
  id: z.number().int().positive().describe("The record ID to look up."),
});

/** Reusable ISO 8601 date/datetime string with schema-level validation */
const isoDateString = z
  .string()
  .regex(ISO_8601_REGEX, "Expected ISO 8601 date in YYYY-MM-DD or full datetime format.");

/** Input schema shared by all collection endpoints (recovery, sleep, workout, cycle) */
const collectionInputSchema = z.object({
  start: z
    .string()
    .optional()
    .describe(
      'Return records after this time (inclusive). ISO 8601 format or relative expression (e.g. "today", "last 7 days", "this week").'
    ),
  end: z
    .string()
    .optional()
    .describe(
      "Return records before this time (exclusive). ISO 8601 format or relative expression. Defaults to now."
    ),
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

function jsonContent(data: unknown): CallToolResult {
  const text = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
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
    message = `WHOOP API returned ${error.statusCode}. Retry later or verify authorization.`;
  } else if (error instanceof WhoopAuthError) {
    message = "WHOOP authentication failed. Run setup --verify to reconnect.";
  } else if (error instanceof WhoopNetworkError) {
    message = "Network error: Unable to reach the WHOOP API. Check your internet connection.";
  } else if (error instanceof z.ZodError || error instanceof RangeError) {
    message = "Invalid input or data. Check the requested parameters and date range.";
  } else {
    message = "An unexpected error occurred. Check configuration and retry.";
  }

  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

/** Wrap a tool handler with error-to-MCP-error conversion */
async function safeTool<T>(fn: () => Promise<T>): Promise<CallToolResult> {
  try {
    return jsonContent(await fn());
  } catch (error: unknown) {
    return errorResponse(error);
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/** Options for createWhoopServer */
export interface CreateServerOptions {
  privacyMode?: PrivacyMode;
  /** Disable MCP resource registration (set via WHOOP_MCP_DISABLE_RESOURCES=1) */
  disableResources?: boolean;
}

/** Return type for the configured MCP server. */
export interface WhoopServer {
  server: McpServer;
}

/**
 * Create a configured MCP server with all WHOOP tools and resources registered.
 *
 * This is a pure factory — it does not start transports, handle OAuth,
 * or read environment variables. Connect the returned server to any
 * transport (stdio, InMemoryTransport, MCP Inspector).
 *
 * @param client - WHOOP API client used by tool handlers
 * @param options - Optional configuration (e.g., disable resources)
 */
export function createWhoopServer(client: WhoopClient, options?: CreateServerOptions): WhoopServer {
  const privacyMode = privacyModeSchema.parse(options?.privacyMode ?? "standard");
  const server = new McpServer({
    name: "whoop-mcp",
    version: getPackageVersion(),
  });

  function registerTool<Shape extends z.ZodRawShape>(
    name: string,
    config: { description: string; inputSchema?: z.ZodObject<Shape>; annotations: ToolAnnotations },
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>
  ): void {
    const schema = (privacyMode === "aggregate" ? aggregateOutputSchemas : outputSchemas)[name];
    if (!schema) {
      if (privacyMode === "aggregate") return;
      throw new Error("Missing tool output contract.");
    }
    server.registerTool(
      name,
      { ...config, inputSchema: config.inputSchema ?? z.object({}), outputSchema: schema },
      async (args) => {
        const result = await handler(args as z.infer<z.ZodObject<Shape>>);
        if (result.isError) return result;
        const validated = schema.safeParse(result.structuredContent);
        if (!validated.success)
          return {
            isError: true,
            content: [
              { type: "text", text: "WHOOP data did not match the expected output contract." },
            ],
          };
        return jsonContent(
          privacyMode === "aggregate" ? projectAggregateDates(validated.data) : validated.data
        );
      }
    );
  }

  // -------------------------------------------------------------------------
  // Tool 1: get_profile
  // -------------------------------------------------------------------------
  registerTool(
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
  registerTool(
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
  registerTool(
    "get_recovery_collection",
    {
      description:
        'Get recovery scores for a date range. Accepts ISO 8601 or relative dates ("today", "last 7 days", "this week"). Returns HRV, resting heart rate, SpO2, and skin temp for each day.',
      inputSchema: collectionInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: z.infer<typeof collectionInputSchema>) =>
      safeTool(() => getRecoveryCollection(client, args))
  );

  // -------------------------------------------------------------------------
  // Tool 4: get_sleep_collection
  // -------------------------------------------------------------------------
  registerTool(
    "get_sleep_collection",
    {
      description:
        'Get sleep records for a date range. Accepts ISO 8601 or relative dates ("today", "last 7 days", "this week"). Returns sleep stages, duration, respiratory rate, and performance scores.',
      inputSchema: collectionInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: z.infer<typeof collectionInputSchema>) =>
      safeTool(() => getSleepCollection(client, args))
  );

  // -------------------------------------------------------------------------
  // Tool 5: get_workout_collection
  // -------------------------------------------------------------------------
  registerTool(
    "get_workout_collection",
    {
      description:
        'Get workout records for a date range. Accepts ISO 8601 or relative dates ("today", "last 7 days", "this week"). Returns strain, heart rate zones, calories, and sport type.',
      inputSchema: collectionInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: z.infer<typeof collectionInputSchema>) =>
      safeTool(() => getWorkoutCollection(client, args))
  );

  // -------------------------------------------------------------------------
  // Tool 6: get_cycle_collection
  // -------------------------------------------------------------------------
  registerTool(
    "get_cycle_collection",
    {
      description:
        'Get physiological cycles for a date range. Accepts ISO 8601 or relative dates ("today", "last 7 days", "this week"). Returns strain, calories, and heart rate data per cycle.',
      inputSchema: collectionInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: z.infer<typeof collectionInputSchema>) =>
      safeTool(() => getCycleCollection(client, args))
  );

  // -------------------------------------------------------------------------
  // Tool 7: get_sleep_by_id
  // -------------------------------------------------------------------------
  registerTool(
    "get_sleep_by_id",
    {
      description:
        "Get a single sleep record by its ID. Returns sleep stages, duration, respiratory rate, and performance scores.",
      inputSchema: stringIdSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: z.infer<typeof stringIdSchema>) => safeTool(() => getSleepById(client, args.id))
  );

  // -------------------------------------------------------------------------
  // Tool 8: get_workout_by_id
  // -------------------------------------------------------------------------
  registerTool(
    "get_workout_by_id",
    {
      description:
        "Get a single workout record by its ID. Returns strain, heart rate zones, calories, and sport type.",
      inputSchema: stringIdSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: z.infer<typeof stringIdSchema>) => safeTool(() => getWorkoutById(client, args.id))
  );

  // -------------------------------------------------------------------------
  // Tool 9: get_cycle_by_id
  // -------------------------------------------------------------------------
  registerTool(
    "get_cycle_by_id",
    {
      description:
        "Get a single physiological cycle by its ID. Returns strain, calories, and heart rate data.",
      inputSchema: numericIdSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: z.infer<typeof numericIdSchema>) => safeTool(() => getCycleById(client, args.id))
  );

  // -------------------------------------------------------------------------
  // Tool 10: get_weekly_summary
  // -------------------------------------------------------------------------
  registerTool(
    "get_weekly_summary",
    {
      description:
        "Get a summarized health report for a given week — average recovery, HRV, RHR, sleep duration and quality, workout count and strain, plus recovery trend direction.",
      inputSchema: z.object({
        week_start: z
          .string()
          .optional()
          .describe(
            'Start of the week to summarize. Accepts ISO 8601 or relative expressions like "last week", "this week". Defaults to most recent Monday.'
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: { week_start?: string }) => safeTool(() => getWeeklySummary(client, args))
  );

  // -------------------------------------------------------------------------
  // Tool 11: compare_periods
  // -------------------------------------------------------------------------
  registerTool(
    "compare_periods",
    {
      description:
        "Compare health metrics between two time periods — shows improvement or regression in recovery, sleep, and strain.",
      inputSchema: z.object({
        period_a_start: isoDateString.describe("ISO 8601 start of the first period."),
        period_a_end: isoDateString.describe("ISO 8601 end of the first period."),
        period_b_start: isoDateString.describe("ISO 8601 start of the second period."),
        period_b_end: isoDateString.describe("ISO 8601 end of the second period."),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: {
      period_a_start: string;
      period_a_end: string;
      period_b_start: string;
      period_b_end: string;
    }) => safeTool(() => comparePeriods(client, args))
  );

  // -------------------------------------------------------------------------
  // Tool 12: get_trend
  // -------------------------------------------------------------------------
  registerTool(
    "get_trend",
    {
      description:
        "Analyze a health metric trend over time — detects direction (improving/declining/stable), variability, and anomalies using linear regression.",
      inputSchema: z.object({
        metric: z
          .enum(["recovery", "hrv", "rhr", "sleep_duration", "sleep_performance", "strain"])
          .describe("The health metric to analyze."),
        days: z
          .number()
          .int()
          .min(7)
          .max(90)
          .optional()
          .describe("Number of days to analyze (7–90). Default: 30."),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: {
      metric: "recovery" | "hrv" | "rhr" | "sleep_duration" | "sleep_performance" | "strain";
      days?: number;
    }) => safeTool(() => getTrend(client, args))
  );

  // -------------------------------------------------------------------------
  // Tool 13: get_today
  // -------------------------------------------------------------------------
  registerTool(
    "get_today",
    {
      description:
        "Get today's complete health snapshot — recovery score, last night's sleep, current strain, and last workout in one call.",
      annotations: { readOnlyHint: true },
    },
    async () => safeTool(() => getToday(client))
  );

  // -------------------------------------------------------------------------
  // Tool 14: get_calendar
  // -------------------------------------------------------------------------
  registerTool(
    "get_calendar",
    {
      description:
        "Get a day-by-day grid of recovery, sleep, and strain for a date range. Perfect for weekly/monthly overviews.",
      inputSchema: z.object({
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Number of days to show. Default: 7. Max: 90."),
        start: z
          .string()
          .optional()
          .describe(
            "ISO 8601 start date (YYYY-MM-DD). When provided, the calendar grid starts at this date and iterates forward for `days` days, clamped to today."
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: { days?: number; start?: string }) => safeTool(() => getCalendar(client, args))
  );

  // -------------------------------------------------------------------------
  // MCP Resources
  // -------------------------------------------------------------------------
  registerTool(
    "get_baselines",
    {
      description:
        "Personal rolling distributions for HRV, RHR, sleep and recovery. Excludes latest observations from baselines; not medical advice.",
      inputSchema: baselinesInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => safeTool(() => getBaselines(client, args))
  );
  registerTool(
    "get_sleep_debt",
    {
      description:
        "Observed nightly sleep deficits, standing debt and local clock consistency. Deficit sum is not outstanding debt or a recovery prediction.",
      inputSchema: sleepDebtInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => safeTool(() => getSleepDebt(client, args))
  );

  if (!options?.disableResources && privacyMode === "standard") {
    registerResources(server, client);
  }

  // -------------------------------------------------------------------------
  // MCP Prompts
  // -------------------------------------------------------------------------
  if (privacyMode === "standard") registerPrompts(server);

  return { server };
}
