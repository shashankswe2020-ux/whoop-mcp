import { z } from "zod";
import { appendAuditEntry } from "../performance/audit-log.js";
import {
  inputErrorFrom,
  PerformanceInputError,
  type PerformanceWriteDeps,
} from "../performance/context.js";
import {
  ANNOTATION_REASONS,
  annotationInputSchema,
  disciplineSchema,
  storedAnnotationSchema,
  type StoredAnnotation,
} from "../performance/schemas.js";
import { updatePerformanceState } from "../performance/store.js";

export const annotateWorkoutInputSchema = z.object({
  workout_id: z.string().describe("WHOOP workout id."),
  action: z
    .enum(["relabel", "exclude", "restore"])
    .describe("relabel = change discipline, exclude = drop from metrics, restore = undo override."),
  discipline: disciplineSchema
    .optional()
    .describe("Required for relabel, e.g. 'hyrox' to confirm a HYROX sim."),
  reason: z.enum(ANNOTATION_REASONS),
  note: z.string().optional(),
});

export const annotateWorkoutOutputSchema = z.object({
  workout_id: z.string(),
  before: storedAnnotationSchema.nullable(),
  after: storedAnnotationSchema,
  audit_entry_id: z.string(),
});
export type AnnotateWorkoutOutput = z.infer<typeof annotateWorkoutOutputSchema>;

/**
 * Records an override for one workout. The WHOOP record itself is never changed or deleted;
 * `restore` stores a new "restore" annotation (no override) and appends a new audit entry.
 */
export async function annotateWorkout(
  params: z.infer<typeof annotateWorkoutInputSchema>,
  deps: PerformanceWriteDeps = {}
): Promise<AnnotateWorkoutOutput> {
  const now = deps.now ?? new Date();
  const parsed = annotationInputSchema.safeParse(params);
  if (!parsed.success) throw inputErrorFrom(parsed.error);
  const { workout_id: workoutId, ...rest } = parsed.data;
  const after: StoredAnnotation = { ...rest, updated_at: now.toISOString() };

  const before = await updatePerformanceState((state) => {
    const previous = state.annotations[workoutId] ?? null;
    if (after.action === "restore" && (!previous || previous.action === "restore"))
      throw new PerformanceInputError(`Workout ${workoutId} has no override to restore.`);
    return {
      state: { ...state, annotations: { ...state.annotations, [workoutId]: after } },
      result: previous,
    };
  }, deps.directory);

  const entry = await appendAuditEntry(
    {
      actor: deps.actor ?? "mcp_tool",
      action: "annotate_workout",
      workout_id: workoutId,
      before,
      after,
      reason: after.reason,
    },
    deps.directory,
    now
  );
  return { workout_id: workoutId, before, after, audit_entry_id: entry.id };
}
