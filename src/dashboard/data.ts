import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import {
  disciplineResolver,
  durationSeconds,
  loadWellness,
  loadWorkouts,
  readPerformanceState,
  resolveWindow,
  shiftDay,
  storeStatusSchema,
  weekStart,
  windowInputShape,
  type PerformanceDeps,
} from "../performance/context.js";
import { computeTrainingLoad, edwardsTrimp } from "../performance/training-load.js";
import {
  dataQualitySchema,
  DAY_MS,
  DISCLAIMER,
  sourceQualitySchema,
} from "../tools/analytics-utils.js";
import { raceReadinessOutputSchema } from "../tools/get-race-readiness.js";

const zoneMinutesSchema = z.array(z.number().nonnegative()).length(6);
const nullableNumber = z.number().nullable();
const stagesSchema = z.object({
  light_hours: z.number(),
  deep_hours: z.number(),
  rem_hours: z.number(),
  awake_hours: z.number(),
});
export const dashboardHistorySchema = z.object({
  days: z.array(
    z.object({
      date: z.string(),
      recovery_score: nullableNumber,
      hrv_rmssd_milli: nullableNumber,
      resting_heart_rate: nullableNumber,
      sleep_hours: nullableNumber,
      sleep_stages: stagesSchema.nullable(),
    })
  ),
  data_quality: dataQualitySchema,
  method_version: z.string(),
  disclaimer: z.string(),
});

export const dashboardTrainingInputSchema = z.object(windowInputShape);
export const dashboardTrainingSchema = z.object({
  period: z.object({ start: z.string(), end: z.string() }),
  weekly: z.array(z.object({ week_start: z.string(), zones: zoneMinutesSchema })),
  workouts: z.array(
    z.object({
      id: z.string(),
      start: z.string(),
      sport_name: z.string(),
      discipline: z.string(),
      minutes: z.number(),
      strain: nullableNumber,
      trimp: nullableNumber,
      zones: zoneMinutesSchema.nullable(),
    })
  ),
  load: raceReadinessOutputSchema.shape.load,
  source: sourceQualitySchema,
  store: storeStatusSchema,
  method_version: z.string(),
  disclaimer: z.string(),
});

export async function getDashboardHistory(
  client: WhoopClient,
  deps: PerformanceDeps
): Promise<z.infer<typeof dashboardHistorySchema>> {
  const now = deps.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const start = shiftDay(today, -34);
  // Include sleeps starting before the first wake-up day.
  const period = { start: `${shiftDay(start, -2)}T00:00:00Z`, end: now.toISOString() };
  const wellness = await loadWellness(client, period);
  const byDay = new Map(wellness.days.map((row) => [row.date, row]));
  return {
    days: Array.from({ length: 35 }, (_, index) => {
      const date = shiftDay(start, index);
      const row = byDay.get(date);
      return {
        date,
        recovery_score: row?.user_calibrating ? null : (row?.recovery_score ?? null),
        hrv_rmssd_milli: row?.user_calibrating ? null : (row?.hrv_rmssd_milli ?? null),
        resting_heart_rate: row?.user_calibrating ? null : (row?.resting_heart_rate ?? null),
        sleep_hours: row?.sleep_hours ?? null,
        sleep_stages: row?.sleep_stages ?? null,
      };
    }),
    data_quality: {
      evaluated_at: now.toISOString(),
      requested_period: period,
      observed_period: null,
      sources: wellness.sources,
      method_version: "dashboard-history-1",
      limitations: [
        "Dates are local wake-up days; the chart ends on the current UTC date.",
        "Missing, pending and calibrating measurements remain gaps, not zero values.",
        "Historical ranges describe the visible observations, not medical normal ranges.",
        "View load time is not WHOOP sync time; reads may use cached data.",
      ],
    },
    method_version: "dashboard-history-1",
    disclaimer: DISCLAIMER,
  };
}

export async function getDashboardTraining(
  client: WhoopClient,
  params: z.infer<typeof dashboardTrainingInputSchema>,
  deps: PerformanceDeps
): Promise<z.infer<typeof dashboardTrainingSchema>> {
  const now = deps.now ?? new Date();
  const period = resolveWindow(params, now, 56, 90);
  if (Date.parse(period.start) >= Date.parse(period.end))
    throw new RangeError("start must be before the current time.");
  const history = {
    start: new Date(Math.min(Date.parse(period.start), now.getTime() - 120 * DAY_MS)).toISOString(),
    end: now.toISOString(),
  };
  const [source, { state, store }] = await Promise.all([
    loadWorkouts(client, history),
    readPerformanceState(deps.loadState),
  ]);
  const disciplineOf = disciplineResolver(state);
  const visible = source.records.filter(
    (workout) =>
      Date.parse(workout.start) >= Date.parse(period.start) &&
      Date.parse(workout.start) < Date.parse(period.end) &&
      disciplineOf(workout) !== "excluded"
  );
  const weekly = new Map<string, number[]>();
  const lastDay = new Date(Date.parse(period.end) - 1).toISOString().slice(0, 10);
  for (let day = weekStart(period.start.slice(0, 10)); day <= lastDay; day = shiftDay(day, 7))
    weekly.set(day, [0, 0, 0, 0, 0, 0]);
  const zoneKeys = [
    "zone_zero_milli",
    "zone_one_milli",
    "zone_two_milli",
    "zone_three_milli",
    "zone_four_milli",
    "zone_five_milli",
  ] as const;
  const workouts = visible.map((workout) => {
    const score = workout.score_state === "SCORED" ? workout.score : null;
    const zones = score ? zoneKeys.map((key) => score.zone_durations[key] / 60_000) : null;
    const bucket = weekly.get(weekStart(new Date(workout.start).toISOString().slice(0, 10)));
    if (zones && bucket)
      zones.forEach((value, index) => {
        bucket[index]! += value;
      });
    return {
      id: workout.id,
      start: workout.start,
      sport_name: workout.sport_name,
      discipline: disciplineOf(workout),
      minutes: durationSeconds(workout) / 60,
      strain: score?.strain ?? null,
      trimp: score ? edwardsTrimp(score.zone_durations) : null,
      zones,
    };
  });
  const load = computeTrainingLoad(source.records, {
    endDay: now.toISOString().slice(0, 10),
    disciplineOf,
  });
  return {
    period,
    weekly: [...weekly].map(([week_start, zones]) => ({ week_start, zones })),
    workouts,
    load,
    source: source.quality,
    store,
    method_version: "dashboard-training-1",
    disclaimer: DISCLAIMER,
  };
}
