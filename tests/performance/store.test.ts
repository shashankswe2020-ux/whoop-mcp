import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitPerformanceChange,
  loadPerformanceState,
  LOCK_FILENAME,
  PERFORMANCE_FILENAME,
  PerformanceStoreError,
  savePerformanceState,
  updatePerformanceState,
} from "../../src/performance/store.js";
import {
  appendAuditEntry,
  AUDIT_FILENAME,
  MAX_AUDIT_LINE_BYTES,
  MAX_AUDIT_SCAN_BYTES,
  MAX_AUDIT_SCAN_LINES,
  readAuditLog,
} from "../../src/performance/audit-log.js";
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

describe("cross-process locking", () => {
  it("does not lose writes between independent module instances (separate processes)", async () => {
    vi.resetModules();
    const other = await import("../../src/performance/store.js");
    expect(other.updatePerformanceState).not.toBe(updatePerformanceState);
    const push = (update: typeof updatePerformanceState, name: string) => (): Promise<null> =>
      update((state) => {
        state.rules.push({ sport_name: name, discipline: "other" });
        return { state, result: null };
      }, dir);
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => [
        push(updatePerformanceState, `a-${index}`)(),
        push(other.updatePerformanceState, `b-${index}`)(),
      ]).flat()
    );
    expect((await loadPerformanceState(dir)).rules).toHaveLength(20);
    expect(await readdir(dir)).not.toContain(LOCK_FILENAME);
  });

  it("holds a lockfile during the update and removes it afterwards", async () => {
    let sawLock = false;
    await updatePerformanceState(async (state) => {
      sawLock = (await readdir(dir)).includes(LOCK_FILENAME);
      return { state, result: null };
    }, dir);
    expect(sawLock).toBe(true);
    expect(await readdir(dir)).not.toContain(LOCK_FILENAME);
  });

  it("reports busy without writing when another process holds a fresh lock", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, LOCK_FILENAME), "other");
    await expect(
      updatePerformanceState((state) => ({ state, result: null }), dir, { lockTimeoutMs: 50 })
    ).rejects.toMatchObject({ code: "busy" });
    expect(await readdir(dir)).not.toContain(PERFORMANCE_FILENAME);
    expect(await readFile(join(dir, LOCK_FILENAME), "utf-8")).toBe("other");
  });

  it("breaks a stale lock left by a crashed process", async () => {
    await mkdir(dir, { recursive: true });
    const lock = join(dir, LOCK_FILENAME);
    await writeFile(lock, "crashed");
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    expect(
      await updatePerformanceState((state) => ({ state, result: "ok" }), dir, {
        lockTimeoutMs: 50,
      })
    ).toBe("ok");
    expect(await readdir(dir)).not.toContain(LOCK_FILENAME);
  });
});

describe("commitPerformanceChange", () => {
  type State = ReturnType<typeof emptyPerformanceState>;
  const addRule = (state: State): { state: State; result: string } => {
    state.rules.push({ sport_name: "new", discipline: "hyrox" });
    return { state, result: "mutated" };
  };

  it("returns the commit result after saving", async () => {
    const committed = await commitPerformanceChange(
      addRule,
      async (result) => `${result}+audited`,
      dir
    );
    expect(committed).toBe("mutated+audited");
    expect((await loadPerformanceState(dir)).rules).toHaveLength(1);
  });

  it("restores the previous bytes when the commit step fails", async () => {
    const original = emptyPerformanceState();
    original.rules.push({ sport_name: "old", discipline: "other" });
    await savePerformanceState(original, dir);
    const before = await readFile(join(dir, PERFORMANCE_FILENAME), "utf-8");
    const failure = new PerformanceStoreError("io", "audit failed");
    await expect(commitPerformanceChange(addRule, () => Promise.reject(failure), dir)).rejects.toBe(
      failure
    );
    expect(await readFile(join(dir, PERFORMANCE_FILENAME), "utf-8")).toBe(before);
    expect(await readdir(dir)).toEqual([PERFORMANCE_FILENAME]);
  });

  it("removes a newly created state file when the first commit fails", async () => {
    await expect(
      commitPerformanceChange(addRule, () => Promise.reject(new Error("audit failed")), dir)
    ).rejects.toThrow("audit failed");
    expect(await readdir(dir)).toEqual([]);
  });

  it("reports a partial write truthfully when the rollback also fails", async () => {
    await savePerformanceState(emptyPerformanceState(), dir);
    const error = await commitPerformanceChange(
      addRule,
      async () => {
        await chmod(dir, 0o500);
        throw new Error("audit failed");
      },
      dir
    )
      .catch((caught: unknown) => caught)
      .finally(() => chmod(dir, 0o700));
    expect(error).toMatchObject({ name: "PerformanceStoreError", code: "partial_write" });
    expect((error as Error).message).toMatch(/saved.*audit/i);
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

  it("reads only the newest lines needed for the limit", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, AUDIT_FILENAME), "bad\n".repeat(500_000));
    for (const id of ["w1", "w2", "w3"]) await appendAuditEntry({ ...entry, workout_id: id }, dir);
    const log = await readAuditLog(dir, { limit: 2 });
    expect(log.entries.map((item) => item.workout_id)).toEqual(["w3", "w2"]);
    expect(log).toMatchObject({ invalid_lines: 0, truncated: true });
  });

  it.each([
    ["byte", `${"x".repeat(1023)}\n`, Math.ceil(MAX_AUDIT_SCAN_BYTES / 1024) + 10],
    ["line", "{}\n", MAX_AUDIT_SCAN_LINES + 10],
  ])("stops after the %s budget and reports truncation", async (_budget, junk, count) => {
    await appendAuditEntry(entry, dir);
    await writeFile(join(dir, AUDIT_FILENAME), junk.repeat(count), { flag: "a" });
    const log = await readAuditLog(dir, { limit: 5 });
    expect(log.entries).toEqual([]);
    expect(log.truncated).toBe(true);
    expect(log.invalid_lines).toBeGreaterThan(0);
    expect(log.invalid_lines).toBeLessThanOrEqual(MAX_AUDIT_SCAN_LINES);
  });

  it("counts an oversized line as one invalid line and keeps reading", async () => {
    await appendAuditEntry(entry, dir);
    await writeFile(join(dir, AUDIT_FILENAME), `${"x".repeat(MAX_AUDIT_LINE_BYTES * 3)}\n`, {
      flag: "a",
    });
    await appendAuditEntry({ ...entry, workout_id: "w2" }, dir);
    const log = await readAuditLog(dir);
    expect(log.entries.map((item) => item.workout_id)).toEqual(["w2", "w1"]);
    expect(log).toMatchObject({ invalid_lines: 1, truncated: false });
  });

  it("decodes multi-byte characters split across read chunks", async () => {
    const note = "🏃é".repeat(20_000);
    await appendAuditEntry({ ...entry, after: { note } }, dir);
    await appendAuditEntry({ ...entry, workout_id: "w2", after: { note } }, dir);
    const log = await readAuditLog(dir);
    expect(log.entries.map((item) => (item.after as { note: string }).note)).toEqual([note, note]);
    expect(log.invalid_lines).toBe(0);
  });

  it("returns an empty log when the file is missing", async () => {
    expect(await readAuditLog(dir)).toEqual({ entries: [], invalid_lines: 0, truncated: false });
  });
});
