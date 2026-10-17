import { z } from "zod";
import type { ClassificationRule, Discipline } from "./sport-classifier.js";

export const PERFORMANCE_SCHEMA_VERSION = 1;
export const SPLIT_TOLERANCE_SECONDS = 5;

export const HYROX_STATIONS = [
  "skierg",
  "sled_push",
  "sled_pull",
  "burpee_broad_jumps",
  "row",
  "farmers_carry",
  "sandbag_lunges",
  "wall_balls",
] as const;

export const HYROX_DIVISIONS = [
  "open_men",
  "open_women",
  "pro_men",
  "pro_women",
  "doubles_men",
  "doubles_women",
  "doubles_mixed",
  "relay_men",
  "relay_women",
  "relay_mixed",
] as const;

export const TRIATHLON_DISTANCES = ["sprint", "olympic", "half", "full", "custom"] as const;

const DISCIPLINES = [
  "run",
  "bike",
  "swim",
  "multisport",
  "hyrox",
  "hyrox_candidate",
  "other",
] as const satisfies readonly Discipline[];

export const disciplineSchema = z.enum(DISCIPLINES);
export const ANNOTATION_REASONS = [
  "misclassified",
  "bad_hr",
  "duplicate",
  "not_mine",
  "hyrox_sim",
  "other",
] as const;

const seconds = z.number().int().nonnegative().max(86_400);
const positiveSeconds = z.number().int().positive().max(86_400);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const workoutId = z.string().min(1).max(64);
const timestamp = z.string().datetime({ offset: true });

export const hyroxSplitsSchema = z.object({
  runs: z.array(positiveSeconds).length(8, "HYROX has exactly 8 runs"),
  stations: z
    .array(z.object({ station: z.enum(HYROX_STATIONS), seconds: positiveSeconds }))
    .length(8, "HYROX has exactly 8 stations"),
  roxzone_seconds: seconds.optional(),
});

export const triathlonSplitsSchema = z.object({
  swim_seconds: positiveSeconds,
  t1_seconds: seconds,
  bike_seconds: positiveSeconds,
  t2_seconds: seconds,
  run_seconds: positiveSeconds,
});

const commonResultFields = {
  date: isoDay,
  name: z.string().trim().min(1).max(120),
  total_seconds: positiveSeconds,
  workout_id: workoutId.optional(),
  notes: z.string().max(1000).optional(),
};

const hyroxResultSchema = z.object({
  sport: z.literal("hyrox"),
  category: z.enum(HYROX_DIVISIONS),
  splits: hyroxSplitsSchema.optional(),
  ...commonResultFields,
});

const triathlonResultSchema = z.object({
  sport: z.literal("triathlon"),
  category: z.enum(TRIATHLON_DISTANCES),
  splits: triathlonSplitsSchema.optional(),
  ...commonResultFields,
});

const raceResultBaseSchema = z.discriminatedUnion("sport", [
  hyroxResultSchema,
  triathlonResultSchema,
]);

export type RaceResultInput = z.infer<typeof raceResultBaseSchema>;

function splitSum(result: RaceResultInput): { sum: number; complete: boolean } {
  if (!result.splits) return { sum: 0, complete: false };
  if (result.sport === "triathlon") {
    const legs = result.splits;
    return {
      sum:
        legs.swim_seconds +
        legs.t1_seconds +
        legs.bike_seconds +
        legs.t2_seconds +
        legs.run_seconds,
      complete: true,
    };
  }
  const { runs, stations, roxzone_seconds: roxzone } = result.splits;
  const sum =
    runs.reduce((total, value) => total + value, 0) +
    stations.reduce((total, item) => total + item.seconds, 0) +
    (roxzone ?? 0);
  return { sum, complete: roxzone !== undefined };
}

export function createRaceResultSchema(
  now: () => Date = () => new Date()
): typeof raceResultBaseSchema {
  return raceResultBaseSchema.superRefine((result, context) => {
    if (result.date > now().toISOString().slice(0, 10))
      context.addIssue({
        code: "custom",
        path: ["date"],
        message: "Race date cannot be in the future",
      });
    if (result.sport === "hyrox" && result.splits) {
      const order = result.splits.stations.map((item) => item.station);
      if (order.some((station, index) => station !== HYROX_STATIONS[index]))
        context.addIssue({
          code: "custom",
          path: ["splits", "stations"],
          message: `Stations must be in official order: ${HYROX_STATIONS.join(", ")}`,
        });
    }
    const { sum, complete } = splitSum(result);
    if (!result.splits) return;
    const difference = sum - result.total_seconds;
    if (complete && Math.abs(difference) > SPLIT_TOLERANCE_SECONDS)
      context.addIssue({
        code: "custom",
        path: ["total_seconds"],
        message: `Splits sum to ${sum}s but total is ${result.total_seconds}s (tolerance ±${SPLIT_TOLERANCE_SECONDS}s)`,
      });
    if (!complete && difference > SPLIT_TOLERANCE_SECONDS)
      context.addIssue({
        code: "custom",
        path: ["total_seconds"],
        message: `Runs and stations (${sum}s) exceed the total (${result.total_seconds}s) by more than ${SPLIT_TOLERANCE_SECONDS}s`,
      });
  });
}

/** Seconds of roxzone implied by total − runs − stations when roxzone was not logged. */
export function impliedRoxzoneSeconds(result: RaceResultInput): number | null {
  if (result.sport !== "hyrox" || !result.splits || result.splits.roxzone_seconds !== undefined)
    return null;
  return Math.max(0, result.total_seconds - splitSum(result).sum);
}

export const storedRaceResultSchema = raceResultBaseSchema.and(
  z.object({ id: z.string().uuid(), created_at: timestamp })
);
export type StoredRaceResult = z.infer<typeof storedRaceResultSchema>;

export const annotationInputSchema = z
  .object({
    workout_id: workoutId,
    action: z.enum(["relabel", "exclude", "restore"]),
    discipline: disciplineSchema.optional(),
    reason: z.enum(ANNOTATION_REASONS),
    note: z.string().max(1000).optional(),
  })
  .superRefine((input, context) => {
    if (input.action === "relabel" && !input.discipline)
      context.addIssue({
        code: "custom",
        path: ["discipline"],
        message: "relabel needs a discipline",
      });
    if (input.action !== "relabel" && input.discipline)
      context.addIssue({
        code: "custom",
        path: ["discipline"],
        message: `${input.action} does not take a discipline`,
      });
  });
export type AnnotationInput = z.infer<typeof annotationInputSchema>;

export const storedAnnotationSchema = z.object({
  action: z.enum(["relabel", "exclude", "restore"]),
  discipline: disciplineSchema.optional(),
  reason: z.enum(ANNOTATION_REASONS),
  note: z.string().max(1000).optional(),
  updated_at: timestamp,
});
export type StoredAnnotation = z.infer<typeof storedAnnotationSchema>;

export const classificationRuleSchema = z.object({
  sport_name: z.string().trim().min(1).max(64),
  discipline: disciplineSchema,
  min_duration_minutes: z.number().positive().max(1440).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
}) satisfies z.ZodType<ClassificationRule>;

export const performanceStateSchema = z.object({
  schema_version: z.literal(PERFORMANCE_SCHEMA_VERSION),
  race_results: z.array(storedRaceResultSchema).max(1000),
  annotations: z.record(workoutId, storedAnnotationSchema),
  rules: z.array(classificationRuleSchema).max(50),
});
export type PerformanceState = z.infer<typeof performanceStateSchema>;

export function emptyPerformanceState(): PerformanceState {
  return {
    schema_version: PERFORMANCE_SCHEMA_VERSION,
    race_results: [],
    annotations: {},
    rules: [],
  };
}

export const auditEntrySchema = z.object({
  id: z.string().uuid(),
  at: timestamp,
  actor: z.enum(["mcp_tool", "dashboard"]),
  action: z.enum(["log_race_result", "annotate_workout", "set_rules"]),
  workout_id: workoutId.optional(),
  race_id: z.string().uuid().optional(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string().max(64).optional(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
