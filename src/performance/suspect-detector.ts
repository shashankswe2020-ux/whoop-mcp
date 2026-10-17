import type { Workout } from "../api/types.js";
import type { TrainingSession } from "./session-grouping.js";
import { classifyWorkout } from "./sport-classifier.js";

export const MIN_PERCENT_RECORDED = 80;
export const MIN_RUN_SECONDS_PER_KM = 150;
export const MIN_SWIM_SECONDS_PER_100M = 55;
export const MAX_BIKE_KMH = 60;
export const MIN_AVG_HR = 50;
export const MAX_HR = 220;
export const MAX_OVERLAP_SHARE = 0.5;
export const SHORT_RUN_SEGMENT_SECONDS = 120;
export const RUN_HR_DROP_BPM = 20;

export type SuspectRule =
  | "indoor_distance"
  | "implausible_pace"
  | "short_segment_mislabel"
  | "low_coverage"
  | "hr_out_of_range"
  | "overlap"
  | "unscored";

export interface SuspectFlag {
  rule: SuspectRule;
  workout_id: string;
  detail: string;
  related_workout_id?: string;
}

const RULE_ORDER: readonly SuspectRule[] = [
  "indoor_distance",
  "implausible_pace",
  "short_segment_mislabel",
  "low_coverage",
  "hr_out_of_range",
  "overlap",
  "unscored",
];

const RULE_TEXT: Readonly<Record<SuspectRule, string>> = {
  indoor_distance:
    "Distances logged inside an indoor HYROX session come from GPS drift and are ignored; no pace or distance is derived from them.",
  implausible_pace:
    "The logged distance implies a pace faster than humanly plausible for this sport, so the distance is treated as wrong.",
  short_segment_mislabel:
    "A 'run' segment is too short or too low in heart rate compared with your other runs; it is probably a transition or a station WHOOP labelled as a run.",
  low_coverage: `WHOOP recorded heart rate for less than ${MIN_PERCENT_RECORDED}% of the workout, so its strain and zones are under-counted.`,
  hr_out_of_range: `Average heart rate below ${MIN_AVG_HR} bpm or peak above ${MAX_HR} bpm suggests a strap or sensor problem.`,
  overlap:
    "Two workouts overlap by more than half; one may be a duplicate and could double-count load.",
  unscored: "WHOOP has not scored this workout, so it contributes no load or heart-rate data.",
};

export type MethodNote =
  "strain_not_additive" | "estimated_max_hr" | "hyrox_stations_invisible" | "no_hr_curve";

const METHOD_NOTE_TEXT: Readonly<Record<MethodNote, string>> = {
  strain_not_additive:
    "WHOOP strain is logarithmic, so segment strains never add up to the day strain; they are shown per segment and never summed.",
  estimated_max_hr:
    "Heart-rate zones are WHOOP's and rely on its estimated max heart rate; if your true max differs, every zone boundary shifts.",
  hyrox_stations_invisible:
    "Only erg stations (SkiErg, row) appear as separate WHOOP activities; sleds, carries, burpees, lunges and wall balls are absorbed into runs or transition time.",
  no_hr_curve:
    "The public WHOOP API has no second-by-second heart rate, so segments show average and peak heart rate rather than a continuous curve.",
};

export interface Caveat {
  id: SuspectRule | MethodNote;
  text: string;
  workout_ids: string[];
}

function durationSeconds(workout: Workout): number {
  return (Date.parse(workout.end) - Date.parse(workout.start)) / 1000;
}

function paceFlag(workout: Workout): string | null {
  const distance = workout.score?.distance_meter;
  const seconds = durationSeconds(workout);
  if (!distance || distance <= 0 || seconds <= 0) return null;
  const discipline = classifyWorkout(workout.sport_name);
  if (discipline === "run") {
    const pace = seconds / (distance / 1000);
    return pace < MIN_RUN_SECONDS_PER_KM ? `${pace.toFixed(1)} s/km` : null;
  }
  if (discipline === "swim") {
    const pace = seconds / (distance / 100);
    return pace < MIN_SWIM_SECONDS_PER_100M ? `${pace.toFixed(1)} s/100 m` : null;
  }
  if (discipline === "bike") {
    const speed = distance / 1000 / (seconds / 3600);
    return speed > MAX_BIKE_KMH ? `${speed.toFixed(1)} km/h` : null;
  }
  return null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Flags suspicious records. Never mutates or excludes anything. */
export function detectSuspects(workouts: Workout[], sessions: TrainingSession[]): SuspectFlag[] {
  const flags: SuspectFlag[] = [];
  const add = (flag: SuspectFlag): void => {
    if (!flags.some((item) => item.rule === flag.rule && item.workout_id === flag.workout_id))
      flags.push(flag);
  };

  for (const workout of workouts) {
    if (workout.score_state !== "SCORED" || !workout.score) {
      add({ rule: "unscored", workout_id: workout.id, detail: workout.score_state });
      continue;
    }
    const { score } = workout;
    if (score.percent_recorded < MIN_PERCENT_RECORDED)
      add({
        rule: "low_coverage",
        workout_id: workout.id,
        detail: `${score.percent_recorded}% recorded`,
      });
    const pace = paceFlag(workout);
    if (pace) add({ rule: "implausible_pace", workout_id: workout.id, detail: pace });
    if (score.average_heart_rate < MIN_AVG_HR || score.max_heart_rate > MAX_HR)
      add({
        rule: "hr_out_of_range",
        workout_id: workout.id,
        detail: `avg ${score.average_heart_rate} bpm, max ${score.max_heart_rate} bpm`,
      });
  }

  const sorted = [...workouts].sort(
    (left, right) => Date.parse(left.start) - Date.parse(right.start)
  );
  for (let index = 0; index < sorted.length; index += 1) {
    const earlier = sorted[index]!;
    for (const later of sorted.slice(index + 1)) {
      if (Date.parse(later.start) >= Date.parse(earlier.end)) break;
      const overlap =
        Math.min(Date.parse(earlier.end), Date.parse(later.end)) - Date.parse(later.start);
      const shorter = Math.min(durationSeconds(earlier), durationSeconds(later)) * 1000;
      if (shorter > 0 && overlap / shorter > MAX_OVERLAP_SHARE)
        add({
          rule: "overlap",
          workout_id: later.id,
          related_workout_id: earlier.id,
          detail: `${Math.round((overlap / shorter) * 100)}% of the shorter workout`,
        });
    }
  }

  for (const session of sessions.filter((item) => item.kind === "hyrox_candidate")) {
    for (const segment of session.segments) {
      const distance = segment.workout.score?.distance_meter;
      if (distance && distance > 0)
        add({
          rule: "indoor_distance",
          workout_id: segment.workout.id,
          detail: `${(distance / 1000).toFixed(1)} km logged for ${segment.label}`,
        });
    }
    const runs = session.segments.filter(
      (segment) => segment.role === "run" && segment.workout.score
    );
    const runMedian =
      runs.length >= 3 ? median(runs.map((run) => run.workout.score!.average_heart_rate)) : null;
    for (const run of runs) {
      const avg = run.workout.score!.average_heart_rate;
      const short = run.duration_seconds < SHORT_RUN_SEGMENT_SECONDS;
      const lowHr = runMedian !== null && avg <= runMedian - RUN_HR_DROP_BPM;
      if (short || lowHr)
        add({
          rule: "short_segment_mislabel",
          workout_id: run.workout.id,
          detail: `${run.label}: ${run.duration_seconds} s at ${avg} bpm`,
        });
    }
  }
  return flags;
}

export function buildCaveats(flags: SuspectFlag[], notes: MethodNote[]): Caveat[] {
  const caveats: Caveat[] = [];
  for (const rule of RULE_ORDER) {
    const ids = flags.filter((flag) => flag.rule === rule).map((flag) => flag.workout_id);
    if (ids.length) caveats.push({ id: rule, text: RULE_TEXT[rule], workout_ids: ids });
  }
  for (const note of notes)
    caveats.push({ id: note, text: METHOD_NOTE_TEXT[note], workout_ids: [] });
  return caveats;
}
