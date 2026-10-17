import { describe, it, expect } from "vitest";
import {
  computeReadiness,
  MIN_DISCIPLINE_SHARE,
  SLEEP_DEBT_AMBER_HOURS,
  SLEEP_DEBT_RED_HOURS,
  TAPER_WINDOW_DAYS,
  TSB_FATIGUED,
  TSB_FRESH,
  type ReadinessInput,
} from "../../src/performance/readiness.js";
import {
  computeTrainingLoad,
  type TrainingLoadResult,
} from "../../src/performance/training-load.js";
import { DISCLAIMER, RECOVERY_ZONES } from "../../src/tools/analytics-utils.js";
import { dailyWorkouts } from "../helpers/performance-fixtures.js";

const TODAY = "2026-10-30";

function load(overrides: Partial<TrainingLoadResult> = {}): TrainingLoadResult {
  const base = computeTrainingLoad(
    [
      ...dailyWorkouts(TODAY, 42, "running", [0, 0, 0, 0, 0, 10], "r"),
      ...dailyWorkouts(TODAY, 42, "functional fitness", [0, 0, 0, 0, 0, 10], "h"),
    ],
    {
      endDay: TODAY,
      disciplineOf: (workout) => (workout.sport_name === "running" ? "run" : "hyrox"),
    }
  );
  return { ...base, ...overrides };
}

function input(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    sport: "hyrox",
    today: TODAY,
    recovery: { score: 80, baseline_mean: 60, date: TODAY },
    load: load({ current: { ctl: 50, atl: 40, tsb: 10 } }),
    sleep_debt_hours: 0,
    ...overrides,
  };
}

function band(result: ReturnType<typeof computeReadiness>, id: string): string | undefined {
  return result.components.find((component) => component.id === id)?.band;
}

describe("RECOVERY_ZONES", () => {
  it("matches WHOOP's red/yellow/green cut-offs", () => {
    expect(RECOVERY_ZONES).toEqual({ red_below: 34, green_above: 66 });
  });
});

describe("computeReadiness", () => {
  it("returns ready with five evidenced components and the disclaimer", () => {
    const result = computeReadiness(input());
    expect(result.band).toBe("ready");
    expect(result.components.map((component) => component.id)).toEqual([
      "recovery",
      "form",
      "specificity",
      "sleep",
      "taper",
    ]);
    for (const component of result.components) {
      expect(component.metric).toMatchObject({ method_version: "1.0.0" });
      expect(component.metric.method).toBeTruthy();
      expect(component.rationale).toBeTruthy();
    }
    expect(result.disclaimer).toBe(DISCLAIMER);
    expect(result.band_rule).toMatch(/red/);
    expect(band(result, "taper")).toBe("not_applicable");
  });

  it.each([
    [33, "red"],
    [34, "amber"],
    [66, "amber"],
    [67, "green"],
    [null, "unknown"],
  ])("recovery %s → %s", (score, expected) => {
    const result = computeReadiness(input({ recovery: { score, baseline_mean: 60, date: TODAY } }));
    expect(band(result, "recovery")).toBe(expected);
  });

  it.each([
    [TSB_FRESH, "green"],
    [TSB_FRESH - 0.01, "amber"],
    [TSB_FATIGUED, "amber"],
    [TSB_FATIGUED - 0.01, "red"],
  ])("form tsb %s → %s", (tsb, expected) => {
    const result = computeReadiness(
      input({ load: load({ current: { ctl: 50, atl: 50 - tsb, tsb } }) })
    );
    expect(band(result, "form")).toBe(expected);
  });

  it("marks form unknown when the load history is insufficient", () => {
    const result = computeReadiness(
      input({ load: load({ status: "insufficient_data", current: null }) })
    );
    expect(band(result, "form")).toBe("unknown");
  });

  it.each([
    [1.99, "green"],
    [SLEEP_DEBT_AMBER_HOURS, "amber"],
    [SLEEP_DEBT_RED_HOURS, "amber"],
    [SLEEP_DEBT_RED_HOURS + 0.01, "red"],
    [null, "unknown"],
  ])("sleep debt %s h → %s", (hours, expected) => {
    expect(band(computeReadiness(input({ sleep_debt_hours: hours })), "sleep")).toBe(expected);
  });

  describe("specificity", () => {
    const shares = (run: number, hyrox: number, other: number): TrainingLoadResult =>
      load({ load_28d: { total: run + hyrox + other, run, hyrox, other } });

    it(`treats a share of exactly ${MIN_DISCIPLINE_SHARE} as sufficient`, () => {
      expect(band(computeReadiness(input({ load: shares(15, 15, 70) })), "specificity")).toBe(
        "green"
      );
    });

    it("is amber with one discipline below the minimum and red with two", () => {
      expect(band(computeReadiness(input({ load: shares(14, 30, 56) })), "specificity")).toBe(
        "amber"
      );
      expect(band(computeReadiness(input({ load: shares(14, 14, 72) })), "specificity")).toBe(
        "red"
      );
    });

    it("does not count unconfirmed HYROX candidates", () => {
      const result = computeReadiness(
        input({ load: load({ load_28d: { total: 100, run: 50, hyrox_candidate: 50 } }) })
      );
      expect(band(result, "specificity")).toBe("amber");
    });

    it("checks swim, bike and run for triathlon", () => {
      const tri = load({ load_28d: { total: 100, swim: 10, bike: 45, run: 45 } });
      expect(band(computeReadiness(input({ sport: "triathlon", load: tri })), "specificity")).toBe(
        "amber"
      );
      const balanced = load({ load_28d: { total: 90, swim: 30, bike: 30, run: 30 } });
      expect(
        band(computeReadiness(input({ sport: "triathlon", load: balanced })), "specificity")
      ).toBe("green");
    });

    it("is unknown with no load in the last 28 days", () => {
      expect(
        band(computeReadiness(input({ load: load({ load_28d: { total: 0 } }) })), "specificity")
      ).toBe("unknown");
    });
  });

  describe("taper", () => {
    const raceIn = (days: number): string =>
      new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

    it(`applies only within ${TAPER_WINDOW_DAYS} days of the race`, () => {
      expect(
        band(computeReadiness(input({ race_date: raceIn(TAPER_WINDOW_DAYS + 1) })), "taper")
      ).toBe("not_applicable");
      expect(band(computeReadiness(input({ race_date: raceIn(-1) })), "taper")).toBe(
        "not_applicable"
      );
      const result = computeReadiness(input({ race_date: raceIn(TAPER_WINDOW_DAYS) }));
      expect(result.days_to_race).toBe(TAPER_WINDOW_DAYS);
      expect(band(result, "taper")).not.toBe("not_applicable");
    });

    it("is green when fatigue is falling and amber when it is not", () => {
      const series = (atlNow: number, atlWeekAgo: number): TrainingLoadResult["series"] =>
        Array.from({ length: 8 }, (_, index) => ({
          date: `2026-10-${23 + index}`,
          load: 0,
          ctl: 50,
          atl: index === 0 ? atlWeekAgo : index === 7 ? atlNow : 45,
          tsb: 0,
        }));
      expect(
        band(
          computeReadiness(input({ race_date: raceIn(5), load: load({ series: series(30, 40) }) })),
          "taper"
        )
      ).toBe("green");
      expect(
        band(
          computeReadiness(input({ race_date: raceIn(5), load: load({ series: series(40, 40) }) })),
          "taper"
        )
      ).toBe("amber");
    });

    it("is unknown when fewer than 8 days of series exist", () => {
      expect(
        band(computeReadiness(input({ race_date: raceIn(5), load: load({ series: [] }) })), "taper")
      ).toBe("unknown");
    });
  });

  describe("band rule", () => {
    it("any red → not_ready, even with unknowns", () => {
      const result = computeReadiness(
        input({
          recovery: { score: 10, baseline_mean: 60, date: TODAY },
          sleep_debt_hours: null,
          load: load({ status: "insufficient_data", current: null }),
        })
      );
      expect(result.band).toBe("not_ready");
    });

    it("two unknowns → insufficient_data", () => {
      expect(
        computeReadiness(
          input({
            recovery: { score: null, baseline_mean: null, date: null },
            sleep_debt_hours: null,
          })
        ).band
      ).toBe("insufficient_data");
    });

    it("two ambers → caution; one amber → ready", () => {
      expect(computeReadiness(input({ sleep_debt_hours: 3 })).band).toBe("ready");
      expect(
        computeReadiness(
          input({ sleep_debt_hours: 3, recovery: { score: 50, baseline_mean: 60, date: TODAY } })
        ).band
      ).toBe("caution");
    });
  });
});
