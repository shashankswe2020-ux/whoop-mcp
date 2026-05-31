/**
 * Tool: get_weekly_summary
 *
 * Fetches recovery, sleep, workout, and cycle data for a 7-day period
 * and returns computed aggregates including averages, totals, and trends.
 *
 * Uses fetchAllPages with serialized endpoint calls to respect rate limits.
 * Filters unscored records. Returns partial results with warnings if some
 * endpoints fail; throws only if ALL 4 endpoints fail.
 */

import type { WhoopClient } from "../api/client.js";
import { fetchAllPages } from "../api/pagination.js";
import {
  ENDPOINT_RECOVERY,
  ENDPOINT_SLEEP,
  ENDPOINT_WORKOUT,
  ENDPOINT_CYCLE,
} from "../api/endpoints.js";
import type { Recovery, Sleep, Workout, Cycle } from "../api/types.js";
import { resolveDateExpression } from "./date-utils.js";
import { mean, linearRegression, trendDirection } from "./stats-utils.js";
import type { TrendDirectionResult } from "./stats-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input parameters for get_weekly_summary */
export interface WeeklySummaryParams {
  /** ISO 8601 start of week, or date expression. Defaults to most recent Monday. */
  week_start?: string;
}

/** Output shape for get_weekly_summary */
export interface WeeklySummary {
  week_start: string;
  week_end: string;
  recovery: {
    average_score: number;
    min_score: number;
    max_score: number;
    average_hrv: number;
    average_rhr: number;
    trend: TrendDirectionResult;
  };
  sleep: {
    average_duration_hours: number;
    average_performance_pct: number;
    average_efficiency_pct: number;
  };
  workouts: {
    count: number;
    total_strain: number;
    total_calories_kj: number;
    sport_breakdown: Record<string, number>;
  };
  strain: {
    average_daily_strain: number;
    max_daily_strain: number;
  };
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the Monday of the week containing the given date (ISO week, UTC) */
function getMondayUTC(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

/** Get end-of-day Sunday for a given Monday */
function getSundayEndUTC(monday: Date): Date {
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return new Date(
    Date.UTC(sunday.getUTCFullYear(), sunday.getUTCMonth(), sunday.getUTCDate(), 23, 59, 59, 999)
  );
}

/** Build a query string with start/end params and limit=25 */
function buildWeekQuery(start: string, end: string): string {
  const params = new URLSearchParams();
  params.set("start", start);
  params.set("end", end);
  params.set("limit", "25");
  return `?${params.toString()}`;
}

/** Resolve week_start parameter to a start/end ISO range */
function resolveWeekRange(weekStart?: string): { start: string; end: string } {
  if (weekStart) {
    const resolved = resolveDateExpression(weekStart);
    // Use resolved.start as the Monday reference
    const monday = new Date(resolved.start);
    const sundayEnd = getSundayEndUTC(monday);
    return {
      start: resolved.start,
      end: sundayEnd.toISOString(),
    };
  }

  // Default: current week (Monday to Sunday)
  const now = new Date();
  const monday = getMondayUTC(now);
  const sundayEnd = getSundayEndUTC(monday);
  return {
    start: monday.toISOString(),
    end: sundayEnd.toISOString(),
  };
}

/** Safely fetch an endpoint, returning records or null on failure */
async function safeFetch<T>(
  client: WhoopClient,
  endpoint: string,
  query: string
): Promise<{ records: T[]; error?: undefined } | { records?: undefined; error: string }> {
  try {
    const result = await fetchAllPages<T>(client, `${endpoint}${query}`, {
      maxRecords: 50,
      maxPages: 5,
      interPageDelayMs: 0, // Delay handled by serialization
    });
    return { records: result.records };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { error: message };
  }
}

/** Compute sleep duration in hours from start/end timestamps */
function sleepDurationHours(sleep: Sleep): number {
  const startMs = new Date(sleep.start).getTime();
  const endMs = new Date(sleep.end).getTime();
  return (endMs - startMs) / (1000 * 60 * 60);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Get a summarized health report for a given week.
 *
 * Fetches recovery, sleep, workout, and cycle data, then computes:
 * - Average/min/max recovery score, HRV, RHR
 * - Recovery trend (improving/declining/stable)
 * - Average sleep duration, performance, efficiency
 * - Workout count, total strain, calories, sport breakdown
 * - Average and max daily strain
 *
 * Returns partial results with warnings if 1-3 endpoints fail.
 * Throws if ALL 4 endpoints fail.
 */
export async function getWeeklySummary(
  client: WhoopClient,
  params: WeeklySummaryParams
): Promise<WeeklySummary> {
  const { start, end } = resolveWeekRange(params.week_start);
  const query = buildWeekQuery(start, end);

  // Serialize endpoint calls (not parallel) to respect rate limits
  const recoveryResult = await safeFetch<Recovery>(client, ENDPOINT_RECOVERY, query);
  const sleepResult = await safeFetch<Sleep>(client, ENDPOINT_SLEEP, query);
  const workoutResult = await safeFetch<Workout>(client, ENDPOINT_WORKOUT, query);
  const cycleResult = await safeFetch<Cycle>(client, ENDPOINT_CYCLE, query);

  // Check if all endpoints failed
  const warnings: string[] = [];
  if (recoveryResult.error) warnings.push(`recovery: ${recoveryResult.error}`);
  if (sleepResult.error) warnings.push(`sleep: ${sleepResult.error}`);
  if (workoutResult.error) warnings.push(`workout: ${workoutResult.error}`);
  if (cycleResult.error) warnings.push(`cycle: ${cycleResult.error}`);

  if (warnings.length === 4) {
    throw new Error(`All endpoints failed: ${warnings.join("; ")}`);
  }

  // --- Recovery aggregation ---
  const scoredRecoveries = (recoveryResult.records ?? []).filter(
    (r) => r.score_state === "SCORED" && r.score
  );
  const recoveryScores = scoredRecoveries.map((r) => r.score!.recovery_score);
  const hrvValues = scoredRecoveries.map((r) => r.score!.hrv_rmssd_milli);
  const rhrValues = scoredRecoveries.map((r) => r.score!.resting_heart_rate);

  let recoveryTrend: TrendDirectionResult = "stable";
  if (recoveryScores.length >= 2) {
    const reg = linearRegression(recoveryScores);
    recoveryTrend = trendDirection(reg.slope, reg.r2);
  }

  const recovery = {
    average_score: recoveryScores.length > 0 ? mean(recoveryScores) : 0,
    min_score: recoveryScores.length > 0 ? Math.min(...recoveryScores) : 0,
    max_score: recoveryScores.length > 0 ? Math.max(...recoveryScores) : 0,
    average_hrv: hrvValues.length > 0 ? mean(hrvValues) : 0,
    average_rhr: rhrValues.length > 0 ? mean(rhrValues) : 0,
    trend: recoveryTrend,
  };

  // --- Sleep aggregation (exclude naps) ---
  const scoredSleeps = (sleepResult.records ?? []).filter(
    (s) => s.score_state === "SCORED" && s.score && !s.nap
  );
  const sleepDurations = scoredSleeps.map(sleepDurationHours);
  const sleepPerformances = scoredSleeps
    .map((s) => s.score!.sleep_performance_percentage)
    .filter((v): v is number => v !== undefined);
  const sleepEfficiencies = scoredSleeps
    .map((s) => s.score!.sleep_efficiency_percentage)
    .filter((v): v is number => v !== undefined);

  const sleep = {
    average_duration_hours: sleepDurations.length > 0 ? mean(sleepDurations) : 0,
    average_performance_pct: sleepPerformances.length > 0 ? mean(sleepPerformances) : 0,
    average_efficiency_pct: sleepEfficiencies.length > 0 ? mean(sleepEfficiencies) : 0,
  };

  // --- Workout aggregation ---
  const scoredWorkouts = (workoutResult.records ?? []).filter(
    (w) => w.score_state === "SCORED" && w.score
  );
  const sportBreakdown: Record<string, number> = {};
  let totalStrain = 0;
  let totalCaloriesKj = 0;

  for (const w of scoredWorkouts) {
    totalStrain += w.score!.strain;
    totalCaloriesKj += w.score!.kilojoule;
    sportBreakdown[w.sport_name] = (sportBreakdown[w.sport_name] ?? 0) + 1;
  }

  const workouts = {
    count: scoredWorkouts.length,
    total_strain: totalStrain,
    total_calories_kj: totalCaloriesKj,
    sport_breakdown: sportBreakdown,
  };

  // --- Cycle/Strain aggregation ---
  const scoredCycles = (cycleResult.records ?? []).filter(
    (c) => c.score_state === "SCORED" && c.score
  );
  const strainValues = scoredCycles.map((c) => c.score!.strain);

  const strain = {
    average_daily_strain: strainValues.length > 0 ? mean(strainValues) : 0,
    max_daily_strain: strainValues.length > 0 ? Math.max(...strainValues) : 0,
  };

  // --- Build result ---
  const result: WeeklySummary = {
    week_start: start,
    week_end: end,
    recovery,
    sleep,
    workouts,
    strain,
  };

  if (warnings.length > 0) {
    result.warnings = warnings;
  }

  return result;
}
