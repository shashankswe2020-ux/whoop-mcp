import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { WhoopNetworkError } from "../api/client.js";
import { ENDPOINT_RECOVERY, ENDPOINT_SLEEP, ENDPOINT_WORKOUT } from "../api/endpoints.js";
import {
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import type { Workout } from "../api/types.js";
import {
  asleepHours,
  DAY_MS,
  loadAnalyticsSource,
  localDay,
  type SourceQuality,
} from "../tools/analytics-utils.js";
import { emptyPerformanceState, type PerformanceState } from "./schemas.js";
import type { TrainingSession } from "./session-grouping.js";
import { resolveDiscipline, type ResolvedDiscipline } from "./sport-classifier.js";
import type { AuditLogPage } from "./audit-log.js";
import { PerformanceStoreError } from "./store.js";

export const KJ_PER_KCAL = 4.184;

/** Injected by the server: stdio mode passes loaders, remote (HTTP) mode passes none. */
export interface PerformanceDeps {
  now?: Date;
  loadState?: () => Promise<PerformanceState>;
  readAudit?: (limit: number) => Promise<AuditLogPage>;
}

export type { AuditLogPage };

/** Local write context. `directory` defaults to ~/.whoop-mcp. */
export interface PerformanceWriteDeps {
  directory?: string;
  now?: Date;
  actor?: "mcp_tool" | "dashboard";
}

/** A validation failure whose message is safe and useful to show to the user verbatim. */
export class PerformanceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerformanceInputError";
  }
}

export function inputErrorFrom(error: z.ZodError): PerformanceInputError {
  return new PerformanceInputError(
    error.issues
      .map((issue) => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
      .join("; ")
  );
}

export const candidateSchema = z.object({
  start: z.string(),
  kind: z.enum(["session", "workout"]),
  reason: z.string(),
  workout_ids: z.array(z.string()),
});
export type Candidate = z.infer<typeof candidateSchema>;

/** Confirmed = any segment resolves to "hyrox" (user relabel or rule). Never auto-confirmed. */
export function classifySessions(
  sessions: TrainingSession[],
  disciplineOf: (workout: Workout) => ResolvedDiscipline
): { confirmed: TrainingSession[]; candidates: Candidate[] } {
  const confirmed: TrainingSession[] = [];
  const candidates: Candidate[] = [];
  for (const session of sessions) {
    const disciplines = session.segments.map((segment) => disciplineOf(segment.workout));
    const ids = session.segments.map((segment) => segment.workout.id);
    if (disciplines.includes("hyrox")) confirmed.push(session);
    else if (session.kind === "hyrox_candidate")
      candidates.push({
        start: session.start,
        kind: "session",
        reason: "Chain of ≥ 2 runs plus an erg or functional segment, not yet confirmed as HYROX.",
        workout_ids: ids,
      });
    else if (disciplines.includes("hyrox_candidate"))
      candidates.push({
        start: session.start,
        kind: "workout",
        reason: "Functional Fitness / HIIT / OCR workout that may be HYROX training.",
        workout_ids: ids.filter((_, index) => disciplines[index] === "hyrox_candidate"),
      });
  }
  return { confirmed, candidates };
}

export const storeStatusSchema = z.object({
  status: z.enum(["available", "not_configured", "error"]),
  message: z.string().nullable(),
});
export type StoreStatus = z.infer<typeof storeStatusSchema>;

export const isoDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Never throws: a missing or broken local store degrades to WHOOP-only results. */
export async function readPerformanceState(
  loadState: PerformanceDeps["loadState"]
): Promise<{ state: PerformanceState; store: StoreStatus }> {
  if (!loadState)
    return {
      state: emptyPerformanceState(),
      store: {
        status: "not_configured",
        message:
          "Race logs, annotations and rules are stored locally and are not available in this mode.",
      },
    };
  try {
    return { state: await loadState(), store: { status: "available", message: null } };
  } catch (error: unknown) {
    return {
      state: emptyPerformanceState(),
      store: {
        status: "error",
        message:
          error instanceof PerformanceStoreError
            ? error.message
            : "Local performance data could not be read.",
      },
    };
  }
}

export function disciplineResolver(
  state: PerformanceState
): (workout: Workout) => ResolvedDiscipline {
  return (workout) =>
    resolveDiscipline(workout, {
      annotation: state.annotations[workout.id],
      rules: state.rules,
    }).discipline;
}

export async function loadWorkouts(
  client: WhoopClient,
  period: { start: string; end: string }
): Promise<{ records: Workout[]; quality: SourceQuality }> {
  const source = await loadAnalyticsSource(client, ENDPOINT_WORKOUT, period, workoutRecordSchema);
  if (source.quality.status === "fetch_failed")
    throw new WhoopNetworkError("Workout source unavailable");
  const records: Workout[] = source.records;
  source.quality.records_used = records.length;
  if (records.length) source.quality.status = "available";
  return { records, quality: source.quality };
}

export interface WellnessDay {
  date: string;
  recovery_score: number | null;
  hrv_rmssd_milli: number | null;
  resting_heart_rate: number | null;
  spo2_pct: number | null;
  user_calibrating: boolean;
  sleep_hours: number | null;
  sleep_performance_pct: number | null;
  respiratory_rate: number | null;
  standing_sleep_debt_hours: number | null;
}

/**
 * One row per local wake-up day: the main (non-nap) scored sleep joined to its recovery by
 * `sleep_id`. Fetch failures are reported in quality, never thrown.
 */
export async function loadWellness(
  client: WhoopClient,
  period: { start: string; end: string }
): Promise<{ days: WellnessDay[]; sources: Record<string, SourceQuality> }> {
  const [sleep, recovery] = await Promise.all([
    loadAnalyticsSource(client, ENDPOINT_SLEEP, period, sleepRecordSchema),
    loadAnalyticsSource(client, ENDPOINT_RECOVERY, period, recoveryRecordSchema),
  ]);
  const recoveryBySleep = new Map(recovery.records.map((record) => [record.sleep_id, record]));
  const byDay = new Map<string, WellnessDay>();
  for (const night of sleep.records) {
    if (night.nap || night.score_state !== "SCORED" || !night.score) continue;
    const date = localDay(night.end, night.timezone_offset);
    const existing = byDay.get(date);
    if (existing && (existing.sleep_hours ?? 0) >= asleepHours(night)) continue;
    const score = recoveryBySleep.get(night.id)?.score;
    byDay.set(date, {
      date,
      recovery_score: score?.recovery_score ?? null,
      hrv_rmssd_milli: score?.hrv_rmssd_milli ?? null,
      resting_heart_rate: score?.resting_heart_rate ?? null,
      spo2_pct: score?.spo2_percentage ?? null,
      user_calibrating: score?.user_calibrating ?? false,
      sleep_hours: asleepHours(night),
      sleep_performance_pct: night.score.sleep_performance_percentage ?? null,
      respiratory_rate: night.score.respiratory_rate ?? null,
      standing_sleep_debt_hours: night.score.sleep_needed.need_from_sleep_debt_milli / 3_600_000,
    });
  }
  for (const quality of [sleep.quality, recovery.quality])
    if (quality.status === "missing" && quality.records_fetched) quality.status = "available";
  sleep.quality.records_used = byDay.size;
  recovery.quality.records_used = [...byDay.values()].filter(
    (day) => day.recovery_score !== null
  ).length;
  return {
    days: [...byDay.values()].sort((left, right) => left.date.localeCompare(right.date)),
    sources: { sleep: sleep.quality, recovery: recovery.quality },
  };
}

export function baselineMean(
  days: WellnessDay[],
  before: string,
  pick: (day: WellnessDay) => number | null,
  windowDays = 30
): { mean: number | null; count: number } {
  const earliest = shiftDay(before, -windowDays);
  const values = days
    .filter((day) => day.date < before && day.date >= earliest && !day.user_calibrating)
    .map(pick)
    .filter((value): value is number => value !== null);
  return {
    mean: values.length ? values.reduce((total, value) => total + value, 0) / values.length : null,
    count: values.length,
  };
}

export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Monday of the ISO week containing `day`. */
export function weekStart(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return shiftDay(day, -((weekday + 6) % 7));
}

export function durationSeconds(workout: Workout): number {
  return (Date.parse(workout.end) - Date.parse(workout.start)) / 1000;
}

export function workoutDay(workout: Workout): string {
  return localDay(workout.start, workout.timezone_offset);
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Resolves an optional `start`/`end` pair (YYYY-MM-DD or ISO datetime) with a default length. */
export function resolveWindow(
  params: { start?: string; end?: string },
  now: Date,
  defaultDays: number,
  maxDays: number
): { start: string; end: string } {
  const endTime = params.end ? Date.parse(params.end) : now.getTime();
  const startTime = params.start ? Date.parse(params.start) : endTime - defaultDays * DAY_MS;
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime)
    throw new RangeError("start must be a valid date before end.");
  if (endTime - startTime > maxDays * DAY_MS)
    throw new RangeError(`The window can be at most ${maxDays} days.`);
  return {
    start: new Date(startTime).toISOString(),
    end: new Date(Math.min(endTime, now.getTime())).toISOString(),
  };
}

export const windowInputShape = {
  start: z
    .string()
    .max(40)
    .refine((value) => Number.isFinite(Date.parse(value)), "Use YYYY-MM-DD or ISO 8601")
    .optional()
    .describe("Window start (YYYY-MM-DD or ISO 8601)."),
  end: z
    .string()
    .max(40)
    .refine((value) => Number.isFinite(Date.parse(value)), "Use YYYY-MM-DD or ISO 8601")
    .optional()
    .describe("Window end (YYYY-MM-DD or ISO 8601). Defaults to now."),
};
