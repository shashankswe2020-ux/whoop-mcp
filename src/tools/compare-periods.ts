/**
 * Tool: compare_periods
 *
 * Compares health metrics between two time periods — shows improvement
 * or regression in recovery, sleep, and strain.
 *
 * Fetches recovery, sleep, cycle for both periods (serialized pagination).
 * Normalizes per-day when periods have different lengths.
 * Uses ±5% threshold for "unchanged" determination.
 */

import type { WhoopClient } from "../api/client.js";
import { fetchAllPages } from "../api/pagination.js";
import { ENDPOINT_RECOVERY, ENDPOINT_SLEEP, ENDPOINT_CYCLE } from "../api/endpoints.js";
import type { Recovery, Sleep, Cycle } from "../api/types.js";
import { validateDateRange, InvalidDateExpression } from "./date-utils.js";
import { mean } from "./stats-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input parameters for compare_periods */
export interface ComparePeriodsParams {
  period_a_start: string;
  period_a_end: string;
  period_b_start: string;
  period_b_end: string;
}

/** Direction for recovery and sleep (higher = better) */
export type HealthDirection = "improved" | "declined" | "unchanged";

/** Direction for strain (neutral — just tracks change) */
export type StrainDirection = "increased" | "decreased" | "unchanged";

/** Output shape for compare_periods */
export interface PeriodComparison {
  period_a: { start: string; end: string; days: number };
  period_b: { start: string; end: string; days: number };
  recovery: {
    period_a_avg: number;
    period_b_avg: number;
    change_pct: number;
    direction: HealthDirection;
  };
  sleep: {
    period_a_avg_hours: number;
    period_b_avg_hours: number;
    change_pct: number;
    direction: HealthDirection;
  };
  strain: {
    period_a_avg: number;
    period_b_avg: number;
    change_pct: number;
    direction: StrainDirection;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed period length in days */
const MAX_PERIOD_DAYS = 90;

/** Threshold for "unchanged" determination (±5%) */
const UNCHANGED_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Calculate days between two ISO dates */
function daysBetween(start: string, end: string): number {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return (endMs - startMs) / (1000 * 60 * 60 * 24);
}

/** Check if two periods overlap */
function periodsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const aStartMs = new Date(aStart).getTime();
  const aEndMs = new Date(aEnd).getTime();
  const bStartMs = new Date(bStart).getTime();
  const bEndMs = new Date(bEnd).getTime();
  return aStartMs < bEndMs && bStartMs < aEndMs;
}

/** Build query string with start/end and limit */
function buildQuery(start: string, end: string): string {
  const params = new URLSearchParams();
  params.set("start", start);
  params.set("end", end);
  params.set("limit", "25");
  return `?${params.toString()}`;
}

/** Safely fetch all pages from an endpoint */
async function fetchRecords<T>(client: WhoopClient, endpoint: string, query: string): Promise<T[]> {
  const result = await fetchAllPages<T>(client, `${endpoint}${query}`, {
    maxRecords: 100,
    maxPages: 10,
    interPageDelayMs: 0,
  });
  return result.records;
}

/** Compute sleep duration in hours from start/end */
function sleepDurationHours(sleep: Sleep): number {
  const startMs = new Date(sleep.start).getTime();
  const endMs = new Date(sleep.end).getTime();
  return (endMs - startMs) / (1000 * 60 * 60);
}

/** Compute percentage change between two values */
function percentChange(oldVal: number, newVal: number): number {
  if (oldVal === 0) {
    return newVal === 0 ? 0 : 100;
  }
  return ((newVal - oldVal) / Math.abs(oldVal)) * 100;
}

/** Determine health direction (higher = better) */
function healthDirection(changePct: number): HealthDirection {
  if (Math.abs(changePct) <= UNCHANGED_THRESHOLD) return "unchanged";
  return changePct > 0 ? "improved" : "declined";
}

/** Determine strain direction (neutral tracking) */
function strainDirection(changePct: number): StrainDirection {
  if (Math.abs(changePct) <= UNCHANGED_THRESHOLD) return "unchanged";
  return changePct > 0 ? "increased" : "decreased";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Compare health metrics between two time periods.
 *
 * Fetches recovery, sleep, and cycle data for both periods.
 * Returns per-day averages and percentage changes.
 *
 * @throws InvalidDateExpression if periods exceed 90 days or overlap
 */
export async function comparePeriods(
  client: WhoopClient,
  params: ComparePeriodsParams
): Promise<PeriodComparison> {
  const { period_a_start, period_a_end, period_b_start, period_b_end } = params;

  // Validate period lengths (max 90 days each)
  validateDateRange(period_a_start, period_a_end, MAX_PERIOD_DAYS);
  validateDateRange(period_b_start, period_b_end, MAX_PERIOD_DAYS);

  // Reject overlapping periods
  if (periodsOverlap(period_a_start, period_a_end, period_b_start, period_b_end)) {
    throw new InvalidDateExpression(
      "Periods overlap. Provide two non-overlapping time ranges for comparison."
    );
  }

  const queryA = buildQuery(period_a_start, period_a_end);
  const queryB = buildQuery(period_b_start, period_b_end);

  // Fetch data for period A (serialized)
  const recoveryA = await fetchRecords<Recovery>(client, ENDPOINT_RECOVERY, queryA);
  const sleepA = await fetchRecords<Sleep>(client, ENDPOINT_SLEEP, queryA);
  const cycleA = await fetchRecords<Cycle>(client, ENDPOINT_CYCLE, queryA);

  // Fetch data for period B (serialized)
  const recoveryB = await fetchRecords<Recovery>(client, ENDPOINT_RECOVERY, queryB);
  const sleepB = await fetchRecords<Sleep>(client, ENDPOINT_SLEEP, queryB);
  const cycleB = await fetchRecords<Cycle>(client, ENDPOINT_CYCLE, queryB);

  // --- Recovery comparison ---
  const scoredRecoveryA = recoveryA.filter((r) => r.score_state === "SCORED" && r.score);
  const scoredRecoveryB = recoveryB.filter((r) => r.score_state === "SCORED" && r.score);

  const recoveryAvgA =
    scoredRecoveryA.length > 0 ? mean(scoredRecoveryA.map((r) => r.score!.recovery_score)) : 0;
  const recoveryAvgB =
    scoredRecoveryB.length > 0 ? mean(scoredRecoveryB.map((r) => r.score!.recovery_score)) : 0;

  const recoveryChange = percentChange(recoveryAvgA, recoveryAvgB);

  // --- Sleep comparison (exclude naps, avg duration) ---
  const scoredSleepA = sleepA.filter((s) => s.score_state === "SCORED" && s.score && !s.nap);
  const scoredSleepB = sleepB.filter((s) => s.score_state === "SCORED" && s.score && !s.nap);

  const sleepAvgA = scoredSleepA.length > 0 ? mean(scoredSleepA.map(sleepDurationHours)) : 0;
  const sleepAvgB = scoredSleepB.length > 0 ? mean(scoredSleepB.map(sleepDurationHours)) : 0;

  const sleepChange = percentChange(sleepAvgA, sleepAvgB);

  // --- Strain comparison ---
  const scoredCycleA = cycleA.filter((c) => c.score_state === "SCORED" && c.score);
  const scoredCycleB = cycleB.filter((c) => c.score_state === "SCORED" && c.score);

  const strainAvgA = scoredCycleA.length > 0 ? mean(scoredCycleA.map((c) => c.score!.strain)) : 0;
  const strainAvgB = scoredCycleB.length > 0 ? mean(scoredCycleB.map((c) => c.score!.strain)) : 0;

  const strainChange = percentChange(strainAvgA, strainAvgB);

  // --- Build result ---
  return {
    period_a: {
      start: period_a_start,
      end: period_a_end,
      days: daysBetween(period_a_start, period_a_end),
    },
    period_b: {
      start: period_b_start,
      end: period_b_end,
      days: daysBetween(period_b_start, period_b_end),
    },
    recovery: {
      period_a_avg: recoveryAvgA,
      period_b_avg: recoveryAvgB,
      change_pct: recoveryChange,
      direction: healthDirection(recoveryChange),
    },
    sleep: {
      period_a_avg_hours: sleepAvgA,
      period_b_avg_hours: sleepAvgB,
      change_pct: sleepChange,
      direction: healthDirection(sleepChange),
    },
    strain: {
      period_a_avg: strainAvgA,
      period_b_avg: strainAvgB,
      change_pct: strainChange,
      direction: strainDirection(strainChange),
    },
  };
}
