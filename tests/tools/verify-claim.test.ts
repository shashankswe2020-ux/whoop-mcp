import { describe, expect, it } from "vitest";
import { verifyClaim, verifyClaimOutputSchema } from "../../src/tools/verify-claim.js";
import { PerformanceInputError } from "../../src/performance/context.js";
import { emptyPerformanceState, type PerformanceState } from "../../src/performance/schemas.js";
import {
  nights,
  performanceClient,
  redditHyroxDay,
  workout,
} from "../helpers/performance-fixtures.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const OCTOBER = { start: "2026-10-01", end: "2026-10-08" };

/** run 12 + bike 50 + swim 38 TRIMP → run share is exactly 12 %. */
function triWeek(): ReturnType<typeof workout>[] {
  return [
    workout({
      id: "run-a",
      sport: "running",
      start: "2026-10-02T06:00:00Z",
      durationSeconds: 720,
      zonesMinutes: [0, 12, 0, 0, 0, 0],
      distance: 2400,
      offset: "+00:00",
    }),
    workout({
      id: "bike-a",
      sport: "cycling",
      start: "2026-10-03T06:00:00Z",
      durationSeconds: 1500,
      zonesMinutes: [0, 0, 25, 0, 0, 0],
      distance: 12_000,
      offset: "+00:00",
    }),
    workout({
      id: "swim-a",
      sport: "swimming",
      start: "2026-10-04T06:00:00Z",
      durationSeconds: 2280,
      zonesMinutes: [0, 38, 0, 0, 0, 0],
      offset: "+00:00",
    }),
  ];
}

describe("verify_claim", () => {
  it("contradicts a 40 % run-share claim when the data says 12 %", async () => {
    const result = await verifyClaim(
      performanceClient({ workouts: triWeek() }),
      {
        metric: "discipline_share_pct",
        claimed_value: 40,
        period: OCTOBER,
        discipline: "run",
        sport: "triathlon",
      },
      { now: NOW }
    );

    expect(verifyClaimOutputSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      verdict: "contradicted",
      recomputed_value: 12,
      difference: 28,
      tolerance: { value: 2, rule: "±2 percentage points" },
    });
    expect(result.evidence.inputs).toEqual({ discipline_trimp: 12, scope_trimp: 100 });
    expect(result.evidence.workout_ids.sort()).toEqual(["bike-a", "run-a", "swim-a"]);
    expect(result.reason).toContain("data gives 12");
  });

  it("confirms a claim inside the tolerance", async () => {
    const result = await verifyClaim(
      performanceClient({ workouts: triWeek() }),
      {
        metric: "discipline_share_pct",
        claimed_value: 13.9,
        period: OCTOBER,
        discipline: "run",
        sport: "triathlon",
      },
      { now: NOW }
    );
    expect(result.verdict).toBe("confirmed");
  });

  it.each([
    ["workout_count", 3, "confirmed"],
    ["workout_count", 4, "contradicted"],
    ["training_minutes", 75.9, "confirmed"],
    ["training_minutes", 80, "contradicted"],
    ["trimp_total", 101.5, "confirmed"],
    ["distance_km", 14.45, "confirmed"],
    ["distance_km", 15, "contradicted"],
  ] as const)("%s = %s → %s", async (metric, claimed, verdict) => {
    const result = await verifyClaim(
      performanceClient({ workouts: triWeek() }),
      { metric, claimed_value: claimed, period: OCTOBER },
      { now: NOW }
    );
    expect(result.verdict).toBe(verdict);
  });

  it("ignores implausible distances and says which ones", async () => {
    const fast = workout({
      id: "run-gps",
      sport: "running",
      start: "2026-10-05T06:00:00Z",
      durationSeconds: 600,
      distance: 10_000,
      offset: "+00:00",
    });
    const result = await verifyClaim(
      performanceClient({ workouts: [...triWeek(), fast] }),
      { metric: "distance_km", claimed_value: 12.4, period: OCTOBER, discipline: "run" },
      { now: NOW }
    );
    expect(result).toMatchObject({ verdict: "contradicted", recomputed_value: 2.4 });
    expect(result.evidence.inputs).toEqual({ workouts_with_distance: 1, distance_ignored: 1 });
  });

  it("computes load change against the comparison period", async () => {
    const bike = (id: string, start: string, minutes: number): ReturnType<typeof workout> =>
      workout({
        id,
        sport: "cycling",
        start,
        durationSeconds: minutes * 60,
        zonesMinutes: [0, minutes, 0, 0, 0, 0],
        offset: "+00:00",
      });
    const client = performanceClient({
      workouts: [bike("b1", "2026-09-25T06:00:00Z", 50), bike("b2", "2026-10-02T06:00:00Z", 70)],
    });
    const params = {
      metric: "load_change_pct" as const,
      period: OCTOBER,
      comparison_period: { start: "2026-09-24", end: "2026-10-01" },
      discipline: "bike" as const,
    };
    const result = await verifyClaim(client, { ...params, claimed_value: 40 }, { now: NOW });
    expect(result).toMatchObject({ verdict: "confirmed", recomputed_value: 40 });
    expect(result.evidence.comparison_window).not.toBeNull();

    await expect(
      verifyClaim(
        client,
        { ...params, comparison_period: undefined, claimed_value: 40 },
        { now: NOW }
      )
    ).rejects.toBeInstanceOf(PerformanceInputError);
  });

  it("is unverifiable for HYROX while candidate sessions are unconfirmed", async () => {
    const client = performanceClient({ workouts: redditHyroxDay() });
    const period = { start: "2026-10-15", end: "2026-10-16" };
    const pending = await verifyClaim(
      client,
      { metric: "hyrox_sessions", claimed_value: 1, period },
      { now: NOW }
    );
    expect(pending.verdict).toBe("unverifiable");
    expect(pending.recomputed_value).toBe(0);
    expect(pending.evidence.unconfirmed_candidate_ids).toContain("run-1");

    const state: PerformanceState = {
      ...emptyPerformanceState(),
      annotations: {
        "run-1": {
          action: "relabel",
          discipline: "hyrox",
          reason: "hyrox_sim",
          updated_at: NOW.toISOString(),
        },
      },
    };
    const confirmed = await verifyClaim(
      client,
      { metric: "hyrox_sessions", claimed_value: 1, period },
      { now: NOW, loadState: async () => state }
    );
    expect(confirmed).toMatchObject({ verdict: "confirmed", recomputed_value: 1 });
    expect(confirmed.evidence.workout_ids).toContain("ski-1");
  });

  it("checks average recovery over the period's wake-up days", async () => {
    const { sleep, recovery } = nights(
      "2026-10-07",
      7,
      { recovery: 60, offset: "+00:00" },
      {
        "2026-10-03": { recovery: 74 },
      }
    );
    const result = await verifyClaim(
      performanceClient({ sleep, recovery }),
      { metric: "avg_recovery", claimed_value: 62, period: OCTOBER },
      { now: NOW }
    );
    expect(result).toMatchObject({ verdict: "confirmed", recomputed_value: 62 });
    expect(result.evidence.inputs).toEqual({ days: 7 });
    expect(Object.keys(result.data_quality.sources)).toEqual(["workout", "sleep", "recovery"]);
  });

  it("is unverifiable when there is no data, and never guesses", async () => {
    const result = await verifyClaim(
      performanceClient({ workouts: [] }),
      {
        metric: "discipline_share_pct",
        claimed_value: 30,
        period: OCTOBER,
        discipline: "swim",
      },
      { now: NOW }
    );
    expect(result).toMatchObject({
      verdict: "unverifiable",
      recomputed_value: null,
      difference: null,
    });
  });

  it("rejects inconsistent input with readable messages", async () => {
    const client = performanceClient({ workouts: [] });
    await expect(
      verifyClaim(
        client,
        { metric: "discipline_share_pct", claimed_value: 1, period: OCTOBER },
        { now: NOW }
      )
    ).rejects.toThrow("discipline_share_pct needs a discipline");
    await expect(
      verifyClaim(
        client,
        {
          metric: "workout_count",
          claimed_value: 1,
          period: OCTOBER,
          discipline: "hyrox",
          sport: "triathlon",
        },
        { now: NOW }
      )
    ).rejects.toThrow("hyrox is not part of triathlon");
  });
});
