import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import type { Workout } from "../api/types.js";
import {
  classifySessions,
  disciplineResolver,
  durationSeconds,
  loadWellness,
  loadWorkouts,
  PerformanceInputError,
  readPerformanceState,
  resolveWindow,
  round,
  storeStatusSchema,
  windowInputShape,
  type PerformanceDeps,
} from "../performance/context.js";
import { disciplineSchema } from "../performance/schemas.js";
import { groupSessions } from "../performance/session-grouping.js";
import type { Discipline, ResolvedDiscipline } from "../performance/sport-classifier.js";
import { detectSuspects } from "../performance/suspect-detector.js";
import { edwardsTrimp } from "../performance/training-load.js";
import {
  dataQualitySchema,
  DAY_MS,
  DISCLAIMER,
  localDay,
  type SourceQuality,
} from "./analytics-utils.js";

export const VERIFY_CLAIM_METHOD_VERSION = "1.0.0";
const MAX_DAYS = 366;
const MAX_EVIDENCE_IDS = 100;

export const CLAIM_METRICS = [
  "discipline_share_pct",
  "workout_count",
  "training_minutes",
  "trimp_total",
  "distance_km",
  "avg_recovery",
  "load_change_pct",
  "hyrox_sessions",
] as const;
type ClaimMetric = (typeof CLAIM_METRICS)[number];

interface Tolerance {
  relative: number;
  absolute: number;
  rule: string;
}

const TOLERANCES: Readonly<Record<ClaimMetric, Tolerance>> = {
  discipline_share_pct: { relative: 0, absolute: 2, rule: "±2 percentage points" },
  workout_count: { relative: 0, absolute: 0, rule: "exact" },
  training_minutes: { relative: 0.02, absolute: 1, rule: "±2 % or ±1 min, whichever is larger" },
  trimp_total: { relative: 0.02, absolute: 1, rule: "±2 % or ±1 TRIMP, whichever is larger" },
  distance_km: { relative: 0.02, absolute: 0.1, rule: "±2 % or ±0.1 km, whichever is larger" },
  avg_recovery: { relative: 0, absolute: 1, rule: "±1 recovery point" },
  load_change_pct: { relative: 0, absolute: 2, rule: "±2 percentage points" },
  hyrox_sessions: { relative: 0, absolute: 0, rule: "exact" },
};

const METHODS: Readonly<Record<ClaimMetric, string>> = {
  discipline_share_pct:
    "Edwards TRIMP of the discipline ÷ TRIMP of the scope × 100. Scope: triathlon = swim + bike + run, HYROX = run + hyrox, otherwise all workouts.",
  workout_count: "Number of non-excluded WHOOP workouts in scope that start inside the period.",
  training_minutes: "Sum of workout durations (end − start) in scope, in minutes.",
  trimp_total: "Sum of Edwards TRIMP (zone minutes × zone number) for workouts in scope.",
  distance_km:
    "Sum of WHOOP distance in scope, ignoring workouts flagged implausible_pace or indoor_distance.",
  avg_recovery:
    "Mean WHOOP recovery score of wake-up days inside the period, excluding calibration days.",
  load_change_pct:
    "(TRIMP in period − TRIMP in comparison_period) ÷ TRIMP in comparison_period × 100, same scope.",
  hyrox_sessions:
    "Training sessions with at least one segment confirmed as HYROX (relabel or rule). Candidates are not counted.",
};

const SCOPES: Readonly<Record<"hyrox" | "triathlon", readonly Discipline[]>> = {
  triathlon: ["swim", "bike", "run"],
  hyrox: ["run", "hyrox"],
};

const periodSchema = z.object({
  start: windowInputShape.start.unwrap().describe("Period start (YYYY-MM-DD or ISO 8601)."),
  end: windowInputShape.end.unwrap().describe("Period end (YYYY-MM-DD or ISO 8601)."),
});

export const verifyClaimInputSchema = z.object({
  metric: z.enum(CLAIM_METRICS),
  claimed_value: z.number().finite().describe("The number the assistant stated."),
  period: periodSchema,
  discipline: disciplineSchema
    .optional()
    .describe("Restrict to one discipline (required for discipline_share_pct)."),
  sport: z
    .enum(["hyrox", "triathlon"])
    .optional()
    .describe("Restrict scope to the race's disciplines; also the share denominator."),
  comparison_period: periodSchema.optional().describe("Required for load_change_pct."),
});

export const verifyClaimOutputSchema = z.object({
  verdict: z.enum(["confirmed", "contradicted", "unverifiable"]),
  metric: z.enum(CLAIM_METRICS),
  claimed_value: z.number(),
  recomputed_value: z.number().nullable(),
  difference: z.number().nullable(),
  tolerance: z.object({ value: z.number().nullable(), rule: z.string() }),
  reason: z.string(),
  evidence: z.object({
    window: z.object({ start: z.string(), end: z.string() }),
    comparison_window: z.object({ start: z.string(), end: z.string() }).nullable(),
    workout_ids: z.array(z.string()),
    workout_ids_truncated: z.boolean(),
    inputs: z.record(z.string(), z.number().nullable()),
    unconfirmed_candidate_ids: z.array(z.string()),
  }),
  method: z.string(),
  method_version: z.string(),
  store: storeStatusSchema,
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});
export type VerifyClaimResult = z.infer<typeof verifyClaimOutputSchema>;

interface Computation {
  value: number | null;
  ids: string[];
  inputs: Record<string, number | null>;
  missing?: string;
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
const trimpOf = (workouts: Workout[]): number =>
  sum(workouts.map((workout) => (workout.score ? edwardsTrimp(workout.score.zone_durations) : 0)));

/** Recomputes one number from raw WHOOP data + local overrides and checks it. Never guesses. */
export async function verifyClaim(
  client: WhoopClient,
  params: z.infer<typeof verifyClaimInputSchema>,
  deps: PerformanceDeps = {}
): Promise<VerifyClaimResult> {
  const input = verifyClaimInputSchema.parse(params);
  const now = deps.now ?? new Date();
  const { metric } = input;
  if (metric === "discipline_share_pct" && !input.discipline)
    throw new PerformanceInputError("discipline: discipline_share_pct needs a discipline");
  if (metric === "load_change_pct" && !input.comparison_period)
    throw new PerformanceInputError("comparison_period: load_change_pct needs a comparison_period");
  if (input.discipline && input.sport && !SCOPES[input.sport].includes(input.discipline))
    throw new PerformanceInputError(
      `discipline: ${input.discipline} is not part of ${input.sport} (${SCOPES[input.sport].join(", ")})`
    );
  const period = resolveWindow(input.period, now, 0, MAX_DAYS);
  const comparison = input.comparison_period
    ? resolveWindow(input.comparison_period, now, 0, MAX_DAYS)
    : null;

  const [{ state, store }, source, previous] = await Promise.all([
    readPerformanceState(deps.loadState),
    loadWorkouts(client, period),
    comparison ? loadWorkouts(client, comparison) : Promise.resolve(null),
  ]);
  const disciplineOf = disciplineResolver(state);
  const within = (records: Workout[], window: { start: string }): Workout[] =>
    records.filter((workout) => Date.parse(workout.start) >= Date.parse(window.start));
  const workouts = within(source.records, period);
  const active = workouts.filter((workout) => disciplineOf(workout) !== "excluded");
  const excludedCount = workouts.length - active.length;
  if (excludedCount) source.quality.exclusions.user_excluded = excludedCount;

  const inScope = (discipline: ResolvedDiscipline): boolean =>
    input.discipline
      ? discipline === input.discipline
      : input.sport
        ? SCOPES[input.sport].includes(discipline as Discipline)
        : true;
  const scoped = (records: Workout[]): Workout[] =>
    records.filter(
      (workout) => disciplineOf(workout) !== "excluded" && inScope(disciplineOf(workout))
    );
  const selected = scoped(workouts);
  const sessions = groupSessions(active, disciplineOf);
  const { confirmed, candidates } = classifySessions(sessions, disciplineOf);
  const sourcesExtra: Record<string, SourceQuality> = {};

  const compute = async (): Promise<Computation> => {
    const ids = selected.map((workout) => workout.id);
    switch (metric) {
      case "workout_count":
        return { value: selected.length, ids, inputs: { workouts: selected.length } };
      case "training_minutes":
        return {
          value: sum(selected.map(durationSeconds)) / 60,
          ids,
          inputs: { workouts: selected.length },
        };
      case "trimp_total":
        return { value: trimpOf(selected), ids, inputs: { workouts: selected.length } };
      case "distance_km": {
        const ignored = new Set(
          detectSuspects(active, sessions)
            .filter((flag) => flag.rule === "implausible_pace" || flag.rule === "indoor_distance")
            .map((flag) => flag.workout_id)
        );
        const used = selected.filter(
          (workout) => !ignored.has(workout.id) && (workout.score?.distance_meter ?? 0) > 0
        );
        return {
          value: used.length
            ? sum(used.map((workout) => workout.score!.distance_meter!)) / 1000
            : null,
          ids: used.map((workout) => workout.id),
          inputs: {
            workouts_with_distance: used.length,
            distance_ignored: selected.filter((workout) => ignored.has(workout.id)).length,
          },
          missing: "No workout in scope has a plausible distance.",
        };
      }
      case "discipline_share_pct": {
        const scope = active.filter((workout) =>
          input.sport ? SCOPES[input.sport].includes(disciplineOf(workout) as Discipline) : true
        );
        const numerator = trimpOf(selected);
        const denominator = trimpOf(scope);
        return {
          value: denominator > 0 ? (numerator / denominator) * 100 : null,
          ids: scope.map((workout) => workout.id),
          inputs: { discipline_trimp: round(numerator), scope_trimp: round(denominator) },
          missing: "No heart-rate zone data in scope, so the share cannot be computed.",
        };
      }
      case "load_change_pct": {
        const before = scoped(within(previous!.records, comparison!));
        const current = trimpOf(selected);
        const base = trimpOf(before);
        return {
          value: base > 0 ? ((current - base) / base) * 100 : null,
          ids: [...ids, ...before.map((workout) => workout.id)],
          inputs: { period_trimp: round(current), comparison_trimp: round(base) },
          missing: "The comparison period has no training load to compare against.",
        };
      }
      case "hyrox_sessions":
        return {
          value: confirmed.length,
          ids: confirmed.flatMap((session) =>
            session.segments.map((segment) => segment.workout.id)
          ),
          inputs: { confirmed_sessions: confirmed.length, candidates: candidates.length },
        };
      case "avg_recovery": {
        // A night that wakes on the first day starts the evening before.
        const wellness = await loadWellness(client, {
          start: new Date(Date.parse(period.start) - DAY_MS).toISOString(),
          end: period.end,
        });
        const offset = workouts[0]?.timezone_offset ?? "+00:00";
        const first = localDay(period.start, offset);
        const last = localDay(new Date(Date.parse(period.end) - 1).toISOString(), offset);
        const scores = wellness.days
          .filter((day) => day.date >= first && day.date <= last && !day.user_calibrating)
          .map((day) => day.recovery_score)
          .filter((value): value is number => value !== null);
        Object.assign(sourcesExtra, wellness.sources);
        return {
          value: scores.length ? sum(scores) / scores.length : null,
          ids: [],
          inputs: { days: scores.length },
          missing: "No scored recovery in the period.",
        };
      }
    }
  };
  const result = await compute();

  const tolerance = TOLERANCES[metric];
  const hyroxInvolved =
    metric === "hyrox_sessions" ||
    input.sport === "hyrox" ||
    input.discipline === "hyrox" ||
    input.discipline === "hyrox_candidate";
  const usesWorkouts = metric !== "avg_recovery";
  const truncated =
    (usesWorkouts && (source.quality.truncated || Boolean(previous?.quality.truncated))) ||
    Object.values(sourcesExtra).some((quality) => quality.truncated);
  const allowed =
    result.value === null
      ? null
      : Math.max(tolerance.absolute, Math.abs(result.value) * tolerance.relative);
  const difference = result.value === null ? null : input.claimed_value - result.value;

  let verdict: VerifyClaimResult["verdict"];
  let reason: string;
  if (result.value === null) {
    verdict = "unverifiable";
    reason = result.missing ?? "Not enough data to recompute this metric.";
  } else if (truncated) {
    verdict = "unverifiable";
    reason =
      "WHOOP returned more records than could be fetched, so the recomputed value may be incomplete.";
  } else if (hyroxInvolved && candidates.length) {
    verdict = "unverifiable";
    reason = `${candidates.length} possible HYROX session(s) are unconfirmed and could change the answer. Confirm or exclude them with annotate_workout.`;
  } else if (Math.abs(difference!) <= allowed! + 1e-9) {
    verdict = "confirmed";
    reason = `Claimed ${input.claimed_value} is within ${tolerance.rule} of the recomputed ${round(result.value, 2)}.`;
  } else {
    verdict = "contradicted";
    reason = `Claimed ${input.claimed_value} but the data gives ${round(result.value, 2)} (tolerance ${tolerance.rule}).`;
  }
  source.quality.records_used = selected.length;

  return {
    verdict,
    metric,
    claimed_value: input.claimed_value,
    recomputed_value: result.value === null ? null : round(result.value, 2),
    difference: difference === null ? null : round(difference, 2),
    tolerance: { value: allowed === null ? null : round(allowed, 2), rule: tolerance.rule },
    reason,
    evidence: {
      window: period,
      comparison_window: comparison,
      workout_ids: result.ids.slice(0, MAX_EVIDENCE_IDS),
      workout_ids_truncated: result.ids.length > MAX_EVIDENCE_IDS,
      inputs: result.inputs,
      unconfirmed_candidate_ids: hyroxInvolved
        ? candidates.flatMap((candidate) => candidate.workout_ids).slice(0, MAX_EVIDENCE_IDS)
        : [],
    },
    method: METHODS[metric],
    method_version: VERIFY_CLAIM_METHOD_VERSION,
    store,
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
      sources: {
        workout: source.quality,
        ...(previous ? { comparison_workout: previous.quality } : {}),
        ...sourcesExtra,
      },
      method_version: VERIFY_CLAIM_METHOD_VERSION,
      limitations: [
        "Only the listed metrics can be verified; anything else is out of scope, not false.",
        "Values are recomputed from WHOOP data plus your local relabels and exclusions.",
      ],
    },
  };
}
