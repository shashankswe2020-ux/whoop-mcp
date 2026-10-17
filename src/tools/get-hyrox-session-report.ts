import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { ENDPOINT_CYCLE } from "../api/endpoints.js";
import { cycleRecordSchema } from "../api/record-schemas.js";
import type { Workout } from "../api/types.js";
import {
  baselineMean,
  disciplineResolver,
  durationSeconds,
  isoDaySchema,
  KJ_PER_KCAL,
  loadWellness,
  loadWorkouts,
  readPerformanceState,
  round,
  shiftDay,
  storeStatusSchema,
  workoutDay,
  type PerformanceDeps,
} from "../performance/context.js";
import {
  groupSessions,
  type SessionSegment,
  type TrainingSession,
} from "../performance/session-grouping.js";
import { buildCaveats, detectSuspects, type MethodNote } from "../performance/suspect-detector.js";
import {
  dataQualitySchema,
  DAY_MS,
  DISCLAIMER,
  loadAnalyticsSource,
  RECOVERY_ZONES,
} from "./analytics-utils.js";

export const SESSION_REPORT_METHOD_VERSION = "1.0.0";
export const NEGATIVE_SPLIT_HR_BPM = 5;
export const ERG_RECOVERY_HR_BPM = 10;
export const TRANSITION_HEAVY_SHARE = 0.1;
const BASELINE_DAYS = 30;

export const hyroxSessionReportInputSchema = z.object({
  date: isoDaySchema
    .optional()
    .describe(
      "Local day YYYY-MM-DD. Defaults to the most recent day with a workout in the last 7 days."
    ),
  session_start: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("Start time of a specific session (ISO 8601). Overrides the default pick."),
});

const nullableNumber = z.number().nullable();
const segmentRowSchema = z.object({
  workout_id: z.string(),
  label: z.string(),
  role: z.enum(["run", "erg_station", "functional", "other"]),
  sport_name: z.string(),
  start: z.string(),
  duration_seconds: z.number(),
  avg_hr: nullableNumber,
  max_hr: nullableNumber,
  strain: nullableNumber,
  kcal: nullableNumber,
});
const insightSchema = z.object({
  id: z.enum([
    "negative_split",
    "ergs_are_recovery",
    "transition_heavy",
    "hidden_cost",
    "day_context",
  ]),
  text: z.string(),
  rule: z.string(),
  workout_ids: z.array(z.string()),
});
const caveatSchema = z.object({
  id: z.string(),
  text: z.string(),
  workout_ids: z.array(z.string()),
});
const zoneSecondsSchema = z.object({
  zone_zero: z.number(),
  zone_one: z.number(),
  zone_two: z.number(),
  zone_three: z.number(),
  zone_four: z.number(),
  zone_five: z.number(),
});

export const hyroxSessionReportOutputSchema = z.object({
  status: z.enum(["available", "no_session"]),
  date: z.string().nullable(),
  session: z
    .object({
      start: z.string(),
      end: z.string(),
      kind: z.enum(["hyrox_candidate", "other"]),
      confirmed_hyrox: z.boolean(),
      span_seconds: z.number(),
      tracked_seconds: z.number(),
      transition_seconds: z.number(),
      transition_share: z.number(),
      peak_hr: nullableNumber,
      kcal: z.number(),
      segment_count: z.number().int(),
    })
    .nullable(),
  day_context: z.object({
    recovery_score: nullableNumber,
    recovery_band: z.enum(["red", "yellow", "green"]).nullable(),
    hrv_rmssd_milli: nullableNumber,
    hrv_baseline_milli: nullableNumber,
    resting_heart_rate: nullableNumber,
    rhr_baseline: nullableNumber,
    baseline_days: z.number().int(),
    sleep_hours: nullableNumber,
    sleep_performance_pct: nullableNumber,
    respiratory_rate: nullableNumber,
    spo2_pct: nullableNumber,
    day_strain: nullableNumber,
  }),
  time_in_zone_seconds: zoneSecondsSchema.nullable(),
  segments: z.array(segmentRowSchema),
  other_activities: z.array(segmentRowSchema),
  insights: z.array(insightSchema),
  caveats: z.array(caveatSchema),
  sessions_on_day: z.array(
    z.object({ start: z.string(), kind: z.string(), segment_count: z.number() })
  ),
  store: storeStatusSchema,
  method_version: z.string(),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});
export type HyroxSessionReport = z.infer<typeof hyroxSessionReportOutputSchema>;
type Insight = z.infer<typeof insightSchema>;
type SegmentRow = z.infer<typeof segmentRowSchema>;

function row(segment: Pick<SessionSegment, "workout" | "label" | "role">): SegmentRow {
  const { workout } = segment;
  return {
    workout_id: workout.id,
    label: segment.label,
    role: segment.role,
    sport_name: workout.sport_name,
    start: workout.start,
    duration_seconds: durationSeconds(workout),
    avg_hr: workout.score?.average_heart_rate ?? null,
    max_hr: workout.score?.max_heart_rate ?? null,
    strain: workout.score?.strain ?? null,
    kcal: workout.score ? round(workout.score.kilojoule / KJ_PER_KCAL, 0) : null,
  };
}

function meanOf(values: number[]): number | null {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function recoveryBand(score: number | null): "red" | "yellow" | "green" | null {
  if (score === null) return null;
  if (score < RECOVERY_ZONES.red_below) return "red";
  return score > RECOVERY_ZONES.green_above ? "green" : "yellow";
}

const ZONE_KEYS = [
  ["zone_zero", "zone_zero_milli"],
  ["zone_one", "zone_one_milli"],
  ["zone_two", "zone_two_milli"],
  ["zone_three", "zone_three_milli"],
  ["zone_four", "zone_four_milli"],
  ["zone_five", "zone_five_milli"],
] as const;

function summedZones(workouts: Workout[]): z.infer<typeof zoneSecondsSchema> | null {
  const scored = workouts.filter((workout) => workout.score);
  if (!scored.length) return null;
  const totals = {
    zone_zero: 0,
    zone_one: 0,
    zone_two: 0,
    zone_three: 0,
    zone_four: 0,
    zone_five: 0,
  };
  for (const workout of scored)
    for (const [key, source] of ZONE_KEYS)
      totals[key] += workout.score!.zone_durations[source] / 1000;
  return totals;
}

/** Each insight is emitted only when its rule fires and every input is present. */
export function sessionInsights(
  session: TrainingSession,
  otherSegments: SegmentRow[],
  context: { recovery_score: number | null; zones: z.infer<typeof zoneSecondsSchema> | null }
): Insight[] {
  const insights: Insight[] = [];
  const runs = session.segments.filter(
    (segment) => segment.role === "run" && segment.workout.score
  );
  const ergs = session.segments.filter(
    (segment) => segment.role === "erg_station" && segment.workout.score
  );
  const hr = (segment: SessionSegment): number => segment.workout.score!.average_heart_rate;

  if (runs.length >= 2) {
    const first = runs[0]!;
    const last = runs[runs.length - 1]!;
    if (
      hr(last) >= hr(first) + NEGATIVE_SPLIT_HR_BPM &&
      last.duration_seconds <= first.duration_seconds
    )
      insights.push({
        id: "negative_split",
        text: `${last.label} was your hardest and fastest run: avg ${hr(last)} bpm in ${last.duration_seconds}s vs ${first.label} at ${hr(first)} bpm in ${first.duration_seconds}s.`,
        rule: `last run avg HR ≥ first run avg HR + ${NEGATIVE_SPLIT_HR_BPM} bpm and last run duration ≤ first run duration`,
        workout_ids: [first.workout.id, last.workout.id],
      });
  }

  const runMean = meanOf(runs.map(hr));
  const ergMean = meanOf(ergs.map(hr));
  if (runMean !== null && ergMean !== null && ergMean <= runMean - ERG_RECOVERY_HR_BPM)
    insights.push({
      id: "ergs_are_recovery",
      text: `Erg stations averaged ${round(ergMean)} bpm vs ${round(runMean)} bpm on runs — your heart rate recovered on the ergs instead of staying at race effort.`,
      rule: `mean erg avg HR ≤ mean run avg HR − ${ERG_RECOVERY_HR_BPM} bpm`,
      workout_ids: [...ergs, ...runs].map((segment) => segment.workout.id),
    });

  if (session.span_seconds > 0 && session.transition_share >= TRANSITION_HEAVY_SHARE)
    insights.push({
      id: "transition_heavy",
      text: `${Math.round(session.transition_seconds)}s (${round(session.transition_share * 100)}%) of the block was untracked transition time between segments.`,
      rule: `transition time ≥ ${TRANSITION_HEAVY_SHARE * 100}% of session span`,
      workout_ids: session.segments.map((segment) => segment.workout.id),
    });

  const sessionStrains = session.segments
    .map((segment) => segment.workout.score?.strain)
    .filter((value): value is number => value !== undefined);
  const maxSegment = sessionStrains.length ? Math.max(...sessionStrains) : null;
  const heavier = otherSegments.filter(
    (other) => other.strain !== null && maxSegment !== null && other.strain > maxSegment
  );
  if (heavier.length)
    insights.push({
      id: "hidden_cost",
      text: `${heavier.map((other) => `${other.sport_name} (strain ${other.strain})`).join(", ")} cost more than any single segment of the session (max ${maxSegment}).`,
      rule: "an other-activity strain > the max single session segment strain",
      workout_ids: heavier.map((other) => other.workout_id),
    });

  const band = recoveryBand(context.recovery_score);
  const peakZone = context.zones
    ? [...ZONE_KEYS].reverse().find(([key]) => context.zones![key] > 0)?.[0]
    : undefined;
  if (band && peakZone)
    insights.push({
      id: "day_context",
      text: `You trained on a ${band} recovery day (${context.recovery_score}%) and reached ${peakZone.replace("_", " ")}.`,
      rule: `recovery band at session start (< ${RECOVERY_ZONES.red_below} red, > ${RECOVERY_ZONES.green_above} green) with the highest zone that has time`,
      workout_ids: session.segments.map((segment) => segment.workout.id),
    });
  return insights;
}

function pickSession(
  sessions: TrainingSession[],
  sessionStart: string | undefined
): TrainingSession | undefined {
  if (sessionStart) {
    const target = Date.parse(sessionStart);
    return sessions.find(
      (session) => Date.parse(session.start) <= target && target <= Date.parse(session.end)
    );
  }
  const score = (session: TrainingSession): number =>
    (session.kind === "hyrox_candidate" ? 1e9 : 0) + session.span_seconds;
  return [...sessions].sort((left, right) => score(right) - score(left))[0];
}

export async function getHyroxSessionReport(
  client: WhoopClient,
  params: z.infer<typeof hyroxSessionReportInputSchema> = {},
  deps: PerformanceDeps = {}
): Promise<HyroxSessionReport> {
  const input = hyroxSessionReportInputSchema.parse(params);
  const now = deps.now ?? new Date();
  const anchor = input.session_start
    ? input.session_start.slice(0, 10)
    : (input.date ?? new Date(now.getTime() - 6 * DAY_MS).toISOString().slice(0, 10));
  const lastDay = input.session_start ? anchor : (input.date ?? now.toISOString().slice(0, 10));
  const period = {
    start: new Date(Date.parse(`${shiftDay(anchor, -1)}T00:00:00Z`)).toISOString(),
    end: new Date(
      Math.min(Date.parse(`${shiftDay(lastDay, 2)}T00:00:00Z`), now.getTime())
    ).toISOString(),
  };
  if (Date.parse(period.start) >= Date.parse(period.end))
    throw new RangeError("The requested day is in the future.");

  const [{ state, store }, workoutSource] = await Promise.all([
    readPerformanceState(deps.loadState),
    loadWorkouts(client, period),
  ]);
  const disciplineOf = disciplineResolver(state);
  const target = input.session_start ? Date.parse(input.session_start) : null;
  const containing =
    target === null
      ? undefined
      : workoutSource.records.find(
          (workout) => Date.parse(workout.start) <= target && target <= Date.parse(workout.end)
        );
  const latestDay = workoutSource.records.map(workoutDay).sort().pop() ?? null;
  const day =
    target === null ? (input.date ?? latestDay) : containing ? workoutDay(containing) : null;
  const dayWorkouts = day
    ? workoutSource.records.filter((workout) => workoutDay(workout) === day)
    : [];
  const sessions = groupSessions(dayWorkouts, disciplineOf);
  const session = pickSession(sessions, input.session_start);

  const wellnessPeriod = {
    start: `${shiftDay(day ?? lastDay, -(BASELINE_DAYS + 1))}T00:00:00.000Z`,
    end: new Date(
      Math.min(Date.parse(`${shiftDay(day ?? lastDay, 1)}T12:00:00Z`), now.getTime())
    ).toISOString(),
  };
  const [wellness, cycles] = await Promise.all([
    loadWellness(client, wellnessPeriod),
    session
      ? loadAnalyticsSource(
          client,
          ENDPOINT_CYCLE,
          {
            start: new Date(Date.parse(session.start) - DAY_MS).toISOString(),
            end: new Date(Math.min(Date.parse(session.end) + DAY_MS, now.getTime())).toISOString(),
          },
          cycleRecordSchema
        )
      : Promise.resolve(null),
  ]);
  const today = day ? wellness.days.find((entry) => entry.date === day) : undefined;
  const hrvBaseline = day
    ? baselineMean(wellness.days, day, (entry) => entry.hrv_rmssd_milli, BASELINE_DAYS)
    : { mean: null, count: 0 };
  const rhrBaseline = day
    ? baselineMean(wellness.days, day, (entry) => entry.resting_heart_rate, BASELINE_DAYS)
    : { mean: null, count: 0 };
  const dayCycle = session
    ? cycles?.records.find(
        (record) =>
          Date.parse(record.start) <= Date.parse(session.start) &&
          (!record.end || Date.parse(session.start) < Date.parse(record.end))
      )
    : undefined;

  const sessionIds = new Set(session?.segments.map((segment) => segment.workout.id) ?? []);
  const otherActivities = sessions
    .filter((candidate) => candidate !== session)
    .flatMap((candidate) => candidate.segments)
    .filter((segment) => !sessionIds.has(segment.workout.id))
    .map((segment) => row({ ...segment, label: segment.workout.sport_name, role: "other" }));
  const zones = session ? summedZones(session.segments.map((segment) => segment.workout)) : null;
  const recoveryScore = today?.recovery_score ?? null;
  const insights = session
    ? sessionInsights(session, otherActivities, { recovery_score: recoveryScore, zones })
    : [];

  const flags = detectSuspects(dayWorkouts, sessions);
  const notes: MethodNote[] = ["strain_not_additive", "estimated_max_hr", "no_hr_curve"];
  if (session?.kind === "hyrox_candidate") notes.splice(2, 0, "hyrox_stations_invisible");
  const confirmed = Boolean(
    session?.segments.some((segment) => disciplineOf(segment.workout) === "hyrox")
  );
  const peaks = session?.segments
    .map((segment) => segment.workout.score?.max_heart_rate)
    .filter((value): value is number => value !== undefined);

  workoutSource.quality.records_used = dayWorkouts.length;
  return {
    status: session ? "available" : "no_session",
    date: day,
    session: session
      ? {
          start: session.start,
          end: session.end,
          kind: session.kind,
          confirmed_hyrox: confirmed,
          span_seconds: session.span_seconds,
          tracked_seconds: session.tracked_seconds,
          transition_seconds: session.transition_seconds,
          transition_share: round(session.transition_share, 4),
          peak_hr: peaks?.length ? Math.max(...peaks) : null,
          kcal: round(
            session.segments.reduce(
              (total, segment) => total + (segment.workout.score?.kilojoule ?? 0),
              0
            ) / KJ_PER_KCAL,
            0
          ),
          segment_count: session.segments.length,
        }
      : null,
    day_context: {
      recovery_score: recoveryScore,
      recovery_band: recoveryBand(recoveryScore),
      hrv_rmssd_milli: today?.hrv_rmssd_milli ?? null,
      hrv_baseline_milli: hrvBaseline.mean === null ? null : round(hrvBaseline.mean),
      resting_heart_rate: today?.resting_heart_rate ?? null,
      rhr_baseline: rhrBaseline.mean === null ? null : round(rhrBaseline.mean),
      baseline_days: hrvBaseline.count,
      sleep_hours:
        today?.sleep_hours === undefined || today.sleep_hours === null
          ? null
          : round(today.sleep_hours, 2),
      sleep_performance_pct: today?.sleep_performance_pct ?? null,
      respiratory_rate: today?.respiratory_rate ?? null,
      spo2_pct: today?.spo2_pct ?? null,
      day_strain: dayCycle?.score?.strain ?? null,
    },
    time_in_zone_seconds: zones,
    segments: session?.segments.map(row) ?? [],
    other_activities: otherActivities,
    insights,
    caveats: buildCaveats(flags, notes),
    sessions_on_day: sessions.map((candidate) => ({
      start: candidate.start,
      kind: candidate.kind,
      segment_count: candidate.segments.length,
    })),
    store,
    method_version: SESSION_REPORT_METHOD_VERSION,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: now.toISOString(),
      requested_period: period,
      observed_period: session ? { start: session.start, end: session.end } : null,
      sources: {
        workout: workoutSource.quality,
        ...wellness.sources,
        ...(cycles ? { cycle: cycles.quality } : {}),
      },
      method_version: SESSION_REPORT_METHOD_VERSION,
      limitations: [
        "Sessions are inferred from workouts starting ≤ 10 min apart; WHOOP does not record HYROX stations.",
        "Segments are numbered by role and never mapped to official station numbers.",
        "Day context uses the main sleep ending on the session day and a 30-day mean baseline.",
      ],
    },
  };
}
