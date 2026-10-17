import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditPerformanceData,
  auditPerformanceDataOutputSchema,
} from "../../src/tools/audit-performance-data.js";
import { annotateWorkout } from "../../src/tools/annotate-workout.js";
import { readAuditLog } from "../../src/performance/audit-log.js";
import { loadPerformanceState, PerformanceStoreError } from "../../src/performance/store.js";
import { performanceClient, redditHyroxDay } from "../helpers/performance-fixtures.js";

const NOW = new Date("2026-10-20T12:00:00Z");
let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "whoop-audit-"));
  dir = join(root, "state");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("audit_performance_data", () => {
  it("lists suspects, candidates and caveats from WHOOP data alone (remote mode)", async () => {
    const result = await auditPerformanceData(
      performanceClient({ workouts: redditHyroxDay() }),
      {},
      { now: NOW }
    );

    expect(auditPerformanceDataOutputSchema.parse(result)).toEqual(result);
    expect(result.store.status).toBe("not_configured");
    expect(result.audit_log.entries).toEqual([]);
    const rules = result.suspects.map((flag) => `${flag.rule}:${flag.workout_id}`);
    expect(rules).toEqual(
      expect.arrayContaining([
        "short_segment_mislabel:run-4",
        "indoor_distance:ski-1",
        "indoor_distance:run-6",
      ])
    );
    expect(result.suspects.find((flag) => flag.workout_id === "run-4")).toMatchObject({
      sport_name: "running",
      start: "2026-10-15T14:30:10.000Z",
    });
    expect(result.unconfirmed_candidates).toHaveLength(1);
    expect(result.unconfirmed_candidates[0]!.workout_ids).toContain("run-1");
    expect(result.caveats.map((caveat) => caveat.id)).toEqual(
      expect.arrayContaining(["short_segment_mislabel", "estimated_max_hr"])
    );
    expect(result.excluded_workout_ids).toEqual([]);
  });

  it("reflects annotations and the audit log after the user corrects data", async () => {
    const write = { directory: dir, now: NOW };
    await annotateWorkout(
      { workout_id: "run-1", action: "relabel", discipline: "hyrox", reason: "hyrox_sim" },
      write
    );
    await annotateWorkout(
      { workout_id: "run-4", action: "exclude", reason: "misclassified" },
      write
    );

    const result = await auditPerformanceData(
      performanceClient({ workouts: redditHyroxDay() }),
      {},
      {
        now: NOW,
        loadState: () => loadPerformanceState(dir),
        readAudit: (limit) => readAuditLog(dir, { limit }),
      }
    );

    expect(result.store.status).toBe("available");
    expect(result.unconfirmed_candidates).toEqual([]);
    expect(result.excluded_workout_ids).toEqual(["run-4"]);
    expect(result.suspects.some((flag) => flag.workout_id === "run-4")).toBe(false);
    expect(
      result.annotations.map((item) => [item.workout_id, item.action, item.sport_name])
    ).toEqual(
      expect.arrayContaining([
        ["run-1", "relabel", "running"],
        ["run-4", "exclude", "running"],
      ])
    );
    expect(result.audit_log.entries.map((entry) => entry.workout_id)).toEqual(["run-4", "run-1"]);
  });

  it("caps the audit log with limit and reports truncation", async () => {
    for (const id of ["a", "b", "c"])
      await annotateWorkout(
        { workout_id: id, action: "exclude", reason: "duplicate" },
        { directory: dir, now: NOW }
      );
    const result = await auditPerformanceData(
      performanceClient({ workouts: [] }),
      { limit: 2 },
      {
        now: NOW,
        loadState: () => loadPerformanceState(dir),
        readAudit: (limit) => readAuditLog(dir, { limit }),
      }
    );
    expect(result.audit_log.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.annotations[0]!.sport_name).toBeNull();
  });

  it("degrades to a store error when the audit log cannot be read", async () => {
    const result = await auditPerformanceData(
      performanceClient({ workouts: redditHyroxDay() }),
      {},
      {
        now: NOW,
        loadState: () => loadPerformanceState(dir),
        readAudit: () => Promise.reject(new PerformanceStoreError("io", "Could not read log.")),
      }
    );
    expect(result.store).toEqual({ status: "error", message: "Could not read log." });
    expect(result.suspects.length).toBeGreaterThan(0);
  });

  it("rejects windows longer than a year", async () => {
    await expect(
      auditPerformanceData(
        performanceClient({ workouts: [] }),
        { start: "2025-01-01", end: "2026-10-01" },
        { now: NOW }
      )
    ).rejects.toThrow(RangeError);
  });
});
