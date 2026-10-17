import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import type { Workout } from "../api/types.js";
import {
  candidateSchema,
  classifySessions,
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
import {
  HYROX_STATIONS,
  impliedRoxzoneSeconds,
  type StoredRaceResult,
} from "../performance/schemas.js";
import { groupSessions } from "../performance/session-grouping.js";
import { edwardsTrimp } from "../performance/training-load.js";
import { dataQualitySchema, DISCLAIMER } from "./analytics-utils.js";

export const HYROX_PERFORMANCE_METHOD_VERSION = "1.0.0";
export const MIN_RACES_FOR_STATION_ANALYSIS = 2;
const DEFAULT_DAYS = 56;
const MAX_DAYS = 366;
const MAX_WEEKS = 53;
const MAX_SESSIONS = 50;
const MAX_CANDIDATES = 20;
const MAX_RACES = 50;

export const hyroxPerformanceInputSchema = z.object(windowInputShape);

const loadBucketSchema = z.object({
  workouts: z.number().int(),
  minutes: z.number(),
  trimp: z.number(),
});
const stationSchema = z.enum(HYROX_STATIONS);

export const hyroxPerformanceOutputSchema = z.object({
  period: z.object({ start: z.string(), end: z.string() }),
  weekly: z.array(
    z.object({
      week_start: z.string(),
      run: loadBucketSchema,
      hyrox: loadBucketSchema,
      confirmed_sessions: z.number().int(),
    })
  ),
  sessions: z.array(
    z.object({
      start: z.string(),
      end: z.string(),
      span_seconds: z.number(),
      transition_share: z.number(),
      run_segments: z.number().int(),
      station_segments: z.number().int(),
      workout_ids: z.array(z.string()),
    })
  ),
  unconfirmed_candidates: z.object({
    count: z.number().int(),
    items: z.array(candidateSchema),
  }),
  races: z.array(
    z.object({
      id: z.string(),
      date: z.string(),
      name: z.string(),
      category: z.string(),
      total_seconds: z.number(),
      runs_seconds: z.array(z.number()).nullable(),
      stations: z.array(z.object({ station: stationSchema, seconds: z.number() })).nullable(),
      roxzone_seconds: z.number().nullable(),
      roxzone_source: z.enum(["logged", "implied"]).nullable(),
      workout_id: z.string().nullable(),
    })
  ),
  station_analysis: z.object({
    status: z.enum(["available", "insufficient_data"]),
    races_used: z.number().int(),
    latest_race_id: z.string().nullable(),
    weakest_station: stationSchema.nullable(),
    rule: z.string(),
    stations: z.array(
      z.object({
        station: stationSchema,
        median_seconds: z.number(),
        latest_seconds: z.number(),
        delta_seconds: z.number(),
        delta_pct: z.number(),
      })
    ),
  }),
  personal_records: z.object({
    best_total_by_division: z.array(
      z.object({
        category: z.string(),
        race_id: z.string(),
        date: z.string(),
        total_seconds: z.number(),
      })
    ),
    best_station: z.array(
      z.object({ station: stationSchema, seconds: z.number(), race_id: z.string() })
    ),
  }),
  truncated: z.boolean(),
  store: storeStatusSchema,
  method_version: z.string(),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});
export type HyroxPerformance = z.infer<typeof hyroxPerformanceOutputSchema>;
type HyroxRace = Extract<StoredRaceResult, { sport: "hyrox" }>;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function bucket(workouts: Workout[]): z.infer<typeof loadBucketSchema> {
  return {
    workouts: workouts.length,
    minutes: round(workouts.reduce((total, workout) => total + durationSeconds(workout), 0) / 60),
    trimp: round(
      workouts.reduce(
        (total, workout) =>
          total + (workout.score ? edwardsTrimp(workout.score.zone_durations) : 0),
        0
      )
    ),
  };
}

const STATION_RULE = `For each station: (latest race − your median across races) / median. Weakest = largest positive delta. Needs ≥ ${MIN_RACES_FOR_STATION_ANALYSIS} races with splits; never compared with other athletes.`;

/** Personal station analysis: the latest race against your own median. */
export function analyseStations(races: HyroxRace[]): HyroxPerformance["station_analysis"] {
  const withSplits = races
    .filter((race) => race.splits)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (withSplits.length < MIN_RACES_FOR_STATION_ANALYSIS)
    return {
      status: "insufficient_data",
      races_used: withSplits.length,
      latest_race_id: null,
      weakest_station: null,
      rule: STATION_RULE,
      stations: [],
    };
  const latest = withSplits[withSplits.length - 1]!;
  const stations = HYROX_STATIONS.map((station, index) => {
    const values = withSplits.map((race) => race.splits!.stations[index]!.seconds);
    const medianSeconds = median(values);
    const latestSeconds = latest.splits!.stations[index]!.seconds;
    return {
      station,
      median_seconds: medianSeconds,
      latest_seconds: latestSeconds,
      delta_seconds: latestSeconds - medianSeconds,
      delta_pct: round(((latestSeconds - medianSeconds) / medianSeconds) * 100),
    };
  });
  const weakest = [...stations]
    .filter((item) => item.delta_seconds > 0)
    .sort((left, right) => right.delta_pct - left.delta_pct)[0];
  return {
    status: "available",
    races_used: withSplits.length,
    latest_race_id: latest.id,
    weakest_station: weakest?.station ?? null,
    rule: STATION_RULE,
    stations,
  };
}

function personalRecords(races: HyroxRace[]): HyroxPerformance["personal_records"] {
  const byDivision = new Map<string, HyroxRace>();
  for (const race of races) {
    const best = byDivision.get(race.category);
    if (!best || race.total_seconds < best.total_seconds) byDivision.set(race.category, race);
  }
  const bestStation = HYROX_STATIONS.flatMap((station, index) => {
    const candidates = races
      .filter((race) => race.splits)
      .map((race) => ({ race_id: race.id, seconds: race.splits!.stations[index]!.seconds }))
      .sort((left, right) => left.seconds - right.seconds);
    return candidates[0] ? [{ station, ...candidates[0] }] : [];
  });
  return {
    best_total_by_division: [...byDivision.values()].map((race) => ({
      category: race.category,
      race_id: race.id,
      date: race.date,
      total_seconds: race.total_seconds,
    })),
    best_station: bestStation,
  };
}

export async function getHyroxPerformance(
  client: WhoopClient,
  params: z.infer<typeof hyroxPerformanceInputSchema> = {},
  deps: PerformanceDeps = {}
): Promise<HyroxPerformance> {
  const input = hyroxPerformanceInputSchema.parse(params);
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
  const sessions = groupSessions(workouts, disciplineOf);
  const { confirmed, candidates } = classifySessions(sessions, disciplineOf);
  const excluded = workouts.filter((workout) => disciplineOf(workout) === "excluded").length;
  if (excluded) source.quality.exclusions.user_excluded = excluded;

  const weeks = new Map<string, Workout[]>();
  for (const workout of workouts) {
    const key = weekStart(workoutDay(workout));
    weeks.set(key, [...(weeks.get(key) ?? []), workout]);
  }
  const weekly = [...weeks.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([week, items]) => ({
      week_start: week,
      run: bucket(items.filter((workout) => disciplineOf(workout) === "run")),
      hyrox: bucket(items.filter((workout) => disciplineOf(workout) === "hyrox")),
      confirmed_sessions: confirmed.filter(
        (session) => weekStart(workoutDay(session.segments[0]!.workout)) === week
      ).length,
    }));

  const races = state.race_results
    .filter((race): race is HyroxRace => race.sport === "hyrox")
    .sort((left, right) => right.date.localeCompare(left.date));
  const counted = workouts.filter((workout) => {
    const discipline = disciplineOf(workout);
    return discipline === "run" || discipline === "hyrox";
  });
  source.quality.records_used = counted.length;

  return {
    period,
    weekly: weekly.slice(0, MAX_WEEKS),
    sessions: confirmed
      .slice(-MAX_SESSIONS)
      .reverse()
      .map((session) => ({
        start: session.start,
        end: session.end,
        span_seconds: session.span_seconds,
        transition_share: round(session.transition_share, 4),
        run_segments: session.segments.filter((segment) => segment.role === "run").length,
        station_segments: session.segments.filter((segment) => segment.role !== "run").length,
        workout_ids: session.segments.map((segment) => segment.workout.id),
      })),
    unconfirmed_candidates: {
      count: candidates.length,
      items: candidates.slice(-MAX_CANDIDATES).reverse(),
    },
    races: races.slice(0, MAX_RACES).map((race) => {
      const implied = impliedRoxzoneSeconds(race);
      const logged = race.splits?.roxzone_seconds;
      return {
        id: race.id,
        date: race.date,
        name: race.name,
        category: race.category,
        total_seconds: race.total_seconds,
        runs_seconds: race.splits?.runs ?? null,
        stations: race.splits?.stations ?? null,
        roxzone_seconds: logged ?? implied,
        roxzone_source: logged !== undefined ? "logged" : implied !== null ? "implied" : null,
        workout_id: race.workout_id ?? null,
      };
    }),
    station_analysis: analyseStations(races),
    personal_records: personalRecords(races),
    truncated:
      source.quality.truncated ||
      weekly.length > MAX_WEEKS ||
      confirmed.length > MAX_SESSIONS ||
      candidates.length > MAX_CANDIDATES ||
      races.length > MAX_RACES,
    store,
    method_version: HYROX_PERFORMANCE_METHOD_VERSION,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: now.toISOString(),
      requested_period: period,
      observed_period: workouts.length
        ? {
            start: workouts.map((workout) => workout.start).sort()[0]!,
            end: workouts
              .map((workout) => workout.start)
              .sort()
              .pop()!,
          }
        : null,
      sources: { workout: source.quality },
      method_version: HYROX_PERFORMANCE_METHOD_VERSION,
      limitations: [
        "HYROX sessions count only after you confirm them (relabel a segment or add a rule); candidates are listed separately.",
        "Load is Edwards TRIMP from heart-rate zones and under-counts sled, carry and lunge work.",
        "Race results and station analysis come from your manual logs, not WHOOP.",
      ],
    },
  };
}
