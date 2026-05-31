/**
 * Tool: get_trend
 *
 * Analyzes a single health metric over time using linear regression,
 * anomaly detection, and statistical summary.
 *
 * Supported metrics: recovery, hrv, rhr, sleep_duration, sleep_performance, strain.
 * Each maps to the correct WHOOP endpoint and field extraction.
 */

import type { WhoopClient } from "../api/client.js";
import { fetchAllPages } from "../api/pagination.js";
import { ENDPOINT_RECOVERY, ENDPOINT_SLEEP, ENDPOINT_CYCLE } from "../api/endpoints.js";
import type { Recovery, Sleep, Cycle } from "../api/types.js";
import {
  mean,
  median,
  standardDeviation,
  linearRegression,
  trendDirection,
  detectAnomalies,
} from "./stats-utils.js";
import type { TrendDirectionResult } from "./stats-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported metric names */
export type TrendMetric =
  | "recovery"
  | "hrv"
  | "rhr"
  | "sleep_duration"
  | "sleep_performance"
  | "strain";

/** Input parameters for get_trend */
export interface GetTrendParams {
  metric: TrendMetric;
  days?: number;
}

/** Confidence level based on R² */
export type TrendConfidence = "high" | "medium" | "low";

/** A detected anomaly with date */
export interface TrendAnomaly {
  date: string;
  value: number;
  deviation_from_mean: number;
}

/** Output shape for get_trend */
export interface TrendAnalysis {
  metric: string;
  period: { start: string; end: string; days: number };
  values: number[];
  statistics: {
    mean: number;
    median: number;
    std_dev: number;
    min: number;
    max: number;
  };
  trend: {
    direction: TrendDirectionResult;
    slope: number;
    confidence: TrendConfidence;
  };
  anomalies: TrendAnomaly[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DAYS = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build query with start/end/limit for a given number of days back from now */
function buildTrendQuery(days: number): { query: string; start: string; end: string } {
  const now = new Date();
  const startDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days)
  );
  const start = startDate.toISOString();
  const end = now.toISOString();

  const params = new URLSearchParams();
  params.set("start", start);
  params.set("end", end);
  params.set("limit", "25");
  return { query: `?${params.toString()}`, start, end };
}

/** Classify R² into confidence level */
function r2ToConfidence(r2: number): TrendConfidence {
  if (r2 > 0.7) return "high";
  if (r2 > 0.4) return "medium";
  return "low";
}

/** Compute sleep duration in hours */
function sleepDurationHours(sleep: Sleep): number {
  const startMs = new Date(sleep.start).getTime();
  const endMs = new Date(sleep.end).getTime();
  return (endMs - startMs) / (1000 * 60 * 60);
}

// ---------------------------------------------------------------------------
// Metric extractors
// ---------------------------------------------------------------------------

interface MetricConfig {
  endpoint: string;
  extract: (records: unknown[]) => { values: number[]; dates: string[] };
}

function recoveryMetricConfig(
  field: "recovery_score" | "hrv_rmssd_milli" | "resting_heart_rate"
): MetricConfig {
  return {
    endpoint: ENDPOINT_RECOVERY,
    extract: (records: unknown[]) => {
      const typed = records as Recovery[];
      const scored = typed.filter((r) => r.score_state === "SCORED" && r.score);
      return {
        values: scored.map((r) => r.score![field]),
        dates: scored.map((r) => r.created_at),
      };
    },
  };
}

const METRIC_CONFIGS: Record<TrendMetric, MetricConfig> = {
  recovery: recoveryMetricConfig("recovery_score"),
  hrv: recoveryMetricConfig("hrv_rmssd_milli"),
  rhr: recoveryMetricConfig("resting_heart_rate"),
  sleep_duration: {
    endpoint: ENDPOINT_SLEEP,
    extract: (records: unknown[]) => {
      const typed = records as Sleep[];
      const scored = typed.filter((s) => s.score_state === "SCORED" && s.score && !s.nap);
      return {
        values: scored.map(sleepDurationHours),
        dates: scored.map((s) => s.end),
      };
    },
  },
  sleep_performance: {
    endpoint: ENDPOINT_SLEEP,
    extract: (records: unknown[]) => {
      const typed = records as Sleep[];
      const scored = typed.filter(
        (s) =>
          s.score_state === "SCORED" &&
          s.score?.sleep_performance_percentage !== undefined &&
          !s.nap
      );
      return {
        values: scored.map((s) => s.score!.sleep_performance_percentage!),
        dates: scored.map((s) => s.end),
      };
    },
  },
  strain: {
    endpoint: ENDPOINT_CYCLE,
    extract: (records: unknown[]) => {
      const typed = records as Cycle[];
      const scored = typed.filter((c) => c.score_state === "SCORED" && c.score);
      return {
        values: scored.map((c) => c.score!.strain),
        dates: scored.map((c) => c.created_at),
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Analyze a health metric trend over time.
 *
 * Fetches data for the specified number of days, computes statistics,
 * linear regression trend, and anomaly detection.
 *
 * @throws Error if fewer than 2 scored data points are available
 */
export async function getTrend(
  client: WhoopClient,
  params: GetTrendParams
): Promise<TrendAnalysis> {
  const days = params.days ?? DEFAULT_DAYS;
  const { query, start, end } = buildTrendQuery(days);
  const config = METRIC_CONFIGS[params.metric];

  // Fetch all records for the period
  const result = await fetchAllPages<unknown>(client, `${config.endpoint}${query}`, {
    maxRecords: 100,
    maxPages: 10,
    interPageDelayMs: 0,
  });

  // Extract values and dates
  const { values, dates } = config.extract(result.records);

  if (values.length < 2) {
    throw new Error(
      `Insufficient data for trend analysis: need at least 2 scored data points, got ${values.length}. ` +
        `Try a longer time range or check that your WHOOP has recorded data for the "${params.metric}" metric.`
    );
  }

  // Compute statistics
  const stats = {
    mean: mean(values),
    median: median(values),
    std_dev: standardDeviation(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };

  // Compute trend
  const reg = linearRegression(values);
  const direction = trendDirection(reg.slope, reg.r2);
  const confidence = r2ToConfidence(reg.r2);

  // Detect anomalies
  const rawAnomalies = detectAnomalies(values, 2);
  const anomalies: TrendAnomaly[] = rawAnomalies.map((a) => ({
    date: dates[a.index] ?? "unknown",
    value: a.value,
    deviation_from_mean: a.deviation,
  }));

  return {
    metric: params.metric,
    period: { start, end, days },
    values,
    statistics: stats,
    trend: { direction, slope: reg.slope, confidence },
    anomalies,
  };
}
