import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appendAuditEntry } from "../performance/audit-log.js";
import { inputErrorFrom, type PerformanceWriteDeps } from "../performance/context.js";
import {
  createRaceResultSchema,
  HYROX_DIVISIONS,
  hyroxSplitsSchema,
  impliedRoxzoneSeconds,
  storedRaceResultSchema,
  TRIATHLON_DISTANCES,
  triathlonSplitsSchema,
  type StoredRaceResult,
} from "../performance/schemas.js";
import { commitPerformanceChange } from "../performance/store.js";

/** Flat MCP-facing shape; the sport-specific rules are enforced by `createRaceResultSchema`. */
export const logRaceResultInputSchema = z.object({
  sport: z.enum(["hyrox", "triathlon"]),
  date: z.string().describe("Race day YYYY-MM-DD (not in the future)."),
  name: z.string().describe("Race name, e.g. 'HYROX Berlin'."),
  category: z
    .string()
    .describe(
      `HYROX division (${HYROX_DIVISIONS.join(", ")}) or triathlon distance (${TRIATHLON_DISTANCES.join(", ")}).`
    ),
  total_seconds: z.number().int().describe("Official finish time in seconds."),
  splits: z
    .union([hyroxSplitsSchema, triathlonSplitsSchema])
    .optional()
    .describe(
      "HYROX: { runs: [8 × seconds], stations: [8 × { station, seconds }] in official order, roxzone_seconds? }. Triathlon: { swim_seconds, t1_seconds, bike_seconds, t2_seconds, run_seconds }."
    ),
  workout_id: z.string().optional().describe("WHOOP workout recorded during the race."),
  notes: z.string().optional(),
});

export const logRaceResultOutputSchema = z.object({
  result: z.record(z.string(), z.unknown()),
  implied_roxzone_seconds: z.number().nullable(),
  warnings: z.array(z.string()),
  audit_entry_id: z.string(),
});
export type LogRaceResultOutput = z.infer<typeof logRaceResultOutputSchema>;

export async function logRaceResult(
  params: z.infer<typeof logRaceResultInputSchema>,
  deps: PerformanceWriteDeps = {}
): Promise<LogRaceResultOutput> {
  const now = deps.now ?? new Date();
  const parsed = createRaceResultSchema(() => now).safeParse(params);
  if (!parsed.success) throw inputErrorFrom(parsed.error);
  const stored: StoredRaceResult = storedRaceResultSchema.parse({
    ...parsed.data,
    id: randomUUID(),
    created_at: now.toISOString(),
  });

  // The audit append runs inside the store transaction: if it fails, the result is rolled back.
  const { warnings, entry } = await commitPerformanceChange(
    (state) => {
      const notes: string[] = [];
      const duplicate = state.race_results.find(
        (race) =>
          race.sport === stored.sport &&
          race.date === stored.date &&
          race.name.toLowerCase() === stored.name.toLowerCase()
      );
      if (duplicate)
        notes.push(
          `A ${stored.sport} result named "${stored.name}" on ${stored.date} already exists (${duplicate.id}).`
        );
      return { state: { ...state, race_results: [...state.race_results, stored] }, result: notes };
    },
    async (notes) => ({
      warnings: notes,
      entry: await appendAuditEntry(
        {
          actor: deps.actor ?? "mcp_tool",
          action: "log_race_result",
          race_id: stored.id,
          before: null,
          after: stored,
          ...(stored.workout_id ? { workout_id: stored.workout_id } : {}),
        },
        deps.directory,
        now
      ),
    }),
    deps.directory
  );
  if (!stored.splits)
    warnings.push(
      stored.sport === "hyrox"
        ? "No splits logged: this race cannot be used for station analysis."
        : "No splits logged: legs and transitions will be blank."
    );
  if (stored.workout_id)
    warnings.push("workout_id is stored as given; it is not checked against WHOOP.");

  return {
    result: stored,
    implied_roxzone_seconds: impliedRoxzoneSeconds(stored),
    warnings,
    audit_entry_id: entry.id,
  };
}
