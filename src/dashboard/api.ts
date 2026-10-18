import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { WhoopApiError, WhoopAuthError, WhoopNetworkError } from "../api/client.js";
import { readAuditLog } from "../performance/audit-log.js";
import {
  inputErrorFrom,
  PerformanceInputError,
  type PerformanceDeps,
} from "../performance/context.js";
import { loadPerformanceState, PerformanceStoreError } from "../performance/store.js";
import {
  annotateWorkout,
  annotateWorkoutInputSchema,
  annotateWorkoutOutputSchema,
} from "../tools/annotate-workout.js";
import {
  auditPerformanceData,
  auditPerformanceDataInputSchema,
  auditPerformanceDataOutputSchema,
} from "../tools/audit-performance-data.js";
import {
  getHyroxPerformance,
  hyroxPerformanceInputSchema,
  hyroxPerformanceOutputSchema,
} from "../tools/get-hyrox-performance.js";
import {
  getHyroxSessionReport,
  hyroxSessionReportInputSchema,
  hyroxSessionReportOutputSchema,
} from "../tools/get-hyrox-session-report.js";
import {
  getRaceReadiness,
  raceReadinessInputSchema,
  raceReadinessOutputSchema,
} from "../tools/get-race-readiness.js";
import {
  getTriathlonPerformance,
  triathlonPerformanceInputSchema,
  triathlonPerformanceOutputSchema,
} from "../tools/get-triathlon-performance.js";
import {
  logRaceResult,
  logRaceResultInputSchema,
  logRaceResultOutputSchema,
} from "../tools/log-race-result.js";
import {
  verifyClaim,
  verifyClaimInputSchema,
  verifyClaimOutputSchema,
} from "../tools/verify-claim.js";
import { getToday, todayOutputSchema } from "../tools/get-today.js";
import {
  dashboardHistorySchema,
  dashboardTrainingInputSchema,
  dashboardTrainingSchema,
  getDashboardHistory,
  getDashboardTraining,
} from "./data.js";

export interface DashboardApiOptions {
  client: WhoopClient;
  /** Local store directory; defaults to ~/.whoop-mcp. */
  directory?: string;
  now?: () => Date;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export type DashboardApi = (
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown
) => Promise<ApiResponse>;

interface Route {
  method: "GET" | "POST";
  handle: (raw: unknown, deps: PerformanceDeps) => Promise<unknown>;
}

/** Parses with the tool's input schema, runs it, then checks the tool's output contract. */
function route<Input extends z.ZodType, Output extends z.ZodType>(
  method: Route["method"],
  input: Input,
  output: Output,
  run: (parsed: z.infer<Input>, deps: PerformanceDeps) => Promise<unknown>
): Route {
  return {
    method,
    handle: async (raw, deps) => {
      const result = output.safeParse(await run(input.parse(raw), deps));
      if (!result.success) throw new Error("Output contract violated.");
      return result.data;
    },
  };
}

/** GET query values are strings; these keys are numeric. */
const NUMERIC_QUERY_KEYS = new Set(["limit"]);

function queryObject(query: URLSearchParams): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of query) {
    if (!value) continue;
    result[key] = NUMERIC_QUERY_KEYS.has(key) && /^\d+$/.test(value) ? Number(value) : value;
  }
  return result;
}

function failure(error: unknown): ApiResponse {
  if (error instanceof z.ZodError)
    return { status: 400, body: { error: inputErrorFrom(error).message } };
  if (error instanceof PerformanceInputError || error instanceof RangeError)
    return { status: 400, body: { error: error.message } };
  if (error instanceof PerformanceStoreError)
    return {
      status: error.code === "busy" ? 503 : 500,
      body: {
        error:
          error.code === "partial_write" ? error.message : `${error.message} Nothing was changed.`,
      },
    };
  if (error instanceof WhoopAuthError)
    return { status: 502, body: { error: "WHOOP authentication failed. Run setup --verify." } };
  if (error instanceof WhoopApiError || error instanceof WhoopNetworkError)
    return { status: 502, body: { error: "Could not reach the WHOOP API. Retry later." } };
  return { status: 500, body: { error: "Unexpected error." } };
}

/**
 * JSON API for the local dashboard. Every route reuses the MCP tool function and its Zod
 * input/output schemas, so the dashboard can never show or write something the tools would not.
 */
export function createDashboardApi(options: DashboardApiOptions): DashboardApi {
  const { client, directory } = options;
  const now = (): Date => options.now?.() ?? new Date();
  const write = (): { directory?: string; now: Date; actor: "dashboard" } => ({
    ...(directory ? { directory } : {}),
    now: now(),
    actor: "dashboard",
  });
  const routes: Readonly<Record<string, Route>> = {
    "/api/history": route("GET", z.object({}), dashboardHistorySchema, (_input, deps) =>
      getDashboardHistory(client, deps)
    ),
    "/api/training": route(
      "GET",
      dashboardTrainingInputSchema,
      dashboardTrainingSchema,
      (input, deps) => getDashboardTraining(client, input, deps)
    ),
    "/api/today": route("GET", z.object({}), todayOutputSchema, (_input, deps) =>
      getToday(client, deps.now)
    ),
    "/api/session-report": route(
      "GET",
      hyroxSessionReportInputSchema,
      hyroxSessionReportOutputSchema,
      (input, deps) => getHyroxSessionReport(client, input, deps)
    ),
    "/api/hyrox": route(
      "GET",
      hyroxPerformanceInputSchema,
      hyroxPerformanceOutputSchema,
      (input, deps) => getHyroxPerformance(client, input, deps)
    ),
    "/api/triathlon": route(
      "GET",
      triathlonPerformanceInputSchema,
      triathlonPerformanceOutputSchema,
      (input, deps) => getTriathlonPerformance(client, input, deps)
    ),
    "/api/readiness": route(
      "GET",
      raceReadinessInputSchema,
      raceReadinessOutputSchema,
      (input, deps) => getRaceReadiness(client, input, deps)
    ),
    "/api/audit": route(
      "GET",
      auditPerformanceDataInputSchema,
      auditPerformanceDataOutputSchema,
      (input, deps) => auditPerformanceData(client, input, deps)
    ),
    "/api/verify-claim": route(
      "POST",
      verifyClaimInputSchema,
      verifyClaimOutputSchema,
      (input, deps) => verifyClaim(client, input, deps)
    ),
    "/api/annotate": route(
      "POST",
      annotateWorkoutInputSchema,
      annotateWorkoutOutputSchema,
      (input) => annotateWorkout(input, write())
    ),
    "/api/race-result": route(
      "POST",
      logRaceResultInputSchema,
      logRaceResultOutputSchema,
      (input) => logRaceResult(input, write())
    ),
  };

  return async (method, path, query, body) => {
    const match = Object.hasOwn(routes, path) ? routes[path] : undefined;
    if (!match) return { status: 404, body: { error: "Not found." } };
    if (match.method !== method) return { status: 405, body: { error: "Method not allowed." } };
    try {
      const deps: PerformanceDeps = {
        now: now(),
        loadState: () => loadPerformanceState(directory),
        readAudit: (limit) => readAuditLog(directory, { limit }),
      };
      const raw = method === "GET" ? queryObject(query) : body;
      return { status: 200, body: await match.handle(raw, deps) };
    } catch (error: unknown) {
      return failure(error);
    }
  };
}
