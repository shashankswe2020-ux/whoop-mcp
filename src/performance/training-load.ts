import type { Workout, ZoneDurations } from "../api/types.js";
import { DAY_MS, localDay } from "../tools/analytics-utils.js";
import { classifyWorkout, type ResolvedDiscipline } from "./sport-classifier.js";

export const CTL_DAYS = 42;
export const ATL_DAYS = 7;
export const MIN_HISTORY_DAYS = 28;
export const LOAD_SPIKE_THRESHOLD = 1.5;
export const MAX_SERIES_POINTS = 90;
export const TRAINING_LOAD_METHOD_VERSION = "1.0.0";

export const TRAINING_LOAD_LIMITATIONS = [
  "Load is Edwards TRIMP from WHOOP heart-rate zone minutes; it reflects cardiovascular load and under-counts strength and muscular work.",
  "Zone boundaries depend on WHOOP's max heart rate, which is an age-based estimate unless you have set it.",
  "Fitness (42-day) and fatigue (7-day) use fixed time constants that are not individualised.",
  "The load-spike ratio is a monitoring signal only, not an injury-risk prediction.",
];

export interface LoadValues {
  ctl: number;
  atl: number;
  tsb: number;
}

export interface LoadDay extends LoadValues {
  date: string;
  load: number;
}

export interface TrainingLoadResult {
  status: "available" | "insufficient_data";
  method: "edwards_trimp_ewma";
  method_version: string;
  unit: "TRIMP";
  window: { start: string; end: string } | null;
  history_days: number;
  current: LoadValues | null;
  by_discipline: Partial<Record<ResolvedDiscipline, LoadValues>>;
  load_28d: Partial<Record<ResolvedDiscipline, number>> & { total: number };
  load_spike: { ratio: number | null; flagged: boolean; threshold: number };
  series: LoadDay[];
  series_truncated: boolean;
  inputs: {
    records_used: number;
    records_excluded: number;
    excluded_reasons: Record<string, number>;
  };
  limitations: string[];
}

export function edwardsTrimp(zones: ZoneDurations): number {
  return (
    (zones.zone_one_milli * 1 +
      zones.zone_two_milli * 2 +
      zones.zone_three_milli * 3 +
      zones.zone_four_milli * 4 +
      zones.zone_five_milli * 5) /
    60_000
  );
}

function dayIndex(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / DAY_MS;
}

function dayString(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

function step(previous: number, load: number, days: number): number {
  return previous + (load - previous) / days;
}

export function computeTrainingLoad(
  workouts: Workout[],
  options: { endDay: string; disciplineOf?: (workout: Workout) => ResolvedDiscipline }
): TrainingLoadResult {
  const disciplineOf =
    options.disciplineOf ?? ((workout: Workout) => classifyWorkout(workout.sport_name));
  const endIndex = dayIndex(options.endDay);
  const excluded: Record<string, number> = {};
  const exclude = (reason: string): void => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };

  const daily = new Map<number, Map<ResolvedDiscipline, number>>();
  let used = 0;
  for (const workout of workouts) {
    const discipline = disciplineOf(workout);
    if (discipline === "excluded") {
      exclude("user_excluded");
      continue;
    }
    if (workout.score_state !== "SCORED" || !workout.score) {
      exclude(workout.score_state === "PENDING_SCORE" ? "pending" : "unscored");
      continue;
    }
    const index = dayIndex(localDay(workout.start, workout.timezone_offset));
    if (!Number.isFinite(index) || index > endIndex) {
      exclude("outside_window");
      continue;
    }
    const day = daily.get(index) ?? new Map<ResolvedDiscipline, number>();
    day.set(discipline, (day.get(discipline) ?? 0) + edwardsTrimp(workout.score.zone_durations));
    daily.set(index, day);
    used += 1;
  }

  const inputs = {
    records_used: used,
    records_excluded: Object.values(excluded).reduce((total, count) => total + count, 0),
    excluded_reasons: excluded,
  };
  const base = {
    method: "edwards_trimp_ewma" as const,
    method_version: TRAINING_LOAD_METHOD_VERSION,
    unit: "TRIMP" as const,
    inputs,
    limitations: TRAINING_LOAD_LIMITATIONS,
  };

  const load28: Partial<Record<ResolvedDiscipline, number>> & { total: number } = { total: 0 };
  if (!daily.size) {
    return {
      ...base,
      status: "insufficient_data",
      window: null,
      history_days: 0,
      current: null,
      by_discipline: {},
      load_28d: load28,
      load_spike: { ratio: null, flagged: false, threshold: LOAD_SPIKE_THRESHOLD },
      series: [],
      series_truncated: false,
    };
  }

  const startIndex = Math.min(...daily.keys());
  const disciplines = new Set<ResolvedDiscipline>();
  for (const day of daily.values()) for (const key of day.keys()) disciplines.add(key);

  const per = new Map<ResolvedDiscipline, { ctl: number; atl: number }>();
  for (const discipline of disciplines) per.set(discipline, { ctl: 0, atl: 0 });
  let ctl = 0;
  let atl = 0;
  let acute = 0;
  const series: LoadDay[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const day = daily.get(index);
    let total = 0;
    for (const [discipline, values] of per) {
      const load = day?.get(discipline) ?? 0;
      total += load;
      values.ctl = step(values.ctl, load, CTL_DAYS);
      values.atl = step(values.atl, load, ATL_DAYS);
      if (endIndex - index < 28) {
        load28[discipline] = (load28[discipline] ?? 0) + load;
      }
    }
    ctl = step(ctl, total, CTL_DAYS);
    atl = step(atl, total, ATL_DAYS);
    if (endIndex - index < 28) load28.total += total;
    if (endIndex - index < 7) acute += total;
    series.push({ date: dayString(index), load: total, ctl, atl, tsb: ctl - atl });
  }

  const historyDays = endIndex - startIndex + 1;
  const sufficient = historyDays >= MIN_HISTORY_DAYS;
  const chronicWeekly = load28.total / 4;
  const ratio = sufficient && chronicWeekly > 0 ? acute / chronicWeekly : null;
  const byDiscipline: Partial<Record<ResolvedDiscipline, LoadValues>> = {};
  for (const [discipline, values] of per)
    byDiscipline[discipline] = { ...values, tsb: values.ctl - values.atl };

  return {
    ...base,
    status: sufficient ? "available" : "insufficient_data",
    window: { start: dayString(startIndex), end: options.endDay },
    history_days: historyDays,
    current: sufficient ? { ctl, atl, tsb: ctl - atl } : null,
    by_discipline: sufficient ? byDiscipline : {},
    load_28d: load28,
    load_spike: {
      ratio,
      flagged: ratio !== null && ratio > LOAD_SPIKE_THRESHOLD,
      threshold: LOAD_SPIKE_THRESHOLD,
    },
    series: series.slice(-MAX_SERIES_POINTS),
    series_truncated: series.length > MAX_SERIES_POINTS,
  };
}
