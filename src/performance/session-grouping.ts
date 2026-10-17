import type { Workout } from "../api/types.js";
import { classifyWorkout, normalizeSportName } from "./sport-classifier.js";

export const SESSION_GAP_MINUTES = 10;

export type SegmentRole = "run" | "erg_station" | "functional" | "other";

export interface SessionSegment {
  workout: Workout;
  role: SegmentRole;
  label: string;
  duration_seconds: number;
}

export interface TrainingSession {
  kind: "hyrox_candidate" | "other";
  start: string;
  end: string;
  span_seconds: number;
  tracked_seconds: number;
  transition_seconds: number;
  transition_share: number;
  segments: SessionSegment[];
}

const ERG_LABELS: Readonly<Record<string, string>> = {
  skiing: "Ski Erg",
  rowing: "Row",
  "assault bike": "Assault Bike",
};

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function seconds(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 1000);
}

function segmentRole(workout: Workout, inChain: boolean): SegmentRole {
  const discipline = classifyWorkout(workout.sport_name);
  if (discipline === "run") return "run";
  if (discipline === "hyrox_candidate") return "functional";
  if (inChain && ERG_LABELS[normalizeSportName(workout.sport_name)]) return "erg_station";
  return "other";
}

function baseLabel(workout: Workout, role: SegmentRole): string {
  if (role === "run") return "Run";
  if (role === "functional") return "Functional";
  if (role === "erg_station") return ERG_LABELS[normalizeSportName(workout.sport_name)]!;
  return titleCase(normalizeSportName(workout.sport_name));
}

function buildSession(chain: Workout[]): TrainingSession {
  const roles = chain.map((workout) => segmentRole(workout, chain.length > 1));
  const bases = chain.map((workout, index) => baseLabel(workout, roles[index]!));
  const totals = new Map<string, number>();
  for (const base of bases) totals.set(base, (totals.get(base) ?? 0) + 1);
  const seen = new Map<string, number>();
  const segments = chain.map((workout, index) => {
    const base = bases[index]!;
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    return {
      workout,
      role: roles[index]!,
      label: totals.get(base)! > 1 ? `${base} ${ordinal}` : base,
      duration_seconds: seconds(workout.start, workout.end),
    };
  });
  const start = chain[0]!.start;
  const end = chain.reduce(
    (latest, workout) => (Date.parse(workout.end) > Date.parse(latest) ? workout.end : latest),
    chain[0]!.end
  );
  const span = seconds(start, end);
  const tracked = segments.reduce((total, segment) => total + segment.duration_seconds, 0);
  const transition = Math.max(0, span - tracked);
  const runs = roles.filter((role) => role === "run").length;
  const stations = roles.filter((role) => role === "erg_station" || role === "functional").length;
  return {
    kind: runs >= 2 && stations >= 1 ? "hyrox_candidate" : "other",
    start,
    end,
    span_seconds: span,
    tracked_seconds: tracked,
    transition_seconds: transition,
    transition_share: span > 0 ? transition / span : 0,
    segments,
  };
}

/** Chains workouts that start ≤ SESSION_GAP_MINUTES after the previous one ends. */
export function groupSessions(workouts: Workout[]): TrainingSession[] {
  const valid = workouts
    .filter(
      (workout) =>
        Number.isFinite(Date.parse(workout.start)) &&
        Number.isFinite(Date.parse(workout.end)) &&
        Date.parse(workout.end) >= Date.parse(workout.start)
    )
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  const sessions: TrainingSession[] = [];
  let chain: Workout[] = [];
  let chainEnd = 0;
  for (const workout of valid) {
    if (chain.length && Date.parse(workout.start) - chainEnd > SESSION_GAP_MINUTES * 60_000) {
      sessions.push(buildSession(chain));
      chain = [];
    }
    chain.push(workout);
    chainEnd = Math.max(chain.length > 1 ? chainEnd : 0, Date.parse(workout.end));
  }
  if (chain.length) sessions.push(buildSession(chain));
  return sessions;
}
