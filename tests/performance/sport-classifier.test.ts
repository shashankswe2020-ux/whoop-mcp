import { describe, it, expect } from "vitest";
import {
  BRICK_GAP_MINUTES,
  classifyWorkout,
  findBricks,
  resolveDiscipline,
} from "../../src/performance/sport-classifier.js";
import { workout } from "../helpers/performance-fixtures.js";

describe("classifyWorkout", () => {
  it.each([
    ["running", "run"],
    ["Track & Field", "run"],
    ["cycling", "bike"],
    ["Spin", "bike"],
    ["mountain biking", "bike"],
    ["swimming", "swim"],
    ["Triathlon", "multisport"],
    ["duathlon", "multisport"],
    ["functional fitness", "hyrox_candidate"],
    ["HIIT", "hyrox_candidate"],
    ["obstacle course racing", "hyrox_candidate"],
    ["rowing", "other"],
    ["skiing", "other"],
    ["assault bike", "other"],
    ["weightlifting", "other"],
    ["something new", "other"],
  ])("maps %s → %s", (sport, expected) => {
    expect(classifyWorkout(sport)).toBe(expected);
  });

  it("is insensitive to case and surrounding whitespace", () => {
    expect(classifyWorkout("  RUNNING ")).toBe("run");
  });
});

describe("resolveDiscipline", () => {
  const ff = workout({
    id: "ff",
    sport: "functional fitness",
    start: "2026-10-17T03:00:00Z", // Saturday
    durationSeconds: 75 * 60,
  });
  const rule = {
    sport_name: "functional fitness",
    discipline: "hyrox" as const,
    min_duration_minutes: 60,
    weekdays: [6],
  };

  it("falls back to the sport table without overrides", () => {
    expect(resolveDiscipline(ff, {})).toEqual({ discipline: "hyrox_candidate", source: "table" });
  });

  it("applies a matching user rule", () => {
    expect(resolveDiscipline(ff, { rules: [rule] })).toEqual({
      discipline: "hyrox",
      source: "rule",
    });
  });

  it("ignores rules whose duration or weekday conditions do not match", () => {
    expect(resolveDiscipline(ff, { rules: [{ ...rule, min_duration_minutes: 90 }] }).source).toBe(
      "table"
    );
    expect(resolveDiscipline(ff, { rules: [{ ...rule, weekdays: [0] }] }).source).toBe("table");
  });

  it("evaluates weekday rules in the workout's local day", () => {
    const lateFriday = workout({
      id: "late",
      sport: "functional fitness",
      start: "2026-10-16T20:00:00Z", // Friday UTC, Saturday 01:30 at +05:30
      durationSeconds: 75 * 60,
    });
    expect(resolveDiscipline(lateFriday, { rules: [rule] }).discipline).toBe("hyrox");
  });

  it("gives a user annotation precedence over rules", () => {
    expect(
      resolveDiscipline(ff, {
        rules: [rule],
        annotation: { action: "relabel", discipline: "run" },
      })
    ).toEqual({ discipline: "run", source: "annotation" });
  });

  it("reports excluded workouts", () => {
    expect(resolveDiscipline(ff, { annotation: { action: "exclude" } })).toEqual({
      discipline: "excluded",
      source: "annotation",
    });
  });

  it("treats a restore annotation as no override", () => {
    expect(resolveDiscipline(ff, { annotation: { action: "restore" } })).toEqual({
      discipline: "hyrox_candidate",
      source: "table",
    });
  });
});

describe("findBricks", () => {
  const bike = workout({
    id: "bike",
    sport: "cycling",
    start: "2026-10-10T01:00:00Z",
    durationSeconds: 3600,
  });
  const runAt = (minutesAfterBike: number): ReturnType<typeof workout> =>
    workout({
      id: `run-${minutesAfterBike}`,
      sport: "running",
      start: new Date(Date.parse(bike.end) + minutesAfterBike * 60_000).toISOString(),
      durationSeconds: 1800,
    });

  it(`pairs a run starting within ${BRICK_GAP_MINUTES} min of a bike`, () => {
    expect(findBricks([runAt(BRICK_GAP_MINUTES), bike])).toEqual([
      { bike_id: "bike", run_id: `run-${BRICK_GAP_MINUTES}`, gap_seconds: 900 },
    ]);
  });

  it("does not pair runs starting after the gap or before the bike ends", () => {
    expect(findBricks([bike, runAt(BRICK_GAP_MINUTES + 1)])).toEqual([]);
    expect(findBricks([bike, runAt(-5)])).toEqual([]);
  });
});
