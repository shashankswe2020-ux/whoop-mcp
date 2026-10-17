import { describe, it, expect } from "vitest";
import {
  ATL_DAYS,
  CTL_DAYS,
  computeTrainingLoad,
  edwardsTrimp,
  MIN_HISTORY_DAYS,
} from "../../src/performance/training-load.js";
import { dailyWorkouts, workout, zones } from "../helpers/performance-fixtures.js";

// [zone0, z1, z2, z3, z4, z5] minutes. 20 min in zone 5 → TRIMP 100.
const Z5_100: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 20];

describe("edwardsTrimp", () => {
  it("weights minutes in zones 1-5 by 1-5 and ignores zone 0", () => {
    expect(edwardsTrimp(zones([30, 10, 10, 10, 10, 10]))).toBe(150);
  });
});

describe("computeTrainingLoad", () => {
  it("matches the closed-form EWMA for a constant daily load", () => {
    const result = computeTrainingLoad(dailyWorkouts("2026-10-30", 30, "running", Z5_100), {
      endDay: "2026-10-30",
    });
    const ctl = 100 * (1 - ((CTL_DAYS - 1) / CTL_DAYS) ** 30);
    const atl = 100 * (1 - ((ATL_DAYS - 1) / ATL_DAYS) ** 30);
    expect(result.status).toBe("available");
    expect(result.current!.ctl).toBeCloseTo(ctl, 2);
    expect(result.current!.atl).toBeCloseTo(atl, 2);
    expect(result.current!.tsb).toBeCloseTo(ctl - atl, 2);
    expect(result.history_days).toBe(30);
    expect(result.series).toHaveLength(30);
    expect(result.method).toBe("edwards_trimp_ewma");
    expect(result.method_version).toBe("1.0.0");
    expect(result.limitations.length).toBeGreaterThan(0);
  });

  it(`returns insufficient_data with fewer than ${MIN_HISTORY_DAYS} days of history`, () => {
    const result = computeTrainingLoad(
      dailyWorkouts("2026-10-30", MIN_HISTORY_DAYS - 1, "running", Z5_100),
      { endDay: "2026-10-30" }
    );
    expect(result.status).toBe("insufficient_data");
    expect(result.current).toBeNull();
    expect(result.by_discipline).toEqual({});
    expect(result.load_spike.ratio).toBeNull();
  });

  it("returns insufficient_data without NaN when there are no workouts", () => {
    const result = computeTrainingLoad([], { endDay: "2026-10-30" });
    expect(result).toMatchObject({ status: "insufficient_data", current: null, series: [] });
    expect(result.load_28d.total).toBe(0);
  });

  it("flags a load spike when the 7-day load exceeds 1.5× the 28-day weekly mean", () => {
    const base = dailyWorkouts("2026-10-23", 21, "running", [0, 0, 0, 0, 0, 10], "base");
    const spike = dailyWorkouts("2026-10-30", 7, "running", [0, 0, 0, 0, 0, 30], "spike");
    const result = computeTrainingLoad([...base, ...spike], { endDay: "2026-10-30" });
    expect(result.load_spike.ratio).toBeCloseTo(2, 5);
    expect(result.load_spike.flagged).toBe(true);
  });

  it("does not flag a steady load", () => {
    const result = computeTrainingLoad(dailyWorkouts("2026-10-30", 28, "running", Z5_100), {
      endDay: "2026-10-30",
    });
    expect(result.load_spike).toEqual({ ratio: 1, flagged: false, threshold: 1.5 });
  });

  it("splits load by discipline and reports 28-day totals", () => {
    const runs = dailyWorkouts("2026-10-30", 28, "running", Z5_100, "r");
    const bikes = dailyWorkouts("2026-10-30", 28, "cycling", [0, 0, 0, 0, 0, 10], "b");
    const result = computeTrainingLoad([...runs, ...bikes], { endDay: "2026-10-30" });
    expect(result.load_28d).toMatchObject({ total: 4200, run: 2800, bike: 1400 });
    expect(result.by_discipline.run!.ctl).toBeCloseTo(2 * result.by_discipline.bike!.ctl, 6);
    expect(result.current!.ctl).toBeCloseTo(
      result.by_discipline.run!.ctl + result.by_discipline.bike!.ctl,
      6
    );
  });

  it("counts unscored, excluded and future workouts as exclusions, not load", () => {
    const valid = dailyWorkouts("2026-10-30", 28, "running", Z5_100);
    const unscored = workout({
      id: "u",
      sport: "running",
      start: "2026-10-29T07:00:00Z",
      durationSeconds: 600,
      scoreState: "UNSCORABLE",
      offset: "+00:00",
    });
    const pending = { ...unscored, id: "p", score_state: "PENDING_SCORE" as const };
    const future = {
      ...valid[0]!,
      id: "f",
      start: "2026-11-02T07:00:00Z",
      end: "2026-11-02T08:00:00Z",
    };
    const result = computeTrainingLoad([...valid, unscored, pending, future], {
      endDay: "2026-10-30",
      disciplineOf: (record) => (record.id === "running-0" ? "excluded" : "run"),
    });
    expect(result.inputs).toEqual({
      records_used: 27,
      records_excluded: 4,
      excluded_reasons: { user_excluded: 1, unscored: 1, pending: 1, outside_window: 1 },
    });
    expect(result.load_28d.total).toBe(2700);
  });

  it("buckets workouts by the workout's local day", () => {
    const lateNight = workout({
      id: "late",
      sport: "running",
      start: "2026-10-29T20:00:00Z", // 2026-10-30 01:30 at +05:30
      durationSeconds: 1200,
      zonesMinutes: Z5_100,
    });
    const result = computeTrainingLoad([lateNight], { endDay: "2026-10-30" });
    expect(result.series).toEqual([expect.objectContaining({ date: "2026-10-30", load: 100 })]);
  });

  it("caps the returned series at 90 points while computing from full history", () => {
    const result = computeTrainingLoad(dailyWorkouts("2026-10-30", 120, "running", Z5_100), {
      endDay: "2026-10-30",
    });
    expect(result.series).toHaveLength(90);
    expect(result.series.at(-1)!.date).toBe("2026-10-30");
    expect(result.series_truncated).toBe(true);
    expect(result.current!.ctl).toBeCloseTo(100 * (1 - (41 / 42) ** 120), 2);
  });
});
