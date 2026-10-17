import { describe, it, expect } from "vitest";
import { groupSessions, SESSION_GAP_MINUTES } from "../../src/performance/session-grouping.js";
import { classifyWorkout } from "../../src/performance/sport-classifier.js";
import { redditHyroxDay, workout } from "../helpers/performance-fixtures.js";

describe("groupSessions", () => {
  it("groups the Reddit HYROX sim into one candidate session plus a separate lift", () => {
    const sessions = groupSessions(redditHyroxDay());
    expect(sessions).toHaveLength(2);
    const [hyrox, lift] = sessions;

    expect(hyrox!.kind).toBe("hyrox_candidate");
    expect(hyrox!.segments.map((segment) => segment.label)).toEqual([
      "Run 1",
      "Ski Erg 1",
      "Run 2",
      "Row",
      "Run 3",
      "Run 4",
      "Run 5",
      "Ski Erg 2",
      "Run 6",
    ]);
    expect(hyrox!.segments.map((segment) => segment.role)).toEqual([
      "run",
      "erg_station",
      "run",
      "erg_station",
      "run",
      "run",
      "run",
      "erg_station",
      "run",
    ]);
    expect(hyrox!.tracked_seconds).toBe(2424);
    expect(hyrox!.span_seconds).toBe(2786);
    expect(hyrox!.transition_seconds).toBe(362);
    expect(hyrox!.transition_share).toBeCloseTo(0.13, 2);

    expect(lift!.kind).toBe("other");
    expect(lift!.segments).toHaveLength(1);
    expect(lift!.segments[0]).toMatchObject({ label: "Weightlifting", role: "other" });
  });

  it("returns sessions in chronological order regardless of input order", () => {
    const sessions = groupSessions([...redditHyroxDay()].reverse());
    expect(sessions[0]!.segments[0]!.workout.id).toBe("run-1");
  });

  it(`splits sessions when the gap exceeds ${SESSION_GAP_MINUTES} minutes`, () => {
    const first = workout({
      id: "a",
      sport: "running",
      start: "2026-10-10T01:00:00Z",
      durationSeconds: 600,
    });
    const atGap = workout({
      id: "b",
      sport: "rowing",
      start: new Date(Date.parse(first.end) + SESSION_GAP_MINUTES * 60_000).toISOString(),
      durationSeconds: 300,
    });
    const afterGap = workout({
      id: "c",
      sport: "rowing",
      start: new Date(Date.parse(atGap.end) + (SESSION_GAP_MINUTES * 60 + 1) * 1000).toISOString(),
      durationSeconds: 300,
    });
    expect(groupSessions([first, atGap, afterGap]).map((s) => s.segments.length)).toEqual([2, 1]);
  });

  it("treats a standalone rowing workout as other, not an erg station", () => {
    const row = workout({
      id: "row",
      sport: "rowing",
      start: "2026-10-10T01:00:00Z",
      durationSeconds: 1200,
    });
    const [session] = groupSessions([row]);
    expect(session!.kind).toBe("other");
    expect(session!.segments[0]).toMatchObject({ role: "other", label: "Rowing" });
  });

  it("needs two runs plus a station or functional block to be a HYROX candidate", () => {
    const start = Date.parse("2026-10-10T01:00:00Z");
    const chain = (sports: string[]): ReturnType<typeof workout>[] =>
      sports.map((sport, index) =>
        workout({
          id: `w${index}`,
          sport,
          start: new Date(start + index * 10 * 60_000).toISOString(),
          durationSeconds: 300,
        })
      );
    expect(groupSessions(chain(["running", "rowing"]))[0]!.kind).toBe("other");
    expect(groupSessions(chain(["running", "functional fitness", "running"]))[0]!.kind).toBe(
      "hyrox_candidate"
    );
    expect(
      groupSessions(chain(["running", "functional fitness", "running"]))[0]!.segments[1]
    ).toMatchObject({ role: "functional", label: "Functional" });
  });

  it("skips workouts with unparseable timestamps instead of producing NaN spans", () => {
    const broken = { ...redditHyroxDay()[0]!, id: "broken", start: "not-a-date" };
    const sessions = groupSessions([broken, ...redditHyroxDay()]);
    expect(sessions.flatMap((s) => s.segments).some((s) => s.workout.id === "broken")).toBe(false);
  });

  it("honours user relabels and exclusions", () => {
    const sessions = groupSessions(redditHyroxDay(), (record) =>
      record.id === "run-4"
        ? "other"
        : record.id === "run-6"
          ? "excluded"
          : classifyWorkout(record.sport_name)
    );
    const labels = sessions[0]!.segments.map((segment) => segment.label);
    expect(labels).toContain("Running");
    expect(labels.filter((label) => label.startsWith("Run "))).toHaveLength(4);
    expect(sessions[0]!.segments.some((segment) => segment.workout.id === "run-6")).toBe(false);
  });

  it("keeps erg labels for ergs relabelled as HYROX", () => {
    const sessions = groupSessions(redditHyroxDay(), (record) =>
      record.sport_name === "rowing" ? "hyrox" : classifyWorkout(record.sport_name)
    );
    expect(sessions[0]!.segments[3]).toMatchObject({ role: "erg_station", label: "Row" });
  });
});
