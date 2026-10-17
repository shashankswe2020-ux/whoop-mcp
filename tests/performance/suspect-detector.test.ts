import { describe, it, expect } from "vitest";
import {
  buildCaveats,
  detectSuspects,
  MIN_PERCENT_RECORDED,
} from "../../src/performance/suspect-detector.js";
import { groupSessions } from "../../src/performance/session-grouping.js";
import { redditHyroxDay, workout } from "../helpers/performance-fixtures.js";

const START = "2026-10-10T01:00:00Z";

function rulesFor(records: ReturnType<typeof workout>[]): string[] {
  return detectSuspects(records, groupSessions(records)).map(
    (flag) => `${flag.rule}:${flag.workout_id}`
  );
}

describe("detectSuspects", () => {
  it("flags the Reddit report's caveats: indoor distances and the mislabelled Run 4", () => {
    const day = redditHyroxDay();
    const flags = rulesFor(day);
    expect(flags).toEqual(
      expect.arrayContaining([
        "indoor_distance:ski-1",
        "indoor_distance:run-6",
        "implausible_pace:run-6",
        "short_segment_mislabel:run-4",
      ])
    );
    expect(flags.filter((flag) => flag.startsWith("short_segment_mislabel"))).toEqual([
      "short_segment_mislabel:run-4",
    ]);
    expect(flags.some((flag) => flag.endsWith(":lift-1"))).toBe(false);
  });

  it.each([
    [MIN_PERCENT_RECORDED, false],
    [MIN_PERCENT_RECORDED - 0.1, true],
  ])("low_coverage at percent_recorded=%s → %s", (percentRecorded, flagged) => {
    const record = workout({
      id: "w",
      sport: "running",
      start: START,
      durationSeconds: 1800,
      percentRecorded,
    });
    expect(rulesFor([record]).includes("low_coverage:w")).toBe(flagged);
  });

  it.each([
    ["running", 1800, 12_000, false], // 150 s/km exactly
    ["running", 1800, 12_010, true], // just under 150 s/km
    ["swimming", 550, 1000, false], // 55 s/100 m exactly
    ["swimming", 549, 1000, true],
    ["cycling", 3600, 60_000, false], // 60 km/h exactly
    ["cycling", 3600, 60_010, true],
  ])("implausible_pace for %s %ss over %sm → %s", (sport, seconds, distance, flagged) => {
    const record = workout({ id: "w", sport, start: START, durationSeconds: seconds, distance });
    expect(rulesFor([record]).includes("implausible_pace:w")).toBe(flagged);
  });

  it("ignores pace for sports without a pace model and for missing distance", () => {
    const yoga = workout({
      id: "y",
      sport: "yoga",
      start: START,
      durationSeconds: 60,
      distance: 50_000,
    });
    const run = workout({
      id: "r",
      sport: "running",
      start: START,
      durationSeconds: 60,
      distance: null,
    });
    expect(rulesFor([yoga])).not.toContain("implausible_pace:y");
    expect(rulesFor([run])).not.toContain("implausible_pace:r");
  });

  it.each([
    [50, 220, false],
    [49, 160, true],
    [140, 221, true],
  ])("hr_out_of_range avg=%s max=%s → %s", (avgHr, maxHr, flagged) => {
    const record = workout({
      id: "w",
      sport: "running",
      start: START,
      durationSeconds: 1800,
      avgHr,
      maxHr,
    });
    expect(rulesFor([record]).includes("hr_out_of_range:w")).toBe(flagged);
  });

  it("flags unscored workouts", () => {
    const record = workout({
      id: "w",
      sport: "running",
      start: START,
      durationSeconds: 600,
      scoreState: "UNSCORABLE",
    });
    expect(rulesFor([record])).toEqual(["unscored:w"]);
  });

  it("flags workouts overlapping by more than half of the shorter one", () => {
    const first = workout({ id: "a", sport: "running", start: START, durationSeconds: 1000 });
    const half = workout({
      id: "b",
      sport: "cycling",
      start: new Date(Date.parse(START) + 500_000).toISOString(),
      durationSeconds: 1000,
    });
    const more = workout({
      id: "c",
      sport: "cycling",
      start: new Date(Date.parse(START) + 499_000).toISOString(),
      durationSeconds: 1000,
    });
    expect(rulesFor([first, half]).some((flag) => flag.startsWith("overlap"))).toBe(false);
    const flags = detectSuspects([first, more], groupSessions([first, more]));
    expect(flags).toContainEqual(
      expect.objectContaining({ rule: "overlap", workout_id: "c", related_workout_id: "a" })
    );
  });

  it("never mutates its input", () => {
    const day = redditHyroxDay();
    const snapshot = JSON.stringify(day);
    detectSuspects(day, groupSessions(day));
    expect(JSON.stringify(day)).toBe(snapshot);
  });
});

describe("buildCaveats", () => {
  it("groups flags into caveats naming their records and appends requested method notes", () => {
    const day = redditHyroxDay();
    const caveats = buildCaveats(detectSuspects(day, groupSessions(day)), [
      "strain_not_additive",
      "estimated_max_hr",
      "hyrox_stations_invisible",
      "no_hr_curve",
    ]);
    const ids = caveats.map((caveat) => caveat.id);
    expect(ids).toEqual([
      "indoor_distance",
      "implausible_pace",
      "short_segment_mislabel",
      "strain_not_additive",
      "estimated_max_hr",
      "hyrox_stations_invisible",
      "no_hr_curve",
    ]);
    expect(caveats[0]).toMatchObject({ workout_ids: ["ski-1", "run-6"] });
    expect(caveats.find((caveat) => caveat.id === "no_hr_curve")!.workout_ids).toEqual([]);
    for (const caveat of caveats) expect(caveat.text.length).toBeGreaterThan(20);
  });

  it("returns no record caveats when nothing is suspicious", () => {
    expect(buildCaveats([], [])).toEqual([]);
  });
});
