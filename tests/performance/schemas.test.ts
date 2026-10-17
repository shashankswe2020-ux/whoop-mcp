import { describe, it, expect } from "vitest";
import {
  annotationInputSchema,
  auditEntrySchema,
  classificationRuleSchema,
  createRaceResultSchema,
  emptyPerformanceState,
  HYROX_STATIONS,
  impliedRoxzoneSeconds,
  performanceStateSchema,
  SPLIT_TOLERANCE_SECONDS,
} from "../../src/performance/schemas.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const schema = createRaceResultSchema(() => NOW);

const hyroxSplits = {
  runs: [300, 310, 320, 330, 340, 350, 360, 370],
  stations: HYROX_STATIONS.map((station) => ({ station, seconds: 240 })),
  roxzone_seconds: 400,
};
const hyroxTotal = 2680 + 8 * 240 + 400;

const hyrox = {
  sport: "hyrox",
  date: "2026-10-12",
  name: "HYROX Mumbai",
  category: "open_men",
  total_seconds: hyroxTotal,
  splits: hyroxSplits,
};

const triathlon = {
  sport: "triathlon",
  date: "2026-09-20",
  name: "Goa 70.3",
  category: "half",
  total_seconds: 2400 + 120 + 9000 + 90 + 6000,
  splits: {
    swim_seconds: 2400,
    t1_seconds: 120,
    bike_seconds: 9000,
    t2_seconds: 90,
    run_seconds: 6000,
  },
};

function messages(input: unknown): string[] {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("race result schema", () => {
  it("accepts valid HYROX and triathlon results", () => {
    expect(schema.parse(hyrox).sport).toBe("hyrox");
    expect(schema.parse(triathlon).sport).toBe("triathlon");
    expect(schema.parse({ ...hyrox, splits: undefined }).splits).toBeUndefined();
  });

  it("rejects HYROX stations out of official order", () => {
    const swapped = [...hyroxSplits.stations];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(messages({ ...hyrox, splits: { ...hyroxSplits, stations: swapped } })[0]).toMatch(
      /official order.*skierg/i
    );
  });

  it("requires exactly 8 runs and 8 stations", () => {
    expect(
      messages({ ...hyrox, splits: { ...hyroxSplits, runs: hyroxSplits.runs.slice(1) } })
    ).not.toEqual([]);
    expect(
      messages({ ...hyrox, splits: { ...hyroxSplits, stations: hyroxSplits.stations.slice(1) } })
    ).not.toEqual([]);
  });

  it.each([
    [SPLIT_TOLERANCE_SECONDS, true],
    [-SPLIT_TOLERANCE_SECONDS, true],
    [SPLIT_TOLERANCE_SECONDS + 1, false],
    [-(SPLIT_TOLERANCE_SECONDS + 1), false],
  ])("split sum off by %ss is accepted=%s", (delta, ok) => {
    expect(messages({ ...hyrox, total_seconds: hyroxTotal + delta }).length === 0).toBe(ok);
    expect(
      messages({ ...triathlon, total_seconds: triathlon.total_seconds + delta }).length === 0
    ).toBe(ok);
  });

  it("allows an omitted roxzone as long as splits do not exceed the total", () => {
    const noRox = { ...hyroxSplits, roxzone_seconds: undefined };
    expect(messages({ ...hyrox, splits: noRox })).toEqual([]);
    expect(impliedRoxzoneSeconds(schema.parse({ ...hyrox, splits: noRox }))).toBe(400);
    expect(impliedRoxzoneSeconds(schema.parse(hyrox))).toBeNull();
    expect(impliedRoxzoneSeconds(schema.parse(triathlon))).toBeNull();
    expect(messages({ ...hyrox, total_seconds: 2680 + 8 * 240 - 6, splits: noRox })[0]).toMatch(
      /exceed/
    );
  });

  it("rejects future dates, unknown categories and malformed values", () => {
    expect(messages({ ...hyrox, date: "2026-10-18" })[0]).toMatch(/future/);
    expect(messages({ ...hyrox, category: "half" })).not.toEqual([]);
    expect(messages({ ...triathlon, category: "open_men" })).not.toEqual([]);
    expect(messages({ ...hyrox, date: "12/10/2026" })).not.toEqual([]);
    expect(messages({ ...hyrox, total_seconds: -1 })).not.toEqual([]);
    expect(messages({ ...hyrox, name: "x".repeat(121) })).not.toEqual([]);
    expect(messages({ ...hyrox, sport: "marathon" })).not.toEqual([]);
  });
});

describe("annotation input schema", () => {
  it("requires a discipline only for relabel", () => {
    expect(
      annotationInputSchema.safeParse({
        workout_id: "w1",
        action: "relabel",
        discipline: "hyrox",
        reason: "hyrox_sim",
      }).success
    ).toBe(true);
    expect(
      annotationInputSchema.safeParse({
        workout_id: "w1",
        action: "relabel",
        reason: "misclassified",
      }).success
    ).toBe(false);
    expect(
      annotationInputSchema.safeParse({
        workout_id: "w1",
        action: "exclude",
        discipline: "run",
        reason: "bad_hr",
      }).success
    ).toBe(false);
    expect(
      annotationInputSchema.safeParse({ workout_id: "w1", action: "restore", reason: "other" })
        .success
    ).toBe(true);
  });

  it("rejects unknown reasons and oversized notes", () => {
    expect(
      annotationInputSchema.safeParse({ workout_id: "w1", action: "exclude", reason: "because" })
        .success
    ).toBe(false);
    expect(
      annotationInputSchema.safeParse({
        workout_id: "w1",
        action: "exclude",
        reason: "other",
        note: "x".repeat(1001),
      }).success
    ).toBe(false);
  });
});

describe("classification rule schema", () => {
  it("validates weekdays and durations", () => {
    expect(
      classificationRuleSchema.safeParse({
        sport_name: "functional fitness",
        discipline: "hyrox",
        weekdays: [6],
      }).success
    ).toBe(true);
    expect(
      classificationRuleSchema.safeParse({ sport_name: "x", discipline: "hyrox", weekdays: [7] })
        .success
    ).toBe(false);
    expect(
      classificationRuleSchema.safeParse({
        sport_name: "x",
        discipline: "hyrox",
        min_duration_minutes: 0,
      }).success
    ).toBe(false);
  });
});

describe("persisted state and audit entries", () => {
  it("round-trips the empty state", () => {
    expect(performanceStateSchema.parse(emptyPerformanceState())).toEqual({
      schema_version: 1,
      race_results: [],
      annotations: {},
      rules: [],
    });
  });

  it("rejects unknown schema versions", () => {
    expect(
      performanceStateSchema.safeParse({ ...emptyPerformanceState(), schema_version: 2 }).success
    ).toBe(false);
  });

  it("validates audit entries", () => {
    expect(
      auditEntrySchema.safeParse({
        id: "6a3a2c3e-0e0f-4d55-9d0f-3c6b7c1a9e10",
        at: "2026-10-17T12:00:00.000Z",
        actor: "dashboard",
        action: "annotate_workout",
        workout_id: "w1",
        before: null,
        after: { action: "exclude" },
        reason: "bad_hr",
      }).success
    ).toBe(true);
    expect(auditEntrySchema.safeParse({ id: "x", at: "now", actor: "robot" }).success).toBe(false);
  });
});
