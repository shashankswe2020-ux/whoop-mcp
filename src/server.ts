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
import type { Telemetry } from "./telemetry/telemetry.js";
import {
  hyroxSessionReportInputSchema,
  getHyroxSessionReport,
} from "./tools/get-hyrox-session-report.js";
import { getHyroxPerformance, hyroxPerformanceInputSchema } from "./tools/get-hyrox-performance.js";
import {
  getTriathlonPerformance,
  triathlonPerformanceInputSchema,
} from "./tools/get-triathlon-performance.js";
import { getRaceReadiness, raceReadinessInputSchema } from "./tools/get-race-readiness.js";
import {
  auditPerformanceData,
  auditPerformanceDataInputSchema,
} from "./tools/audit-performance-data.js";
import { verifyClaim, verifyClaimInputSchema } from "./tools/verify-claim.js";
import { logRaceResult, logRaceResultInputSchema } from "./tools/log-race-result.js";
import { annotateWorkout, annotateWorkoutInputSchema } from "./tools/annotate-workout.js";
import {
  createDashboardController,
  openPerformanceDashboardInputSchema,
} from "./tools/open-performance-dashboard.js";
import {
  PerformanceInputError,
  type PerformanceDeps,
  type PerformanceWriteDeps,
} from "./performance/context.js";
import { loadPerformanceState, PerformanceStoreError } from "./performance/store.js";
import { readAuditLog } from "./performance/audit-log.js";
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
  } else if (error instanceof PerformanceInputError) {
    message = `Invalid input: ${error.message}`;
  } else if (error instanceof PerformanceStoreError) {
    message = `Local performance data error: ${error.message} Nothing was changed.`;
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

type ToolErrorCategory =
  | "api_auth"
  | "api_rate_limit"
  | "api_client"
  | "api_server"
  | "network"
  | "invalid_data"
  | "output_contract"
  | "unexpected";

interface ToolExecution {
  response: CallToolResult;
  errorCategory?: ToolErrorCategory;
}

function classifyToolError(error: unknown): ToolErrorCategory {
  if (error instanceof WhoopAuthError) return "api_auth";
  if (error instanceof WhoopApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) return "api_auth";
    if (error.statusCode === 429) return "api_rate_limit";
    return error.statusCode >= 500 ? "api_server" : "api_client";
  }
  if (error instanceof WhoopNetworkError) return "network";
  if (
    error instanceof z.ZodError ||
    error instanceof RangeError ||
    error instanceof PerformanceInputError
  )
    return "invalid_data";
  return "unexpected";
}

/** Wrap a tool handler with error-to-MCP-error conversion */
async function safeTool<T>(fn: () => Promise<T>): Promise<ToolExecution> {
  try {
    return { response: jsonContent(await fn()) };
  } catch (error: unknown) {
    return { response: errorResponse(error), errorCategory: classifyToolError(error) };
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/** Options for createWhoopServer */
export interface CreateServerOptions {
  privacyMode?: PrivacyMode;
  telemetry?: Pick<Telemetry, "record">;
  /** Disable MCP resource registration (set via WHOOP_MCP_DISABLE_RESOURCES=1) */
  disableResources?: boolean;
  /**
   * Local (stdio) mode only: enables the on-disk race log, annotations and audit log plus the
   * write tools. Omit for remote transports, where the analytics tools run on WHOOP data alone.
   */
  localPerformance?: {
    directory?: string;
    /** Test seam; defaults to the system browser. */
    openBrowser?: (url: string) => void;
    /** Test seam; defaults to the bundled dashboard assets. */
    dashboardStaticDir?: string;
  };
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
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolExecution>
  ): void {
    const schema = (privacyMode === "aggregate" ? aggregateOutputSchemas : outputSchemas)[name];
    if (!schema) {
      if (privacyMode === "aggregate") return;
      throw new Error("Missing tool output contract.");
    }
    server.registerTool(
      name,
      {
        ...config,
        inputSchema: config.inputSchema ?? z.object({}),
        outputSchema: schema,
        annotations: {
          title: name
            .split("_")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" "),
          ...config.annotations,
        },
      },
      async (args) => {
        let outcome: "success" | "error" = "error";
        let errorCategory: ToolErrorCategory | undefined;
        try {
          const execution = await handler(args as z.infer<z.ZodObject<Shape>>);
          const result = execution.response;
          if (result.isError) {
            errorCategory = execution.errorCategory ?? "unexpected";
            return result;
          }
          const validated = schema.safeParse(result.structuredContent);
          if (!validated.success) {
            errorCategory = "output_contract";
            return {
              isError: true,
              content: [
                { type: "text", text: "WHOOP data did not match the expected output contract." },
              ],
            };
          }
          const response = jsonContent(
            privacyMode === "aggregate" ? projectAggregateDates(validated.data) : validated.data
          );
          outcome = "success";
          return response;
        } finally {
          if (privacyMode === "standard") {
            void Promise.resolve()
              .then(() =>
                options?.telemetry?.record({
                  kind: "tool",
                  name,
                  outcome,
                  ...(errorCategory ? { error_category: errorCategory } : {}),
                })
              )
              .catch(() => {});
          }
        }
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

  // -------------------------------------------------------------------------
  // Hybrid race performance (HYROX + triathlon)
  // -------------------------------------------------------------------------
  const local = options?.localPerformance;
  const performanceDeps = (): PerformanceDeps =>
    local
      ? {
          loadState: () => loadPerformanceState(local.directory),
          readAudit: (limit) => readAuditLog(local.directory, { limit }),
        }
      : {};
  const raceCaveat =
    " Derived from WHOOP heart-rate data plus your local corrections; check `data_quality` and caveats. Not medical advice.";

  registerTool(
    "get_hyrox_session_report",
    {
      description:
        "Breaks one HYROX-style session (chained runs + ergs) into segments with HR, strain, transitions, deterministic insights and 'before you trust these numbers' caveats. Defaults to the most recent workout day in the last 7 days." +
        raceCaveat,
      inputSchema: hyroxSessionReportInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => safeTool(() => getHyroxSessionReport(client, args, performanceDeps()))
  );
  registerTool(
    "get_hyrox_performance",
    {
      description:
        "HYROX training load by week, logged race results, station strengths/weaknesses and PRs. Unconfirmed Functional Fitness/HIIT sessions are listed as candidates, never counted." +
        raceCaveat,
      inputSchema: hyroxPerformanceInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => safeTool(() => getHyroxPerformance(client, args, performanceDeps()))
  );
  registerTool(
    "get_triathlon_performance",
    {
      description:
        "Swim/bike/run volume, distance, zone mix, discipline balance, bricks and logged triathlon results by week." +
        raceCaveat,
      inputSchema: triathlonPerformanceInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => safeTool(() => getTriathlonPerformance(client, args, performanceDeps()))
  );
  registerTool(
    "get_race_readiness",
    {
      description:
        "Readiness for a HYROX or triathlon race from activity logs: fitness/fatigue/form (TRIMP), load spike, discipline balance, taper, today's recovery and sleep debt. Every component shows its inputs and rule." +
        raceCaveat,
      inputSchema: raceReadinessInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => safeTool(() => getRaceReadiness(client, args, performanceDeps()))
  );
  registerTool(
    "audit_performance_data",
    {
      description:
        "Lists what could make the performance numbers wrong: suspect workouts (bad HR, GPS drift, mislabelled segments, overlaps), unconfirmed HYROX candidates, your relabels/exclusions and the append-only audit log.",
      inputSchema: auditPerformanceDataInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => safeTool(() => auditPerformanceData(client, args, performanceDeps()))
  );
  registerTool(
    "verify_claim",
    {
      description:
        "Fact-checks a number an assistant stated (e.g. 'bike was 40% of training') by recomputing it from WHOOP data. Returns confirmed, contradicted or unverifiable with the tolerance and the workout ids used.",
      inputSchema: verifyClaimInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => safeTool(() => verifyClaim(client, args, performanceDeps()))
  );

  if (local) {
    const writeDeps: PerformanceWriteDeps = { directory: local.directory, actor: "mcp_tool" };
    registerTool(
      "log_race_result",
      {
        description:
          "Saves an official HYROX or triathlon result (total, optional splits) to the local race log (~/.whoop-mcp, 0600). Validates station order and split sums; every save is recorded in the audit log.",
        inputSchema: logRaceResultInputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async (args) => safeTool(() => logRaceResult(args, writeDeps))
    );
    registerTool(
      "annotate_workout",
      {
        description:
          "Corrects how a WHOOP workout is counted: relabel its discipline (e.g. confirm a HYROX sim), exclude it, or restore it. WHOOP data is never changed; each change appends an audit entry with before/after.",
        inputSchema: annotateWorkoutInputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async (args) => safeTool(() => annotateWorkout(args, writeDeps))
    );
    const dashboard = createDashboardController({
      client,
      ...(local.directory ? { directory: local.directory } : {}),
      ...(local.openBrowser ? { openBrowser: local.openBrowser } : {}),
      ...(local.dashboardStaticDir ? { staticDir: local.dashboardStaticDir } : {}),
    });
    registerTool(
      "open_performance_dashboard",
      {
        description:
          "Opens the local HYROX/triathlon dashboard (127.0.0.1 only) in the browser: session report, trends, readiness with evidence, and an audit tab to relabel/exclude workouts and check claims. Returns the URL; the server stops after 30 idle minutes.",
        inputSchema: openPerformanceDashboardInputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async (args) => safeTool(() => dashboard.open(args))
    );
  }

  if (!options?.disableResources && privacyMode === "standard") {
    registerResources(server, client);
  }

  // -------------------------------------------------------------------------
  // MCP Prompts
  // -------------------------------------------------------------------------
  if (privacyMode === "standard") registerPrompts(server, options?.telemetry);

  return { server };
}
