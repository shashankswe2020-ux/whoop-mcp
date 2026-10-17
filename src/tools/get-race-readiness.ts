import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import type { Workout } from "../api/types.js";
import {
  baselineMean,
  disciplineResolver,
  isoDaySchema,
  loadWellness,
  loadWorkouts,
  readPerformanceState,
  shiftDay,
  storeStatusSchema,
  type PerformanceDeps,
} from "../performance/context.js";
import { evidencedMetricSchema } from "../performance/evidence.js";
import { computeReadiness, READINESS_METHOD_VERSION } from "../performance/readiness.js";
import { computeTrainingLoad } from "../performance/training-load.js";
import { dataQualitySchema, DAY_MS, localDay } from "./analytics-utils.js";

export const READINESS_HISTORY_DAYS = 120;
const BASELINE_DAYS = 30;
const MAX_DAYS_TO_RACE = 366;

export const raceReadinessInputSchema = z.object({
  sport: z.enum(["hyrox", "triathlon"]).describe("Race type the readiness is evaluated for."),
  race_date: isoDaySchema
    .optional()
    .describe("Race day YYYY-MM-DD. Enables the taper component within 14 days."),
});

const loadValuesSchema = z.object({ ctl: z.number(), atl: z.number(), tsb: z.number() });

export const raceReadinessOutputSchema = z.object({
  sport: z.enum(["hyrox", "triathlon"]),
  today: z.string(),
  band: z.enum(["ready", "caution", "not_ready", "insufficient_data"]),
  band_rule: z.string(),
  days_to_race: z.number().nullable(),
  components: z.array(
    z.object({
      id: z.enum(["recovery", "form", "specificity", "sleep", "taper"]),
      band: z.enum(["green", "amber", "red", "unknown", "not_applicable"]),
      rationale: z.string(),
      metric: evidencedMetricSchema,
    })
  ),
  load: z.object({
    status: z.enum(["available", "insufficient_data"]),
    method: z.string(),
    method_version: z.string(),
    unit: z.string(),
    window: z.object({ start: z.string(), end: z.string() }).nullable(),
    history_days: z.number().int(),
    current: loadValuesSchema.nullable(),
    by_discipline: z.record(z.string(), loadValuesSchema),
    load_28d: z.record(z.string(), z.number()),
    load_spike: z.object({
      ratio: z.number().nullable(),
      flagged: z.boolean(),
      threshold: z.number(),
    }),
    series: z
      .array(
        z.object({
          date: z.string(),
          load: z.number(),
          ctl: z.number(),
          atl: z.number(),
          tsb: z.number(),
        })
      )
      .max(90),
    series_truncated: z.boolean(),
  }),
  store: storeStatusSchema,
  method_version: z.string(),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});
export type RaceReadiness = z.infer<typeof raceReadinessOutputSchema>;

function latestOffset(workouts: Workout[], fallback: string | undefined): string {
  const latest = [...workouts].sort((left, right) => right.start.localeCompare(left.start))[0];
  return latest?.timezone_offset ?? fallback ?? "+00:00";
}

export async function getRaceReadiness(
  client: WhoopClient,
  params: z.infer<typeof raceReadinessInputSchema>,
  deps: PerformanceDeps = {}
): Promise<RaceReadiness> {
  const input = raceReadinessInputSchema.parse(params);
  const now = deps.now ?? new Date();
  const period = {
    start: new Date(now.getTime() - READINESS_HISTORY_DAYS * DAY_MS).toISOString(),
    end: now.toISOString(),
  };
  const [{ state, store }, source, wellness] = await Promise.all([
    readPerformanceState(deps.loadState),
    loadWorkouts(client, period),
    loadWellness(client, {
      start: new Date(now.getTime() - (BASELINE_DAYS + 2) * DAY_MS).toISOString(),
      end: now.toISOString(),
    }),
  ]);
  const latestNight = wellness.days[wellness.days.length - 1];
  const today = localDay(now.toISOString(), latestOffset(source.records, undefined));
  if (input.race_date && input.race_date > shiftDay(today, MAX_DAYS_TO_RACE))
    throw new RangeError(`race_date must be within ${MAX_DAYS_TO_RACE} days.`);
  const todayRow = wellness.days.find((day) => day.date === today);
  const scored = todayRow && !todayRow.user_calibrating ? todayRow : undefined;
  const disciplineOf = disciplineResolver(state);
  const load = computeTrainingLoad(source.records, { endDay: today, disciplineOf });
  source.quality.records_used = load.inputs.records_used;
  for (const [reason, count] of Object.entries(load.inputs.excluded_reasons))
    source.quality.exclusions[reason] = count;

  const readiness = computeReadiness({
    sport: input.sport,
    today,
    ...(input.race_date ? { race_date: input.race_date } : {}),
    recovery: {
      score: scored?.recovery_score ?? null,
      baseline_mean: baselineMean(wellness.days, today, (day) => day.recovery_score, BASELINE_DAYS)
        .mean,
      date: scored ? today : null,
    },
    load,
    sleep_debt_hours:
      latestNight && latestNight.date >= shiftDay(today, -1)
        ? latestNight.standing_sleep_debt_hours
        : null,
  });

  return {
    ...readiness,
    today,
    load: {
      status: load.status,
      method: load.method,
      method_version: load.method_version,
      unit: load.unit,
      window: load.window,
      history_days: load.history_days,
      current: load.current,
      by_discipline: load.by_discipline,
      load_28d: load.load_28d,
      load_spike: load.load_spike,
      series: load.series,
      series_truncated: load.series_truncated,
    },
    store,
    data_quality: {
      evaluated_at: now.toISOString(),
      requested_period: period,
      observed_period: load.window,
      sources: { workout: source.quality, ...wellness.sources },
      method_version: READINESS_METHOD_VERSION,
      limitations: [
        "Readiness is a deterministic worst-of rule over five components, not a prediction of race performance.",
        "Sleep debt is WHOOP's own sleep-debt need from the latest main sleep (yesterday or today).",
        "Thresholds are coaching heuristics and are not individualised.",
        ...(source.quality.truncated
          ? ["Workout history hit the pagination limit; load may be under-counted."]
          : []),
      ],
    },
  };
}
