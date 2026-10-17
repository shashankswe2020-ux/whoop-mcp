import { describe, expect, it } from "vitest";
import { WhoopNetworkError } from "../../src/api/client.js";
import {
  getHyroxSessionReport,
  hyroxSessionReportOutputSchema,
} from "../../src/tools/get-hyrox-session-report.js";
import { emptyPerformanceState } from "../../src/performance/schemas.js";
import { PerformanceStoreError } from "../../src/performance/store.js";
import {
  cycle,
  nights,
  performanceClient,
  redditHyroxDay,
} from "../helpers/performance-fixtures.js";

const NOW = new Date("2026-10-16T03:00:00Z");

function redditClient(): ReturnType<typeof performanceClient> {
  const wellness = nights(
    "2026-10-15",
    31,
    { recovery: 70, hrv: 60, rhr: 50 },
    {
      "2026-10-15": { recovery: 45, hrv: 48, rhr: 55, sleepHours: 6.5 },
    }
  );
  return performanceClient({
    workouts: redditHyroxDay(),
    ...wellness,
    cycles: [cycle("2026-10-15", 17.2)],
  });
}

describe("get_hyrox_session_report", () => {
  it("reproduces the Reddit HYROX simulation report", async () => {
    const report = await getHyroxSessionReport(
      redditClient(),
      { date: "2026-10-15" },
      { now: NOW }
    );

    expect(hyroxSessionReportOutputSchema.parse(report)).toEqual(report);
    expect(report.status).toBe("available");
    expect(report.session).toMatchObject({
      kind: "hyrox_candidate",
      confirmed_hyrox: false,
      span_seconds: 2786,
      tracked_seconds: 2424,
      transition_seconds: 362,
      transition_share: 0.1299,
      peak_hr: 171,
      kcal: 416,
      segment_count: 9,
    });
    expect(report.segments.map((segment) => segment.label)).toEqual([
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
    expect(report.segments[3]).toMatchObject({
      workout_id: "row-1",
      duration_seconds: 178,
      avg_hr: 122,
      max_hr: 131,
      strain: 4.1,
      kcal: 18,
    });
    expect(report.other_activities).toEqual([
      expect.objectContaining({ workout_id: "lift-1", label: "weightlifting", strain: 11.9 }),
    ]);
    expect(report.sessions_on_day).toHaveLength(2);
  });

  it("fires the four session insights with their rules and refs", async () => {
    const report = await getHyroxSessionReport(
      redditClient(),
      { date: "2026-10-15" },
      { now: NOW }
    );
    const byId = Object.fromEntries(report.insights.map((insight) => [insight.id, insight]));

    expect(Object.keys(byId)).toEqual([
      "negative_split",
      "ergs_are_recovery",
      "transition_heavy",
      "hidden_cost",
      "day_context",
    ]);
    expect(byId.negative_split!.workout_ids).toEqual(["run-1", "run-6"]);
    expect(byId.negative_split!.text).toContain("162 bpm");
    expect(byId.ergs_are_recovery!.text).toContain("128.7 bpm vs 143.8 bpm");
    expect(byId.transition_heavy!.text).toContain("362s (13%)");
    expect(byId.hidden_cost!.workout_ids).toEqual(["lift-1"]);
    expect(byId.day_context!.text).toContain("yellow recovery day (45%)");
    for (const insight of report.insights) expect(insight.rule.length).toBeGreaterThan(10);
  });

  it("includes the day context against a 30-day baseline", async () => {
    const report = await getHyroxSessionReport(
      redditClient(),
      { date: "2026-10-15" },
      { now: NOW }
    );
    expect(report.day_context).toEqual({
      recovery_score: 45,
      recovery_band: "yellow",
      hrv_rmssd_milli: 48,
      hrv_baseline_milli: 60,
      resting_heart_rate: 55,
      rhr_baseline: 50,
      baseline_days: 30,
      sleep_hours: 6.5,
      sleep_performance_pct: 90,
      respiratory_rate: 15.2,
      spo2_pct: 96,
      day_strain: 17.2,
    });
  });

  it("ends with the caveats the report's data triggers", async () => {
    const report = await getHyroxSessionReport(
      redditClient(),
      { date: "2026-10-15" },
      { now: NOW }
    );
    const caveats = Object.fromEntries(report.caveats.map((caveat) => [caveat.id, caveat]));

    expect(caveats.indoor_distance!.workout_ids).toEqual(
      expect.arrayContaining(["ski-1", "run-6"])
    );
    expect(caveats.short_segment_mislabel!.workout_ids).toEqual(["run-4"]);
    expect(caveats.strain_not_additive).toBeDefined();
    expect(caveats.hyrox_stations_invisible).toBeDefined();
    expect(caveats.no_hr_curve).toBeDefined();
  });

  it("sums zone durations across the session segments only", async () => {
    const report = await getHyroxSessionReport(
      redditClient(),
      { date: "2026-10-15" },
      { now: NOW }
    );
    expect(report.time_in_zone_seconds!.zone_one).toBe(2424);
    expect(report.time_in_zone_seconds!.zone_five).toBe(0);
  });

  it("defaults to the most recent day with a workout", async () => {
    const report = await getHyroxSessionReport(redditClient(), {}, { now: NOW });
    expect(report.date).toBe("2026-10-15");
    expect(report.session?.kind).toBe("hyrox_candidate");
  });

  it("selects a specific session by start time", async () => {
    const lift = redditHyroxDay().find((workout) => workout.id === "lift-1")!;
    const report = await getHyroxSessionReport(
      redditClient(),
      { session_start: lift.start },
      { now: NOW }
    );
    expect(report.session).toMatchObject({ kind: "other", segment_count: 1 });
    expect(report.caveats.some((caveat) => caveat.id === "hyrox_stations_invisible")).toBe(false);
  });

  it("marks the session confirmed after a user relabels a segment as HYROX", async () => {
    const state = emptyPerformanceState();
    state.annotations["ski-1"] = {
      action: "relabel",
      discipline: "hyrox",
      reason: "hyrox_sim",
      updated_at: "2026-10-15T16:00:00Z",
    };
    const report = await getHyroxSessionReport(
      redditClient(),
      { date: "2026-10-15" },
      { now: NOW, loadState: async () => state }
    );
    expect(report.session?.confirmed_hyrox).toBe(true);
    expect(report.store.status).toBe("available");
  });

  it("drops user-excluded workouts from the session", async () => {
    const state = emptyPerformanceState();
    state.annotations["run-4"] = {
      action: "exclude",
      reason: "misclassified",
      updated_at: "2026-10-15T16:00:00Z",
    };
    const report = await getHyroxSessionReport(
      redditClient(),
      { date: "2026-10-15" },
      { now: NOW, loadState: async () => state }
    );
    expect(report.segments.map((segment) => segment.workout_id)).not.toContain("run-4");
    expect(report.session?.segment_count).toBe(8);
  });

  it("reports no_session without inventing data", async () => {
    const report = await getHyroxSessionReport(
      performanceClient({}),
      { date: "2026-10-15" },
      { now: NOW }
    );
    expect(hyroxSessionReportOutputSchema.parse(report)).toEqual(report);
    expect(report).toMatchObject({
      status: "no_session",
      session: null,
      segments: [],
      insights: [],
    });
  });

  it("omits insights whose inputs are missing", async () => {
    const runsOnly = redditHyroxDay().filter((workout) => workout.sport_name === "running");
    const report = await getHyroxSessionReport(
      performanceClient({ workouts: runsOnly }),
      { date: "2026-10-15" },
      { now: NOW }
    );
    const ids = report.insights.map((insight) => insight.id);
    expect(ids).not.toContain("ergs_are_recovery");
    expect(ids).not.toContain("hidden_cost");
    expect(ids).not.toContain("day_context");
  });

  it("degrades to WHOOP-only results when the local store is unavailable or broken", async () => {
    const remote = await getHyroxSessionReport(
      redditClient(),
      { date: "2026-10-15" },
      { now: NOW }
    );
    expect(remote.store.status).toBe("not_configured");

    const broken = await getHyroxSessionReport(
      redditClient(),
      { date: "2026-10-15" },
      {
        now: NOW,
        loadState: async () => {
          throw new PerformanceStoreError("corrupt", "performance.json is not valid JSON.");
        },
      }
    );
    expect(broken.store).toEqual({
      status: "error",
      message: "performance.json is not valid JSON.",
    });
    expect(broken.status).toBe("available");
  });

  it("throws a network error when workouts cannot be fetched", async () => {
    await expect(
      getHyroxSessionReport(
        performanceClient({ workouts: new Error("down") }),
        { date: "2026-10-15" },
        { now: NOW }
      )
    ).rejects.toBeInstanceOf(WhoopNetworkError);
  });

  it("rejects future days and malformed input", async () => {
    await expect(
      getHyroxSessionReport(redditClient(), { date: "2026-12-01" }, { now: NOW })
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      getHyroxSessionReport(redditClient(), { date: "15/10/2026" }, { now: NOW })
    ).rejects.toThrow();
  });
});
