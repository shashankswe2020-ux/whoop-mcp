import type { Workout } from "../api/types.js";
import { localTime } from "../tools/analytics-utils.js";

export type Discipline =
  "run" | "bike" | "swim" | "multisport" | "hyrox" | "hyrox_candidate" | "other";

export type ResolvedDiscipline = Discipline | "excluded";

export interface DisciplineOverride {
  action: "relabel" | "exclude" | "restore";
  discipline?: Discipline;
}

export interface ClassificationRule {
  sport_name: string;
  discipline: Discipline;
  min_duration_minutes?: number;
  /** Local weekdays, 0 = Sunday. */
  weekdays?: number[];
}

export const BRICK_GAP_MINUTES = 15;

// Based on the official WHOOP sport list. `sport_id` is deprecated, so only names are mapped.
// Rowing, Skiing (WHOOP's SkiErg label) and Assault Bike are "other" when standalone; session
// grouping treats them as erg stations inside a chain of workouts.
const SPORT_NAME_TO_DISCIPLINE: Readonly<Record<string, Discipline>> = {
  running: "run",
  "track & field": "run",
  cycling: "bike",
  spin: "bike",
  "mountain biking": "bike",
  swimming: "swim",
  triathlon: "multisport",
  duathlon: "multisport",
  "functional fitness": "hyrox_candidate",
  hiit: "hyrox_candidate",
  "obstacle course racing": "hyrox_candidate",
};

export function normalizeSportName(sportName: string): string {
  return sportName.trim().toLowerCase();
}

export function classifyWorkout(sportName: string): Discipline {
  return SPORT_NAME_TO_DISCIPLINE[normalizeSportName(sportName)] ?? "other";
}

function ruleMatches(workout: Workout, rule: ClassificationRule): boolean {
  if (normalizeSportName(rule.sport_name) !== normalizeSportName(workout.sport_name)) return false;
  const minutes = (Date.parse(workout.end) - Date.parse(workout.start)) / 60_000;
  if (rule.min_duration_minutes !== undefined && !(minutes >= rule.min_duration_minutes))
    return false;
  if (rule.weekdays?.length) {
    const weekday = localTime(workout.start, workout.timezone_offset).getUTCDay();
    if (!rule.weekdays.includes(weekday)) return false;
  }
  return true;
}

/** Precedence: user annotation > first matching user rule > sport table. */
export function resolveDiscipline(
  workout: Workout,
  context: { annotation?: DisciplineOverride; rules?: ClassificationRule[] }
): { discipline: ResolvedDiscipline; source: "annotation" | "rule" | "table" } {
  const { annotation } = context;
  if (annotation?.action === "exclude") return { discipline: "excluded", source: "annotation" };
  if (annotation?.action === "relabel" && annotation.discipline)
    return { discipline: annotation.discipline, source: "annotation" };
  const rule = context.rules?.find((candidate) => ruleMatches(workout, candidate));
  if (rule) return { discipline: rule.discipline, source: "rule" };
  return { discipline: classifyWorkout(workout.sport_name), source: "table" };
}

export interface Brick {
  bike_id: string;
  run_id: string;
  gap_seconds: number;
}

export function findBricks(
  workouts: Workout[],
  disciplineOf: (workout: Workout) => ResolvedDiscipline = (workout) =>
    classifyWorkout(workout.sport_name)
): Brick[] {
  const bikes = workouts.filter((workout) => disciplineOf(workout) === "bike");
  const runs = workouts.filter((workout) => disciplineOf(workout) === "run");
  const bricks: Brick[] = [];
  for (const bike of bikes) {
    const bikeEnd = Date.parse(bike.end);
    const run = runs
      .map((candidate) => ({ candidate, gap: Date.parse(candidate.start) - bikeEnd }))
      .filter(({ gap }) => gap >= 0 && gap <= BRICK_GAP_MINUTES * 60_000)
      .sort((left, right) => left.gap - right.gap)[0];
    if (run)
      bricks.push({ bike_id: bike.id, run_id: run.candidate.id, gap_seconds: run.gap / 1000 });
  }
  return bricks;
}
