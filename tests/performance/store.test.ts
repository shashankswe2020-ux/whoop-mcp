import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPerformanceState,
  PERFORMANCE_FILENAME,
  PerformanceStoreError,
  savePerformanceState,
  updatePerformanceState,
} from "../../src/performance/store.js";
import { appendAuditEntry, AUDIT_FILENAME, readAuditLog } from "../../src/performance/audit-log.js";
import { emptyPerformanceState } from "../../src/performance/schemas.js";

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "whoop-perf-"));
  dir = join(root, "state");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe("performance store", () => {
  it("returns an empty state when no file exists", async () => {
    expect(await loadPerformanceState(dir)).toEqual(emptyPerformanceState());
  });

  it("saves with 0700 directory and 0600 file permissions and leaves no temp files", async () => {
    const state = emptyPerformanceState();
    state.rules.push({ sport_name: "functional fitness", discipline: "hyrox" });
    await savePerformanceState(state, dir);
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(join(dir, PERFORMANCE_FILENAME))).toBe(0o600);
    expect(await readdir(dir)).toEqual([PERFORMANCE_FILENAME]);
    expect(await loadPerformanceState(dir)).toEqual(state);
  });

  it.each([
    ["corrupt", "{not json"],
    ["invalid_schema", JSON.stringify({ schema_version: 99 })],
  ])("throws a typed %s error and never overwrites the file", async (code, content) => {
    await savePerformanceState(emptyPerformanceState(), dir);
    const file = join(dir, PERFORMANCE_FILENAME);
    await writeFile(file, content);
    await expect(loadPerformanceState(dir)).rejects.toMatchObject({
      name: "PerformanceStoreError",
      code,
    });
    await expect(
      updatePerformanceState((state) => ({ state, result: null }), dir)
    ).rejects.toBeInstanceOf(PerformanceStoreError);
    expect(await readFile(file, "utf-8")).toBe(content);
  });

  it("does not leak the home directory in error messages", async () => {
    await savePerformanceState(emptyPerformanceState(), dir);
    await writeFile(join(dir, PERFORMANCE_FILENAME), "{");
    const error = await loadPerformanceState(dir).catch((caught: unknown) => caught);
    expect((error as Error).message).not.toContain(root);
  });

  it("refuses to save an invalid state", async () => {
    const state = { ...emptyPerformanceState(), rules: [{ sport_name: "", discipline: "hyrox" }] };
    await expect(
      savePerformanceState(state as ReturnType<typeof emptyPerformanceState>, dir)
    ).rejects.toMatchObject({ code: "invalid_schema" });
  });

  it("serialises concurrent updates without losing writes", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        updatePerformanceState((state) => {
          state.rules.push({ sport_name: `sport-${index}`, discipline: "other" });
          return { state, result: index };
        }, dir)
      )
    );
    expect((await loadPerformanceState(dir)).rules).toHaveLength(20);
  });

  it("returns the mutator result and does not write when the mutator throws", async () => {
    expect(await updatePerformanceState((state) => ({ state, result: "ok" }), dir)).toBe("ok");
    await expect(
      updatePerformanceState(() => {
        throw new Error("boom");
      }, dir)
    ).rejects.toThrow("boom");
    expect(await loadPerformanceState(dir)).toEqual(emptyPerformanceState());
  });
});

describe("audit log", () => {
  const entry = {
    actor: "mcp_tool" as const,
    action: "annotate_workout" as const,
    workout_id: "w1",
    before: null,
    after: { action: "exclude" },
    reason: "bad_hr",
  };

  it("appends entries with ids and timestamps, 0600 permissions, newest first on read", async () => {
    const first = await appendAuditEntry(entry, dir, new Date("2026-10-17T10:00:00Z"));
    const second = await appendAuditEntry(
      { ...entry, workout_id: "w2" },
      dir,
      new Date("2026-10-17T11:00:00Z")
    );
    expect(first.id).not.toBe(second.id);
    expect(await mode(join(dir, AUDIT_FILENAME))).toBe(0o600);
    const log = await readAuditLog(dir);
    expect(log.entries.map((item) => item.workout_id)).toEqual(["w2", "w1"]);
    expect(log).toMatchObject({ invalid_lines: 0, truncated: false });
  });

  it("is append-only: earlier bytes are never rewritten", async () => {
    await appendAuditEntry(entry, dir);
    const before = await readFile(join(dir, AUDIT_FILENAME), "utf-8");
    await appendAuditEntry({ ...entry, workout_id: "w2" }, dir);
    const after = await readFile(join(dir, AUDIT_FILENAME), "utf-8");
    expect(after.startsWith(before)).toBe(true);
  });

  it("skips and counts invalid lines, and honours the limit", async () => {
    await appendAuditEntry(entry, dir);
    await writeFile(join(dir, AUDIT_FILENAME), "garbage\n{}\n", { flag: "a" });
    await appendAuditEntry({ ...entry, workout_id: "w2" }, dir);
    await appendAuditEntry({ ...entry, workout_id: "w3" }, dir);
    const log = await readAuditLog(dir, { limit: 2 });
    expect(log.invalid_lines).toBe(2);
    expect(log.entries.map((item) => item.workout_id)).toEqual(["w3", "w2"]);
    expect(log.truncated).toBe(true);
  });

  it("returns an empty log when the file is missing", async () => {
    expect(await readAuditLog(dir)).toEqual({ entries: [], invalid_lines: 0, truncated: false });
  });
});
