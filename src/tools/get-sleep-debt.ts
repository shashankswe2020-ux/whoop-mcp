import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { WhoopNetworkError } from "../api/client.js";
import { ENDPOINT_SLEEP } from "../api/endpoints.js";
import { sleepRecordSchema } from "../api/record-schemas.js";
import { resolveDateExpression } from "./date-utils.js";
import { circularStats, mean } from "./stats-utils.js";
import {
  asleepHours,
  dataQualitySchema,
  DAY_MS,
  DISCLAIMER,
  HOUR_MS,
  loadAnalyticsSource,
  mainSleeps,
  localDay,
  localTime,
  observedPeriod,
  periodSchema,
  finishQuality,
  exclude,
} from "./analytics-utils.js";

export const sleepDebtInputSchema = z.object({
  days: z.number().int().min(3).max(90).optional(),
  start: z.string().max(100).optional(),
});
const nightSchema = z.object({
  date: z.string(),
  needed_hours: z.number(),
  achieved_hours: z.number(),
  debt_hours: z.number(),
});
export const sleepDebtOutputSchema = z.object({
  period: periodSchema,
  nights_analyzed: z.number().int(),
  status: z.enum(["available", "insufficient_data"]),
  total_debt_hours: z.number().nullable(),
  avg_nightly_debt_hours: z.number().nullable(),
  standing_debt_hours: z.number().nullable(),
  standing_debt_date: z.string().nullable(),
  consistency: z.object({
    bedtime_std_dev_minutes: z.number().nullable(),
    waketime_std_dev_minutes: z.number().nullable(),
    social_jetlag_minutes: z.number().nullable(),
  }),
  nights: z.array(nightSchema).max(30),
  output_capped: z.boolean(),
  truncated: z.boolean(),
  summary: z.string(),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});
export type SleepDebtReport = z.infer<typeof sleepDebtOutputSchema>;

export async function getSleepDebt(
  client: WhoopClient,
  params: z.infer<typeof sleepDebtInputSchema> = {},
  now: Date = new Date()
): Promise<SleepDebtReport> {
  const { days = 14, start } = sleepDebtInputSchema.parse(params);
  const startTime = start
    ? Date.parse(resolveDateExpression(start, now).start)
    : now.getTime() - days * DAY_MS;
  const endTime = Math.min(startTime + days * DAY_MS, now.getTime());
  if (!Number.isFinite(startTime) || startTime >= endTime)
    throw new RangeError("Sleep window must begin before the evaluation time.");
  const period = { start: new Date(startTime).toISOString(), end: new Date(endTime).toISOString() };
  const source = await loadAnalyticsSource(client, ENDPOINT_SLEEP, period, sleepRecordSchema);
  if (source.quality.status === "fetch_failed")
    throw new WhoopNetworkError("Sleep source unavailable");
  const selected = mainSleeps(source.records, period, source.quality).filter((night) => {
    const need = night.score!.sleep_needed;
    if (
      need.baseline_milli + need.need_from_recent_strain_milli + need.need_from_recent_nap_milli <
      0
    ) {
      exclude(source.quality, "invalid_need");
      return false;
    }
    return true;
  });
  const nights = selected.map((night) => {
    const need = night.score!.sleep_needed;
    const needed =
      (need.baseline_milli + need.need_from_recent_strain_milli + need.need_from_recent_nap_milli) /
      HOUR_MS;
    const achieved = asleepHours(night);
    return {
      date: localDay(night.end, night.timezone_offset),
      needed_hours: needed,
      achieved_hours: achieved,
      debt_hours: Math.max(0, needed - achieved),
    };
  });
  const bedtimes: number[] = [];
  const waketimes: number[] = [];
  const weekdays: number[] = [];
  const weekends: number[] = [];
  for (const night of selected) {
    const bedtime = localTime(night.start, night.timezone_offset);
    const wake = localTime(night.end, night.timezone_offset);
    const bedMinutes =
      bedtime.getUTCHours() * 60 + bedtime.getUTCMinutes() + bedtime.getUTCSeconds() / 60;
    bedtimes.push(bedMinutes);
    waketimes.push(wake.getUTCHours() * 60 + wake.getUTCMinutes() + wake.getUTCSeconds() / 60);
    const midpoint =
      (bedMinutes + (Date.parse(night.end) - Date.parse(night.start)) / 120_000) % 1440;
    (wake.getUTCDay() === 0 || wake.getUTCDay() === 6 ? weekends : weekdays).push(midpoint);
  }
  const weekdayMean = circularStats(weekdays).mean;
  const weekendMean = circularStats(weekends).mean;
  const midpointDistance =
    weekdayMean === null || weekendMean === null ? null : Math.abs(weekdayMean - weekendMean);
  const sufficient = nights.length >= 3;
  finishQuality(source.quality, selected);
  const observed = observedPeriod(selected.map((night) => night.end));
  return {
    period,
    nights_analyzed: nights.length,
    status: sufficient ? "available" : "insufficient_data",
    total_debt_hours: sufficient
      ? nights.reduce((total, night) => total + night.debt_hours, 0)
      : null,
    avg_nightly_debt_hours: sufficient ? mean(nights.map((night) => night.debt_hours)) : null,
    standing_debt_hours: selected[0]
      ? selected[0].score!.sleep_needed.need_from_sleep_debt_milli / HOUR_MS
      : null,
    standing_debt_date: nights[0]?.date ?? null,
    consistency: {
      bedtime_std_dev_minutes: sufficient ? circularStats(bedtimes).sd : null,
      waketime_std_dev_minutes: sufficient ? circularStats(waketimes).sd : null,
      social_jetlag_minutes:
        sufficient && midpointDistance !== null
          ? Math.min(midpointDistance, 1440 - midpointDistance)
          : null,
    },
    nights: nights.slice(0, 30),
    output_capped: nights.length > 30,
    truncated: source.quality.truncated,
    summary: `${sufficient ? "Sum of observed nightly deficits, not outstanding debt." : "Insufficient data: at least three scored main sleeps are required."} Social jetlag is a circular midpoint heuristic.${source.quality.truncated ? " Partial history: pagination limit reached." : ""}`,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: now.toISOString(),
      requested_period: period,
      observed_period: observed,
      sources: { sleep: source.quality },
      method_version: "sleep-debt-1",
      limitations: [
        "One recorded offset cannot reconstruct within-sleep DST changes.",
        "Deficit totals do not predict recovery or prescribe repayment.",
      ],
    },
  };
}
