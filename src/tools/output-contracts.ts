import { z } from "zod";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import { dataQualitySchema, periodSchema } from "./analytics-utils.js";
import { baselinesOutputSchema } from "./get-baselines.js";
import { sleepDebtOutputSchema } from "./get-sleep-debt.js";

export { privacyModeSchema, type PrivacyMode } from "../privacy.js";
const number = z.number().finite();
const nullable = number.nullable();
const period = periodSchema.extend({ days: number });
const direction = z.enum(["improving", "declining", "stable"]);
const collection = <Schema extends z.ZodType>(
  record: Schema
): z.ZodObject<{ records: z.ZodArray<Schema>; next_token: z.ZodOptional<z.ZodString> }> =>
  z.object({ records: z.array(record), next_token: z.string().optional() });
const weekly = z.object({
  week_start: z.string(),
  week_end: z.string(),
  recovery: z.object({
    average_score: number,
    min_score: number,
    max_score: number,
    average_hrv: number,
    average_rhr: number,
    trend: direction,
  }),
  sleep: z.object({
    average_duration_hours: number,
    average_performance_pct: number,
    average_efficiency_pct: number,
  }),
  workouts: z.object({
    count: number,
    total_strain: number,
    total_calories_kj: number,
    sport_breakdown: z.record(z.string(), number),
  }),
  strain: z.object({ average_daily_strain: number, max_daily_strain: number }),
  warnings: z.array(z.string()).optional(),
});
const comparisonMetric = z.object({
  period_a_avg: number,
  period_b_avg: number,
  change_pct: number,
  direction: z.enum(["improved", "declined", "unchanged"]),
});
const comparison = z.object({
  period_a: period,
  period_b: period,
  recovery: comparisonMetric,
  sleep: z.object({
    period_a_avg_hours: number,
    period_b_avg_hours: number,
    change_pct: number,
    direction: z.enum(["improved", "declined", "unchanged"]),
  }),
  strain: comparisonMetric.extend({ direction: z.enum(["increased", "decreased", "unchanged"]) }),
});
const trend = z.object({
  metric: z.string(),
  period,
  values: z.array(number),
  statistics: z.object({ mean: number, median: number, std_dev: number, min: number, max: number }),
  trend: z.object({ direction, slope: number, confidence: z.enum(["high", "medium", "low"]) }),
  anomalies: z.array(z.object({ date: z.string(), value: number, deviation_from_mean: number })),
});
const today = z.object({
  timestamp: z.string(),
  recovery: z
    .object({
      score: number,
      hrv_rmssd_milli: number,
      resting_heart_rate: number,
      spo2_pct: nullable,
      skin_temp_celsius: nullable,
    })
    .nullable(),
  sleep: z
    .object({
      total_hours: number,
      time_in_bed_hours: number,
      asleep_hours: number,
      rem_hours: number,
      deep_hours: number,
      light_hours: number,
      awake_hours: number,
      performance_pct: nullable,
      efficiency_pct: nullable,
      respiratory_rate: nullable,
    })
    .nullable(),
  strain: z
    .object({
      day_strain: number,
      energy_burned_kj: number,
      last_workout: z
        .object({
          sport_name: z.string(),
          strain: number,
          occurred_at: z.string(),
          percent_recorded: number,
        })
        .nullable(),
    })
    .nullable(),
  summary: z.string(),
  data_quality: dataQualitySchema,
});
const calendar = z.object({
  period,
  days: z.array(
    z.object({
      date: z.string(),
      recovery_score: nullable,
      recovery_zone: z.enum(["green", "yellow", "red"]).nullable(),
      sleep_hours: nullable,
      sleep_performance_pct: nullable,
      day_strain: nullable,
    })
  ),
  averages: z.object({ recovery: nullable, sleep_hours: nullable, strain: nullable }),
});

export const outputSchemas: Record<string, z.ZodObject> = {
  get_profile: z
    .object({ user_id: number, email: z.string(), first_name: z.string(), last_name: z.string() })
    .passthrough(),
  get_body_measurement: z
    .object({ height_meter: number, weight_kilogram: number, max_heart_rate: number })
    .passthrough(),
  get_recovery_collection: collection(recoveryRecordSchema),
  get_sleep_collection: collection(sleepRecordSchema),
  get_workout_collection: collection(workoutRecordSchema),
  get_cycle_collection: collection(cycleRecordSchema),
  get_sleep_by_id: sleepRecordSchema,
  get_workout_by_id: workoutRecordSchema,
  get_cycle_by_id: cycleRecordSchema,
  get_weekly_summary: weekly,
  compare_periods: comparison,
  get_trend: trend,
  get_today: today,
  get_calendar: calendar,
  get_baselines: baselinesOutputSchema,
  get_sleep_debt: sleepDebtOutputSchema,
};

const aggregateBand = z.object({
  sample_size: number,
  mean: number,
  median: number,
  std_dev: number,
  p10: number,
  p25: number,
  p50: number,
  p75: number,
  p90: number,
  constant_baseline: z.boolean(),
});
const aggregateQuality = dataQualitySchema
  .omit({ sources: true, limitations: true, observed_period: true })
  .extend({
    sources: z.record(
      z.string(),
      z.object({
        status: z.string(),
        records_fetched: number,
        records_used: number,
        exclusions: z.record(z.string(), number),
        truncated: z.boolean(),
      })
    ),
  });
export const aggregateOutputSchemas: Record<string, z.ZodObject> = {
  get_weekly_summary: weekly
    .omit({ warnings: true })
    .extend({ workouts: weekly.shape.workouts.omit({ sport_breakdown: true }) }),
  compare_periods: comparison,
  get_trend: trend.omit({ values: true, anomalies: true }),
  get_baselines: baselinesOutputSchema.extend({
    metrics: z.record(
      z.enum(["hrv", "rhr", "respiratory_rate", "sleep_hours", "recovery_score"]),
      aggregateBand.nullable()
    ),
    data_quality: aggregateQuality,
  }),
  get_sleep_debt: sleepDebtOutputSchema
    .omit({ nights: true, standing_debt_hours: true, standing_debt_date: true, summary: true })
    .extend({ data_quality: aggregateQuality }),
};

export function projectAggregateDates(data: Record<string, unknown>): Record<string, unknown> {
  const projected = { ...data };
  for (const key of ["period", "period_a", "period_b"]) {
    if (projected[key]) {
      const periodValue = periodSchema.passthrough().parse(projected[key]);
      projected[key] = {
        ...periodValue,
        start: periodValue.start.slice(0, 10),
        end: periodValue.end.slice(0, 10),
      };
    }
  }
  for (const key of ["week_start", "week_end"]) {
    if (typeof projected[key] === "string") projected[key] = projected[key].slice(0, 10);
  }
  if (projected.data_quality) {
    const quality = aggregateQuality.parse(projected.data_quality);
    projected.data_quality = {
      ...quality,
      requested_period: {
        start: quality.requested_period.start.slice(0, 10),
        end: quality.requested_period.end.slice(0, 10),
      },
    };
  }
  return projected;
}
