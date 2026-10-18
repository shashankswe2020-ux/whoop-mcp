import { describe, expect, it } from "vitest";
import { createDashboardApi } from "../../src/dashboard/api.js";
import {
  dailyWorkouts,
  night,
  performanceClient,
  workout,
} from "../helpers/performance-fixtures.js";
import { WhoopNetworkError } from "../../src/api/client.js";
import { getDashboardTraining } from "../../src/dashboard/data.js";
import { emptyPerformanceState } from "../../src/performance/schemas.js";

const now = new Date("2026-10-20T12:00:00Z");

describe("chart-first dashboard data", () => {
  it("returns a gap-preserving history with scored sleep stages and no stale substitution", async () => {
    const scored = night({ day: "2026-10-18", recovery: 0 });
    const pending = night({ day: "2026-10-20", recovery: 70 });
    const api = createDashboardApi({
      client: performanceClient({
        sleep: [scored.sleep, { ...pending.sleep, score_state: "PENDING_SCORE", score: null }],
        recovery: [scored.recovery, pending.recovery],
      }),
      now: () => now,
    });
    const result = await api("GET", "/api/history", new URLSearchParams(), undefined);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      days: expect.arrayContaining([
        expect.objectContaining({ date: "2026-10-18", recovery_score: 0, sleep_hours: 7.5 }),
        expect.objectContaining({ date: "2026-10-19", recovery_score: null, sleep_hours: null }),
        expect.objectContaining({ date: "2026-10-20", recovery_score: null, sleep_hours: null }),
      ]),
    });
    expect(JSON.stringify(result.body)).toContain("light_hours");
  });

  it("keeps empty training weeks and uses WHOOP zone minutes", async () => {
    const workouts = dailyWorkouts("2026-10-18", 1, "running", [0, 10, 20, 0, 0, 0]);
    const api = createDashboardApi({
      client: performanceClient({ workouts }),
      now: () => now,
    });
    const result = await api(
      "GET",
      "/api/training",
      new URLSearchParams({ start: "2026-10-01", end: "2026-10-20" }),
      undefined
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      weekly: [
        { week_start: "2026-09-28", zones: [0, 0, 0, 0, 0, 0] },
        { week_start: "2026-10-05", zones: [0, 0, 0, 0, 0, 0] },
        { week_start: "2026-10-12", zones: [0, 10, 20, 0, 0, 0] },
        { week_start: "2026-10-19", zones: [0, 0, 0, 0, 0, 0] },
      ],
      workouts: [expect.objectContaining({ trimp: 50, minutes: 30, discipline: "run" })],
    });
    const bad = await api(
      "GET",
      "/api/training",
      new URLSearchParams({ start: "not-a-date" }),
      undefined
    );
    expect(bad.status).toBe(400);
  });

  it("uses UTC instants for offset boundaries and omits local exclusions", async () => {
    const state = emptyPerformanceState();
    state.annotations.excluded = {
      action: "exclude",
      reason: "duplicate",
      updated_at: now.toISOString(),
    };
    const record = (id: string, start: string): ReturnType<typeof workout> =>
      workout({ id, sport: "running", start, durationSeconds: 1800 });
    const result = await getDashboardTraining(
      performanceClient({
        workouts: [
          record("sunday-utc", "2026-10-19T00:30:00+02:00"),
          record("outside", "2026-10-01T00:30:00+02:00"),
          record("excluded", "2026-10-18T12:00:00Z"),
        ],
      }),
      { start: "2026-10-01", end: "2026-10-20" },
      { now, loadState: async () => state }
    );
    expect(result.workouts.map((row) => row.id)).toEqual(["sunday-utc"]);
    expect(result.weekly.find((row) => row.week_start === "2026-10-12")?.zones).toEqual([
      0, 30, 0, 0, 0, 0,
    ]);
    expect(result.weekly.find((row) => row.week_start === "2026-10-19")?.zones).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
  });

  it("reports source failures rather than inventing zero activity", async () => {
    const api = createDashboardApi({
      client: performanceClient({ workouts: new WhoopNetworkError("offline") }),
      now: () => now,
    });
    expect((await api("GET", "/api/training", new URLSearchParams(), undefined)).status).toBe(502);
  });
});
