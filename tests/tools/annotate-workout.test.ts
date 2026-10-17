import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotateWorkout, annotateWorkoutOutputSchema } from "../../src/tools/annotate-workout.js";
import { PerformanceInputError } from "../../src/performance/context.js";
import { AUDIT_FILENAME, readAuditLog } from "../../src/performance/audit-log.js";
import { loadPerformanceState } from "../../src/performance/store.js";
import { getHyroxPerformance } from "../../src/tools/get-hyrox-performance.js";
import { performanceClient, workout } from "../helpers/performance-fixtures.js";

let root: string;
let dir: string;
const T1 = new Date("2026-10-20T12:00:00Z");
const T2 = new Date("2026-10-20T13:00:00Z");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "whoop-annotate-"));
  dir = join(root, "state");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("annotate_workout", () => {
  it("relabels a workout and records before/after in the audit log", async () => {
    const output = await annotateWorkout(
      { workout_id: "ff-1", action: "relabel", discipline: "hyrox", reason: "hyrox_sim" },
      { directory: dir, now: T1 }
    );
    expect(annotateWorkoutOutputSchema.parse(output)).toEqual(output);
    expect(output.before).toBeNull();
    expect(output.after).toEqual({
      action: "relabel",
      discipline: "hyrox",
      reason: "hyrox_sim",
      updated_at: T1.toISOString(),
    });
    const [entry] = (await readAuditLog(dir)).entries;
    expect(entry).toMatchObject({
      id: output.audit_entry_id,
      action: "annotate_workout",
      workout_id: "ff-1",
      before: null,
      after: output.after,
      reason: "hyrox_sim",
    });
  });

  it("makes a confirmed Functional Fitness workout count as HYROX", async () => {
    const ff = workout({
      id: "ff-1",
      sport: "functional fitness",
      start: "2026-10-17T06:00:00Z",
      durationSeconds: 3600,
    });
    await annotateWorkout(
      { workout_id: "ff-1", action: "relabel", discipline: "hyrox", reason: "hyrox_sim" },
      { directory: dir, now: T1 }
    );
    const result = await getHyroxPerformance(
      performanceClient({ workouts: [ff] }),
      {},
      { now: T2, loadState: () => loadPerformanceState(dir) }
    );
    expect(result.unconfirmed_candidates.count).toBe(0);
    expect(result.weekly[0]!.hyrox.workouts).toBe(1);
  });

  it("restore appends a new entry and never rewrites earlier ones", async () => {
    await annotateWorkout(
      { workout_id: "run-4", action: "exclude", reason: "misclassified" },
      { directory: dir, now: T1 }
    );
    const before = await readFile(join(dir, AUDIT_FILENAME), "utf-8");
    const restored = await annotateWorkout(
      { workout_id: "run-4", action: "restore", reason: "other", note: "was a real run" },
      { directory: dir, now: T2 }
    );
    const after = await readFile(join(dir, AUDIT_FILENAME), "utf-8");

    expect(after.startsWith(before)).toBe(true);
    expect(after.trim().split("\n")).toHaveLength(2);
    expect(restored.before).toMatchObject({ action: "exclude" });
    expect(restored.after).toMatchObject({ action: "restore", note: "was a real run" });
    expect((await loadPerformanceState(dir)).annotations["run-4"]!.action).toBe("restore");
  });

  it("rejects restore when there is nothing to restore", async () => {
    await expect(
      annotateWorkout(
        { workout_id: "run-9", action: "restore", reason: "other" },
        { directory: dir, now: T1 }
      )
    ).rejects.toThrow(/no override to restore/);
    expect((await readAuditLog(dir)).entries).toEqual([]);
  });

  it("validates relabel/discipline pairing with readable messages", async () => {
    const missing = await annotateWorkout(
      { workout_id: "w", action: "relabel", reason: "misclassified" },
      { directory: dir, now: T1 }
    ).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(PerformanceInputError);
    expect((missing as Error).message).toBe("discipline: relabel needs a discipline");

    await expect(
      annotateWorkout(
        { workout_id: "w", action: "exclude", discipline: "run", reason: "bad_hr" },
        { directory: dir, now: T1 }
      )
    ).rejects.toThrow("exclude does not take a discipline");
    await expect(
      annotateWorkout(
        { workout_id: "", action: "exclude", reason: "bad_hr" },
        { directory: dir, now: T1 }
      )
    ).rejects.toBeInstanceOf(PerformanceInputError);
  });

  it("serialises concurrent annotations without losing updates", async () => {
    await Promise.all(
      ["a", "b", "c", "d"].map((id) =>
        annotateWorkout(
          { workout_id: id, action: "exclude", reason: "duplicate" },
          { directory: dir, now: T1 }
        )
      )
    );
    expect(Object.keys((await loadPerformanceState(dir)).annotations).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect((await readAuditLog(dir)).entries).toHaveLength(4);
  });
});
