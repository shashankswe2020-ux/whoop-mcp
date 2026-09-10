import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { WhoopNetworkError } from "../api/client.js";
import { ENDPOINT_CYCLE, ENDPOINT_RECOVERY, ENDPOINT_SLEEP } from "../api/endpoints.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
} from "../api/record-schemas.js";
import {
  dataQualitySchema,
  DAY_MS,
  DISCLAIMER,
  exclude,
  finishQuality,
  loadAnalyticsSource,
  localDay,
  mainSleeps,
  observedPeriod,
  periodSchema,
  asleepHours,
} from "./analytics-utils.js";
import { mean, median, percentile, standardDeviation } from "./stats-utils.js";

export const baselinesInputSchema = z.object({
  baseline_days: z.number().int().min(14).max(180).optional(),
});
const metricNameSchema = z.enum([
  "hrv",
  "rhr",
  "respiratory_rate",
  "sleep_hours",
  "recovery_score",
]);
const bandSchema = z.object({
  sample_size: z.number().int(),
  mean: z.number(),
  median: z.number(),
  std_dev: z.number(),
  p10: z.number(),
  p25: z.number(),
  p50: z.number(),
  p75: z.number(),
  p90: z.number(),
  latest: z.number().nullable(),
  latest_percentile: z.number().nullable(),
  constant_baseline: z.boolean(),
});
export const baselinesOutputSchema = z.object({
  period: periodSchema.nullable(),
  metrics: z.record(metricNameSchema, bandSchema.nullable()),
  metric_status: z.record(
    metricNameSchema,
    z.object({
      status: z.enum(["available", "insufficient_data"]),
      sample_size: z.number().int(),
      unit: z.string(),
    })
  ),
  data_quality: dataQualitySchema,
  truncated: z.boolean(),
  disclaimer: z.string(),
});
export type BaselineReport = z.infer<typeof baselinesOutputSchema>;
type Metric = z.infer<typeof metricNameSchema>;
type Observation = { value: number; timestamp: string; offset: string };

export async function getBaselines(
  client: WhoopClient,
  params: z.infer<typeof baselinesInputSchema> = {},
  now: Date = new Date()
): Promise<BaselineReport> {
  const { baseline_days = 30 } = baselinesInputSchema.parse(params);
  const period = {
    start: new Date(now.getTime() - baseline_days * DAY_MS).toISOString(),
    end: now.toISOString(),
  };
  const [recovery, sleep, cycle] = await Promise.all([
    loadAnalyticsSource(client, ENDPOINT_RECOVERY, period, recoveryRecordSchema),
    loadAnalyticsSource(client, ENDPOINT_SLEEP, period, sleepRecordSchema),
    loadAnalyticsSource(client, ENDPOINT_CYCLE, period, cycleRecordSchema),
  ]);
  if ([recovery, sleep, cycle].every((source) => source.quality.status === "fetch_failed"))
    throw new WhoopNetworkError("Baseline sources unavailable");
  const observations: Record<Metric, Observation[]> = {
    hrv: [],
    rhr: [],
    respiratory_rate: [],
    sleep_hours: [],
    recovery_score: [],
  };
  const cycles = new Map(cycle.records.map((record) => [`${record.user_id}:${record.id}`, record]));
  const usedRecoveries: typeof recovery.records = [];
  const usedCycles: typeof cycle.records = [];
  const seenCycles = new Set<string>();
  for (const record of recovery.records) {
    if (record.score_state !== "SCORED" || !record.score) {
      exclude(recovery.quality, record.score_state === "PENDING_SCORE" ? "pending" : "unscored");
      continue;
    }
    if (record.score.user_calibrating) {
      exclude(recovery.quality, "calibrating");
      continue;
    }
    const key = `${record.user_id}:${record.cycle_id}`;
    const context = cycles.get(key);
    if (!context) {
      exclude(recovery.quality, "missing_join");
      continue;
    }
    if (
      Date.parse(context.start) < Date.parse(period.start) ||
      Date.parse(context.start) >= now.getTime()
    ) {
      exclude(recovery.quality, "outside_window");
      continue;
    }
    if (seenCycles.has(key)) {
      exclude(recovery.quality, "duplicate_cycle");
      continue;
    }
    seenCycles.add(key);
    usedRecoveries.push(record);
    usedCycles.push(context);
    for (const [metric, value] of [
      ["hrv", record.score.hrv_rmssd_milli],
      ["rhr", record.score.resting_heart_rate],
      ["recovery_score", record.score.recovery_score],
    ] as const) {
      observations[metric].push({
        value,
        timestamp: context.start,
        offset: context.timezone_offset,
      });
    }
  }
  const nights = mainSleeps(sleep.records, period, sleep.quality);
  for (const night of nights) {
    observations.sleep_hours.push({
      value: asleepHours(night),
      timestamp: night.end,
      offset: night.timezone_offset,
    });
    if (night.score?.respiratory_rate !== undefined)
      observations.respiratory_rate.push({
        value: night.score.respiratory_rate,
        timestamp: night.end,
        offset: night.timezone_offset,
      });
  }
  const metrics = {} as BaselineReport["metrics"];
  const metricStatus = {} as BaselineReport["metric_status"];
  const usedTimestamps: string[] = [];
  const units: Record<Metric, string> = {
    hrv: "ms",
    rhr: "bpm",
    recovery_score: "%",
    respiratory_rate: "breaths/min",
    sleep_hours: "hours",
  };
  for (const metric of metricNameSchema.options) {
    const sorted = observations[metric].sort(
      (left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)
    );
    const latest = sorted[0];
    const historical = sorted
      .slice(1)
      .filter(
        (item) => localDay(item.timestamp, item.offset) !== localDay(now.toISOString(), item.offset)
      );
    const values = historical.map((item) => item.value);
    usedTimestamps.push(...historical.map((item) => item.timestamp));
    metricStatus[metric] = {
      status: values.length >= 14 ? "available" : "insufficient_data",
      sample_size: values.length,
      unit: units[metric],
    };
    metrics[metric] =
      values.length < 14
        ? null
        : {
            sample_size: values.length,
            mean: mean(values),
            median: median(values),
            std_dev: standardDeviation(values),
            p10: percentile(values, 10),
            p25: percentile(values, 25),
            p50: percentile(values, 50),
            p75: percentile(values, 75),
            p90: percentile(values, 90),
            latest: latest?.value ?? null,
            latest_percentile: latest
              ? (100 *
                  (values.filter((value) => value < latest.value).length +
                    0.5 * values.filter((value) => value === latest.value).length)) /
                values.length
              : null,
            constant_baseline: standardDeviation(values) === 0,
          };
  }
  finishQuality(recovery.quality, usedRecoveries);
  finishQuality(sleep.quality, nights);
  finishQuality(cycle.quality, usedCycles);
  const observed = observedPeriod(usedTimestamps);
  const truncated = [recovery, sleep, cycle].some((source) => source.quality.truncated);
  return {
    period: observed,
    metrics,
    metric_status: metricStatus,
    truncated,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: now.toISOString(),
      requested_period: period,
      observed_period: observed,
      sources: { recovery: recovery.quality, sleep: sleep.quality, cycle: cycle.quality },
      method_version: "baselines-1",
      limitations: [
        "Descriptive personal distributions, not population norms or diagnosis.",
        "Latest observation and current local day are excluded from each baseline.",
        ...(truncated ? ["Partial history: upstream pagination limit reached."] : []),
      ],
    },
  };
}
