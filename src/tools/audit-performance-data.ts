import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import {
  candidateSchema,
  classifySessions,
  disciplineResolver,
  loadWorkouts,
  readPerformanceState,
  resolveWindow,
  storeStatusSchema,
  windowInputShape,
  type AuditLogPage,
  type PerformanceDeps,
  type StoreStatus,
} from "../performance/context.js";
import {
  auditEntrySchema,
  classificationRuleSchema,
  storedAnnotationSchema,
} from "../performance/schemas.js";
import { groupSessions } from "../performance/session-grouping.js";
import { buildCaveats, detectSuspects } from "../performance/suspect-detector.js";
import { PerformanceStoreError } from "../performance/store.js";
import { dataQualitySchema, DISCLAIMER } from "./analytics-utils.js";

export const AUDIT_PERFORMANCE_METHOD_VERSION = "1.0.0";
const DEFAULT_DAYS = 28;
const MAX_DAYS = 366;
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;
const MAX_ITEMS = 200;

export const auditPerformanceDataInputSchema = z.object({
  ...windowInputShape,
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOG_LIMIT)
    .optional()
    .describe(`Most recent audit-log entries to return (default ${DEFAULT_LOG_LIMIT}).`),
});

export const auditPerformanceDataOutputSchema = z.object({
  period: z.object({ start: z.string(), end: z.string() }),
  annotations: z.array(
    storedAnnotationSchema.extend({
      workout_id: z.string(),
      sport_name: z.string().nullable(),
      start: z.string().nullable(),
    })
  ),
  rules: z.array(classificationRuleSchema),
  audit_log: z.object({
    entries: z.array(auditEntrySchema),
    invalid_lines: z.number().int(),
    truncated: z.boolean(),
  }),
  suspects: z.array(
    z.object({
      rule: z.string(),
      workout_id: z.string(),
      sport_name: z.string(),
      start: z.string(),
      detail: z.string(),
      related_workout_id: z.string().nullable(),
    })
  ),
  unconfirmed_candidates: z.array(candidateSchema),
  excluded_workout_ids: z.array(z.string()),
  caveats: z.array(
    z.object({ id: z.string(), text: z.string(), workout_ids: z.array(z.string()) })
  ),
  truncated: z.boolean(),
  store: storeStatusSchema,
  method_version: z.string(),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});
export type AuditPerformanceData = z.infer<typeof auditPerformanceDataOutputSchema>;

async function readLog(
  readAudit: PerformanceDeps["readAudit"],
  limit: number
): Promise<{ page: AuditLogPage; error: StoreStatus | null }> {
  const empty: AuditLogPage = { entries: [], invalid_lines: 0, truncated: false };
  if (!readAudit) return { page: empty, error: null };
  try {
    return { page: await readAudit(limit), error: null };
  } catch (error: unknown) {
    return {
      page: empty,
      error: {
        status: "error",
        message:
          error instanceof PerformanceStoreError
            ? error.message
            : "The local audit log could not be read.",
      },
    };
  }
}

/** Everything the user (or the assistant) needs to check the numbers: overrides, history and suspects. */
export async function auditPerformanceData(
  client: WhoopClient,
  params: z.infer<typeof auditPerformanceDataInputSchema> = {},
  deps: PerformanceDeps = {}
): Promise<AuditPerformanceData> {
  const input = auditPerformanceDataInputSchema.parse(params);
  const now = deps.now ?? new Date();
  const period = resolveWindow(input, now, DEFAULT_DAYS, MAX_DAYS);
  const [{ state, store: stateStore }, source, log] = await Promise.all([
    readPerformanceState(deps.loadState),
    loadWorkouts(client, period),
    readLog(deps.readAudit, input.limit ?? DEFAULT_LOG_LIMIT),
  ]);
  const store = stateStore.status === "available" && log.error ? log.error : stateStore;
  const disciplineOf = disciplineResolver(state);
  const workouts = source.records.filter(
    (workout) => Date.parse(workout.start) >= Date.parse(period.start)
  );
  const byId = new Map(workouts.map((workout) => [workout.id, workout]));
  const excluded = workouts.filter((workout) => disciplineOf(workout) === "excluded");
  const active = workouts.filter((workout) => disciplineOf(workout) !== "excluded");
  const sessions = groupSessions(active, disciplineOf);
  const flags = detectSuspects(active, sessions);
  const { candidates } = classifySessions(sessions, disciplineOf);

  const annotations = Object.entries(state.annotations)
    .map(([workoutId, annotation]) => ({
      ...annotation,
      workout_id: workoutId,
      sport_name: byId.get(workoutId)?.sport_name ?? null,
      start: byId.get(workoutId)?.start ?? null,
    }))
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const suspects = flags.map((flag) => ({
    rule: flag.rule,
    workout_id: flag.workout_id,
    sport_name: byId.get(flag.workout_id)!.sport_name,
    start: byId.get(flag.workout_id)!.start,
    detail: flag.detail,
    related_workout_id: flag.related_workout_id ?? null,
  }));
  if (excluded.length) source.quality.exclusions.user_excluded = excluded.length;
  source.quality.records_used = active.length;

  return {
    period,
    annotations: annotations.slice(0, MAX_ITEMS),
    rules: state.rules,
    audit_log: log.page,
    suspects: suspects.slice(0, MAX_ITEMS),
    unconfirmed_candidates: candidates.slice(0, MAX_ITEMS),
    excluded_workout_ids: excluded.map((workout) => workout.id).slice(0, MAX_ITEMS),
    caveats: buildCaveats(flags, ["estimated_max_hr", "strain_not_additive"]),
    truncated:
      source.quality.truncated ||
      log.page.truncated ||
      [annotations, suspects, candidates, excluded].some((list) => list.length > MAX_ITEMS),
    store,
    method_version: AUDIT_PERFORMANCE_METHOD_VERSION,
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
      method_version: AUDIT_PERFORMANCE_METHOD_VERSION,
      limitations: [
        "Suspect flags are heuristics: they never change or exclude data on their own.",
        "Annotations and rules apply to every tool; the audit log is append-only and never edited.",
      ],
    },
  };
}
