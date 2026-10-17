import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logRaceResult, logRaceResultOutputSchema } from "../../src/tools/log-race-result.js";
import { PerformanceInputError } from "../../src/performance/context.js";
import { HYROX_STATIONS } from "../../src/performance/schemas.js";
import { loadPerformanceState, PerformanceStoreError } from "../../src/performance/store.js";
import { readAuditLog } from "../../src/performance/audit-log.js";

const NOW = new Date("2026-10-20T12:00:00Z");
let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "whoop-race-"));
  dir = join(root, "state");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const STATION_SECONDS = [240, 180, 260, 300, 270, 120, 330, 420];
function hyrox(overrides: Record<string, unknown> = {}): Parameters<typeof logRaceResult>[0] {
  return {
    sport: "hyrox",
    date: "2026-10-04",
    name: "HYROX Mumbai",
    category: "open_men",
    total_seconds: 8 * 300 + 2120 + 400,
    splits: {
      runs: Array.from({ length: 8 }, () => 300),
      stations: HYROX_STATIONS.map((station, i) => ({ station, seconds: STATION_SECONDS[i]! })),
    },
    ...overrides,
  } as Parameters<typeof logRaceResult>[0];
}

describe("log_race_result", () => {
  it("leaves the store unchanged when the audit entry cannot be written", async () => {
    await mkdir(join(dir, "performance-audit.jsonl"), { recursive: true });
    await expect(logRaceResult(hyrox(), { directory: dir, now: NOW })).rejects.toMatchObject({
      name: "PerformanceStoreError",
      code: "io",
    });
    expect((await loadPerformanceState(dir)).race_results).toEqual([]);
  });

  it("stores the result, reports implied roxzone and writes one audit entry", async () => {
    const output = await logRaceResult(hyrox(), { directory: dir, now: NOW });

    expect(logRaceResultOutputSchema.parse(output)).toEqual(output);
    expect(output.implied_roxzone_seconds).toBe(400);
    expect(output.warnings).toEqual([]);
    const state = await loadPerformanceState(dir);
    expect(state.race_results).toHaveLength(1);
    expect(state.race_results[0]).toMatchObject({
      name: "HYROX Mumbai",
      created_at: NOW.toISOString(),
    });

    const log = await readAuditLog(dir);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({
      id: output.audit_entry_id,
      actor: "mcp_tool",
      action: "log_race_result",
      race_id: state.race_results[0]!.id,
      before: null,
    });
  });

  it("rejects out-of-order HYROX stations with a clear message", async () => {
    const splits = hyrox().splits as { runs: number[]; stations: Array<{ station: string }> };
    const swapped = [...splits.stations];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    const error = await logRaceResult(hyrox({ splits: { ...splits, stations: swapped } }), {
      directory: dir,
      now: NOW,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PerformanceInputError);
    expect((error as Error).message).toContain(
      "splits.stations: Stations must be in official order"
    );
    expect((await readAuditLog(dir)).entries).toEqual([]);
  });

  it("rejects a split sum outside ±5 s of the total", async () => {
    const splits = { ...(hyrox().splits as object), roxzone_seconds: 400 };
    await expect(
      logRaceResult(hyrox({ splits, total_seconds: 8 * 300 + 2120 + 406 }), {
        directory: dir,
        now: NOW,
      })
    ).rejects.toThrow(/tolerance ±5s/);
    await expect(
      logRaceResult(hyrox({ splits, total_seconds: 8 * 300 + 2120 + 405 }), {
        directory: dir,
        now: NOW,
      })
    ).resolves.toMatchObject({ implied_roxzone_seconds: null });
  });

  it("rejects future dates and unknown categories", async () => {
    await expect(
      logRaceResult(hyrox({ date: "2026-10-21" }), { directory: dir, now: NOW })
    ).rejects.toThrow(/future/);
    await expect(
      logRaceResult(hyrox({ category: "olympic" }), { directory: dir, now: NOW })
    ).rejects.toBeInstanceOf(PerformanceInputError);
  });

  it("stores triathlon results and warns about duplicates and missing splits", async () => {
    const tri = {
      sport: "triathlon" as const,
      date: "2026-09-01",
      name: "City Olympic",
      category: "olympic",
      total_seconds: 9000,
      workout_id: "w-123",
    };
    await logRaceResult(tri, { directory: dir, now: NOW });
    const second = await logRaceResult(
      { ...tri, name: "city olympic" },
      { directory: dir, now: NOW, actor: "dashboard" }
    );
    expect(second.warnings).toEqual([
      expect.stringContaining("already exists"),
      "No splits logged: legs and transitions will be blank.",
      "workout_id is stored as given; it is not checked against WHOOP.",
    ]);
    const log = await readAuditLog(dir);
    expect(log.entries[0]).toMatchObject({ actor: "dashboard", workout_id: "w-123" });
  });

  it("refuses to write over a corrupt store and writes no audit entry", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "performance.json"), "{not json");
    await expect(logRaceResult(hyrox(), { directory: dir, now: NOW })).rejects.toBeInstanceOf(
      PerformanceStoreError
    );
    expect((await readAuditLog(dir)).entries).toEqual([]);
  });
});
