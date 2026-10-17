import { describe, expect, it } from "vitest";
import {
  getTriathlonPerformance,
  triathlonPerformanceOutputSchema,
} from "../../src/tools/get-triathlon-performance.js";
import { emptyPerformanceState, type PerformanceState } from "../../src/performance/schemas.js";
import { performanceClient, workout } from "../helpers/performance-fixtures.js";

const NOW = new Date("2026-10-20T12:00:00Z");

function week(): ReturnType<typeof workout>[] {
  return [
    workout({
      id: "swim-1",
      sport: "swimming",
      start: "2026-10-13T06:00:00Z",
      durationSeconds: 1800,
      distance: 1500,
      zonesMinutes: [0, 10, 20, 0, 0, 0],
      offset: "+00:00",
    }),
    workout({
      id: "bike-1",
      sport: "cycling",
      start: "2026-10-14T06:00:00Z",
      durationSeconds: 3600,
      distance: 30_000,
      zonesMinutes: [0, 0, 40, 20, 0, 0],
      offset: "+00:00",
    }),
    workout({
      id: "run-brick",
      sport: "running",
      start: "2026-10-14T07:05:00Z",
      durationSeconds: 1200,
      distance: 4000,
      zonesMinutes: [0, 0, 0, 20, 0, 0],
      offset: "+00:00",
    }),
    workout({
      id: "run-gps",
      sport: "running",
      start: "2026-10-16T06:00:00Z",
      durationSeconds: 600,
      distance: 10_000,
      zonesMinutes: [0, 0, 10, 0, 0, 0],
      offset: "+00:00",
    }),
  ];
}

describe("get_triathlon_performance", () => {
  it("summarises per-discipline duration, distance, TRIMP and bricks", async () => {
    const result = await getTriathlonPerformance(
      performanceClient({ workouts: week() }),
      {},
      { now: NOW }
    );
    expect(triathlonPerformanceOutputSchema.parse(result)).toEqual(result);
    expect(result.weekly).toHaveLength(1);
    expect(result.weekly[0]).toMatchObject({
      week_start: "2026-10-12",
      swim: { workouts: 1, minutes: 30, distance_km: 1.5, trimp: 50 },
      bike: { workouts: 1, minutes: 60, distance_km: 30, trimp: 140 },
      run: { workouts: 2, minutes: 30, distance_km: 4, trimp: 80 },
      bricks: 1,
    });
    expect(result.bricks).toEqual([
      { date: "2026-10-14", bike_id: "bike-1", run_id: "run-brick", gap_seconds: 300 },
    ]);
  });

  it("ignores implausible GPS distance and lists the workout", async () => {
    const result = await getTriathlonPerformance(
      performanceClient({ workouts: week() }),
      {},
      { now: NOW }
    );
    expect(result.distance_ignored_workout_ids).toEqual(["run-gps"]);
    expect(result.totals.run.distance_km).toBe(4);
  });

  it("computes discipline share and zone mix", async () => {
    const result = await getTriathlonPerformance(
      performanceClient({ workouts: week() }),
      {},
      { now: NOW }
    );
    // TRIMP: swim 50, bike 140, run 80 → 270
    expect(result.discipline_share).toMatchObject({
      status: "available",
      swim: 0.185,
      bike: 0.519,
      run: 0.296,
      below_min: [],
    });
    expect(result.zone_mix.bike).toEqual({
      zone_one: 0,
      zone_two: 0.667,
      zone_three: 0.333,
      zone_four: 0,
      zone_five: 0,
    });
  });

  it("flags a leg below the minimum share", async () => {
    const noSwim = week().filter((item) => item.id !== "swim-1");
    const result = await getTriathlonPerformance(
      performanceClient({ workouts: noSwim }),
      {},
      { now: NOW }
    );
    expect(result.discipline_share.below_min).toEqual(["swim"]);
  });

  it("includes logged races with leg splits and transitions", async () => {
    const state: PerformanceState = emptyPerformanceState();
    state.race_results.push({
      id: "00000000-0000-4000-8000-000000000001",
      created_at: "2026-09-01T12:00:00Z",
      sport: "triathlon",
      category: "olympic",
      date: "2026-09-01",
      name: "City Olympic",
      total_seconds: 9000,
      splits: {
        swim_seconds: 1800,
        t1_seconds: 120,
        bike_seconds: 4200,
        t2_seconds: 80,
        run_seconds: 2800,
      },
    });
    const result = await getTriathlonPerformance(
      performanceClient({}),
      {},
      { now: NOW, loadState: async () => state }
    );
    expect(result.races[0]).toMatchObject({
      name: "City Olympic",
      transitions_seconds: 200,
      bike_seconds: 4200,
    });
    expect(result.discipline_share.status).toBe("insufficient_data");
  });

  it("honours relabels and exclusions", async () => {
    const state = emptyPerformanceState();
    state.annotations["run-gps"] = {
      action: "exclude",
      reason: "bad_hr",
      updated_at: "2026-10-17T00:00:00Z",
    };
    state.annotations["swim-1"] = {
      action: "relabel",
      discipline: "other",
      reason: "misclassified",
      updated_at: "2026-10-17T00:00:00Z",
    };
    const result = await getTriathlonPerformance(
      performanceClient({ workouts: week() }),
      {},
      { now: NOW, loadState: async () => state }
    );
    expect(result.totals.run.workouts).toBe(1);
    expect(result.totals.swim.workouts).toBe(0);
    expect(result.data_quality.sources.workout!.exclusions.user_excluded).toBe(1);
  });

  it("returns empty but valid output without data or store", async () => {
    const result = await getTriathlonPerformance(performanceClient({}), {}, { now: NOW });
    expect(triathlonPerformanceOutputSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ weekly: [], bricks: [], races: [], truncated: false });
    expect(result.store.status).toBe("not_configured");
  });
});
