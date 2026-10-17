import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import type { Workout } from "../api/types.js";
import {
  disciplineResolver,
  durationSeconds,
  loadWorkouts,
  readPerformanceState,
  resolveWindow,
  round,
  storeStatusSchema,
  weekStart,
  windowInputShape,
  workoutDay,
  type PerformanceDeps,
} from "../performance/context.js";
import { MIN_DISCIPLINE_SHARE } from "../performance/readiness.js";
import type { StoredRaceResult } from "../performance/schemas.js";
import { groupSessions } from "../performance/session-grouping.js";
import { findBricks } from "../performance/sport-classifier.js";
import { detectSuspects } from "../performance/suspect-detector.js";
import { edwardsTrimp } from "../performance/training-load.js";
import { dataQualitySchema, DISCLAIMER } from "./analytics-utils.js";

export const TRIATHLON_PERFORMANCE_METHOD_VERSION = "1.0.0";
const DEFAULT_DAYS = 56;
const MAX_DAYS = 366;
const MAX_WEEKS = 53;
const MAX_BRICKS = 50;
const MAX_RACES = 50;
const LEGS = ["swim", "bike", "run"] as const;
type Leg = (typeof LEGS)[number];

export const triathlonPerformanceInputSchema = z.object(windowInputShape);

const legBucketSchema = z.object({
  workouts: z.number().int(),
  minutes: z.number(),
  distance_km: z.number().nullable(),
  trimp: z.number(),
});
const zoneShareSchema = z.object({
  zone_one: z.number(),
  zone_two: z.number(),
  zone_three: z.number(),
  zone_four: z.number(),
  zone_five: z.number(),
});

export const triathlonPerformanceOutputSchema = z.object({
  period: z.object({ start: z.string(), end: z.string() }),
  weekly: z.array(
    z.object({
      week_start: z.string(),
      swim: legBucketSchema,
      bike: legBucketSchema,
      run: legBucketSchema,
      multisport: legBucketSchema,
      bricks: z.number().int(),
    })
  ),
  totals: z.object({
    swim: legBucketSchema,
    bike: legBucketSchema,
    run: legBucketSchema,
    multisport: legBucketSchema,
  }),
  zone_mix: z.object({
    swim: zoneShareSchema.nullable(),
    bike: zoneShareSchema.nullable(),
    run: zoneShareSchema.nullable(),
  }),
  discipline_share: z.object({
    status: z.enum(["available", "insufficient_data"]),
    swim: z.number().nullable(),
    bike: z.number().nullable(),
    run: z.number().nullable(),
    min_share: z.number(),
    below_min: z.array(z.enum(LEGS)),
    rule: z.string(),
  }),
  bricks: z.array(
    z.object({
      date: z.string(),
      bike_id: z.string(),
      run_id: z.string(),
      gap_seconds: z.number(),
    })
  ),
  races: z.array(
    z.object({
      id: z.string(),
      date: z.string(),
      name: z.string(),
      category: z.string(),
      total_seconds: z.number(),
      swim_seconds: z.number().nullable(),
      bike_seconds: z.number().nullable(),
      run_seconds: z.number().nullable(),
      t1_seconds: z.number().nullable(),
      t2_seconds: z.number().nullable(),
      transitions_seconds: z.number().nullable(),
      workout_id: z.string().nullable(),
    })
  ),
  distance_ignored_workout_ids: z.array(z.string()),
  truncated: z.boolean(),
  store: storeStatusSchema,
  method_version: z.string(),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});
export type TriathlonPerformance = z.infer<typeof triathlonPerformanceOutputSchema>;
type TriathlonRace = Extract<StoredRaceResult, { sport: "triathlon" }>;

function legBucket(
  workouts: Workout[],
  ignoreDistance: Set<string>
): z.infer<typeof legBucketSchema> {
  const distances = workouts
    .filter((workout) => !ignoreDistance.has(workout.id))
    .map((workout) => workout.score?.distance_meter)
    .filter((value): value is number => typeof value === "number" && value > 0);
  return {
    workouts: workouts.length,
    minutes: round(workouts.reduce((total, workout) => total + durationSeconds(workout), 0) / 60),
    distance_km: distances.length
      ? round(distances.reduce((total, value) => total + value, 0) / 1000, 2)
      : null,
    trimp: round(
      workouts.reduce(
        (total, workout) =>
          total + (workout.score ? edwardsTrimp(workout.score.zone_durations) : 0),
        0
      )
    ),
  };
}

function zoneShare(workouts: Workout[]): z.infer<typeof zoneShareSchema> | null {
  const totals = [0, 0, 0, 0, 0];
  for (const workout of workouts) {
    const zones = workout.score?.zone_durations;
    if (!zones) continue;
    totals[0]! += zones.zone_one_milli;
    totals[1]! += zones.zone_two_milli;
    totals[2]! += zones.zone_three_milli;
    totals[3]! += zones.zone_four_milli;
    totals[4]! += zones.zone_five_milli;
  }
  const sum = totals.reduce((total, value) => total + value, 0);
  if (!sum) return null;
  const share = (value: number): number => round(value / sum, 3);
  return {
    zone_one: share(totals[0]!),
    zone_two: share(totals[1]!),
    zone_three: share(totals[2]!),
    zone_four: share(totals[3]!),
    zone_five: share(totals[4]!),
  };
}

export async function getTriathlonPerformance(
  client: WhoopClient,
  params: z.infer<typeof triathlonPerformanceInputSchema> = {},
  deps: PerformanceDeps = {}
): Promise<TriathlonPerformance> {
  const input = triathlonPerformanceInputSchema.parse(params);
  const now = deps.now ?? new Date();
  const period = resolveWindow(input, now, DEFAULT_DAYS, MAX_DAYS);
  const [{ state, store }, source] = await Promise.all([
    readPerformanceState(deps.loadState),
    loadWorkouts(client, period),
  ]);
  const disciplineOf = disciplineResolver(state);
  const workouts = source.records.filter(
    (workout) => Date.parse(workout.start) >= Date.parse(period.start)
  );
  const excluded = workouts.filter((workout) => disciplineOf(workout) === "excluded").length;
  if (excluded) source.quality.exclusions.user_excluded = excluded;
  const active = workouts.filter((workout) => disciplineOf(workout) !== "excluded");

  const ignoreDistance = new Set(
    detectSuspects(active, groupSessions(active, disciplineOf))
      .filter((flag) => flag.rule === "implausible_pace" || flag.rule === "indoor_distance")
      .map((flag) => flag.workout_id)
  );
  const byDiscipline = (items: Workout[], discipline: Leg | "multisport"): Workout[] =>
    items.filter((workout) => disciplineOf(workout) === discipline);
  const buckets = (
    items: Workout[]
  ): Record<Leg | "multisport", z.infer<typeof legBucketSchema>> => ({
    swim: legBucket(byDiscipline(items, "swim"), ignoreDistance),
    bike: legBucket(byDiscipline(items, "bike"), ignoreDistance),
    run: legBucket(byDiscipline(items, "run"), ignoreDistance),
    multisport: legBucket(byDiscipline(items, "multisport"), ignoreDistance),
  });

  const bricks = findBricks(active, disciplineOf).map((brick) => ({
    date: workoutDay(active.find((workout) => workout.id === brick.bike_id)!),
    ...brick,
  }));
  const weeks = new Map<string, Workout[]>();
  for (const workout of active) {
    const key = weekStart(workoutDay(workout));
    weeks.set(key, [...(weeks.get(key) ?? []), workout]);
  }
  const weekly = [...weeks.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([week, items]) => ({
      week_start: week,
      ...buckets(items),
      bricks: bricks.filter((brick) => weekStart(brick.date) === week).length,
    }));

  const totals = buckets(active);
  const legTrimp = LEGS.reduce((total, leg) => total + totals[leg].trimp, 0);
  const share = (leg: Leg): number | null =>
    legTrimp > 0 ? round(totals[leg].trimp / legTrimp, 3) : null;
  const races = state.race_results
    .filter((race): race is TriathlonRace => race.sport === "triathlon")
    .sort((left, right) => right.date.localeCompare(left.date));
  source.quality.records_used = active.filter((workout) =>
    ["swim", "bike", "run", "multisport"].includes(disciplineOf(workout))
  ).length;

  return {
    period,
    weekly: weekly.slice(0, MAX_WEEKS),
    totals,
    zone_mix: {
      swim: zoneShare(byDiscipline(active, "swim")),
      bike: zoneShare(byDiscipline(active, "bike")),
      run: zoneShare(byDiscipline(active, "run")),
    },
    discipline_share: {
      status: legTrimp > 0 ? "available" : "insufficient_data",
      swim: share("swim"),
      bike: share("bike"),
      run: share("run"),
      min_share: MIN_DISCIPLINE_SHARE,
      below_min: legTrimp > 0 ? LEGS.filter((leg) => (share(leg) ?? 0) < MIN_DISCIPLINE_SHARE) : [],
      rule: `Share of swim + bike + run TRIMP. A leg below ${MIN_DISCIPLINE_SHARE * 100}% is flagged (coaching heuristic).`,
    },
    bricks: bricks.slice(-MAX_BRICKS).reverse(),
    races: races.slice(0, MAX_RACES).map((race) => {
      const legs = race.splits;
      return {
        id: race.id,
        date: race.date,
        name: race.name,
        category: race.category,
        total_seconds: race.total_seconds,
        swim_seconds: legs?.swim_seconds ?? null,
        bike_seconds: legs?.bike_seconds ?? null,
        run_seconds: legs?.run_seconds ?? null,
        t1_seconds: legs?.t1_seconds ?? null,
        t2_seconds: legs?.t2_seconds ?? null,
        transitions_seconds: legs ? legs.t1_seconds + legs.t2_seconds : null,
        workout_id: race.workout_id ?? null,
      };
    }),
    distance_ignored_workout_ids: [...ignoreDistance],
    truncated:
      source.quality.truncated ||
      weekly.length > MAX_WEEKS ||
      bricks.length > MAX_BRICKS ||
      races.length > MAX_RACES,
    store,
    method_version: TRIATHLON_PERFORMANCE_METHOD_VERSION,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: now.toISOString(),
      requested_period: period,
      observed_period: active.length
        ? {
            start: active.map((workout) => workout.start).sort()[0]!,
            end: active
              .map((workout) => workout.start)
              .sort()
              .pop()!,
          }
        : null,
      sources: { workout: source.quality },
      method_version: TRIATHLON_PERFORMANCE_METHOD_VERSION,
      limitations: [
        "Distance is WHOOP's optional GPS/device value; implausible paces are ignored, never corrected.",
        "A brick is a bike followed by a run starting ≤ 15 min after the bike ends.",
        "WHOOP 'Triathlon' workouts are counted as multisport and not split into legs.",
      ],
    },
  };
}
