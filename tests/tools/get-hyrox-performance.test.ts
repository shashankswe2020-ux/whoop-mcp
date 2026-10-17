import { describe, expect, it } from "vitest";
import { WhoopNetworkError } from "../../src/api/client.js";
import {
  analyseStations,
  getHyroxPerformance,
  hyroxPerformanceOutputSchema,
} from "../../src/tools/get-hyrox-performance.js";
import {
  emptyPerformanceState,
  HYROX_STATIONS,
  type PerformanceState,
  type StoredRaceResult,
} from "../../src/performance/schemas.js";
import { performanceClient, redditHyroxDay, workout } from "../helpers/performance-fixtures.js";

const NOW = new Date("2026-10-20T12:00:00Z");

function race(
  index: number,
  date: string,
  stationSeconds: number[],
  roxzone?: number,
  category: "open_men" | "pro_men" = "open_men"
): Extract<StoredRaceResult, { sport: "hyrox" }> {
  const runs = Array.from({ length: 8 }, () => 300);
  const sum = runs.reduce((a, b) => a + b, 0) + stationSeconds.reduce((a, b) => a + b, 0);
  return {
    id: `00000000-0000-4000-8000-00000000000${index}`,
    created_at: `${date}T20:00:00Z`,
    sport: "hyrox",
    category,
    date,
    name: `Race ${index}`,
    total_seconds: sum + (roxzone ?? 400),
    splits: {
      runs,
      stations: HYROX_STATIONS.map((station, i) => ({ station, seconds: stationSeconds[i]! })),
      ...(roxzone === undefined ? {} : { roxzone_seconds: roxzone }),
    },
  };
}

const BASE = [240, 180, 260, 300, 270, 120, 330, 420];

function stateWith(mutate: (state: PerformanceState) => void): () => Promise<PerformanceState> {
  const state = emptyPerformanceState();
  mutate(state);
  return async () => state;
}

describe("get_hyrox_performance", () => {
  it("lists a Reddit-style sim as an unconfirmed candidate and excludes it from HYROX load", async () => {
    const result = await getHyroxPerformance(
      performanceClient({ workouts: redditHyroxDay() }),
      {},
      { now: NOW }
    );
    expect(hyroxPerformanceOutputSchema.parse(result)).toEqual(result);
    expect(result.sessions).toEqual([]);
    expect(result.unconfirmed_candidates.count).toBe(1);
    expect(result.unconfirmed_candidates.items[0]).toMatchObject({
      kind: "session",
      workout_ids: expect.arrayContaining(["run-1", "ski-1", "row-1"]),
    });
    expect(result.weekly[0]!.hyrox.workouts).toBe(0);
    expect(result.weekly[0]!.run.workouts).toBe(6);
  });

  it("counts the session once the user confirms it", async () => {
    const result = await getHyroxPerformance(
      performanceClient({ workouts: redditHyroxDay() }),
      {},
      {
        now: NOW,
        loadState: stateWith((state) => {
          for (const id of ["ski-1", "row-1", "ski-2"])
            state.annotations[id] = {
              action: "relabel",
              discipline: "hyrox",
              reason: "hyrox_sim",
              updated_at: "2026-10-16T00:00:00Z",
            };
        }),
      }
    );
    expect(result.unconfirmed_candidates.count).toBe(0);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      run_segments: 6,
      station_segments: 3,
      transition_share: 0.1299,
    });
    expect(result.weekly[0]).toMatchObject({
      week_start: "2026-10-12",
      confirmed_sessions: 1,
      hyrox: { workouts: 3 },
    });
  });

  it("reports a standalone Functional Fitness workout as a candidate until relabelled", async () => {
    const ff = workout({
      id: "ff-1",
      sport: "functional fitness",
      start: "2026-10-17T06:00:00Z",
      durationSeconds: 3600,
      zonesMinutes: [0, 10, 20, 20, 10, 0],
    });
    const before = await getHyroxPerformance(
      performanceClient({ workouts: [ff] }),
      {},
      { now: NOW }
    );
    expect(before.unconfirmed_candidates.items[0]).toMatchObject({
      kind: "workout",
      workout_ids: ["ff-1"],
    });
    expect(before.weekly[0]!.hyrox.trimp).toBe(0);

    const after = await getHyroxPerformance(
      performanceClient({ workouts: [ff] }),
      {},
      {
        now: NOW,
        loadState: stateWith((state) => {
          state.annotations["ff-1"] = {
            action: "relabel",
            discipline: "hyrox",
            reason: "hyrox_sim",
            updated_at: "2026-10-17T08:00:00Z",
          };
        }),
      }
    );
    expect(after.unconfirmed_candidates.count).toBe(0);
    // Edwards TRIMP: 10×1 + 20×2 + 20×3 + 10×4 = 150
    expect(after.weekly[0]!.hyrox).toEqual({ workouts: 1, minutes: 60, trimp: 150 });
  });

  it("applies user classification rules", async () => {
    const ff = workout({
      id: "ff-sat",
      sport: "functional fitness",
      start: "2026-10-17T06:00:00Z",
      durationSeconds: 4200,
      offset: "+00:00",
    });
    const result = await getHyroxPerformance(
      performanceClient({ workouts: [ff] }),
      {},
      {
        now: NOW,
        loadState: stateWith((state) => {
          state.rules.push({
            sport_name: "functional fitness",
            discipline: "hyrox",
            min_duration_minutes: 60,
            weekdays: [6],
          });
        }),
      }
    );
    expect(result.weekly[0]!.hyrox.workouts).toBe(1);
  });

  it("lists races newest first with logged or implied roxzone", async () => {
    const result = await getHyroxPerformance(
      performanceClient({}),
      {},
      {
        now: NOW,
        loadState: stateWith((state) => {
          state.race_results.push(race(1, "2026-03-01", BASE, 420));
          const implied = race(2, "2026-06-01", BASE);
          if (implied.splits) delete implied.splits.roxzone_seconds;
          state.race_results.push(implied);
        }),
      }
    );
    expect(result.races.map((item) => item.name)).toEqual(["Race 2", "Race 1"]);
    expect(result.races[0]).toMatchObject({ roxzone_seconds: 400, roxzone_source: "implied" });
    expect(result.races[1]).toMatchObject({ roxzone_seconds: 420, roxzone_source: "logged" });
  });

  it("needs at least two races for a personal weakest station", () => {
    expect(analyseStations([race(1, "2026-03-01", BASE, 400)])).toMatchObject({
      status: "insufficient_data",
      races_used: 1,
      weakest_station: null,
      stations: [],
    });
  });

  it("finds the weakest station against your own median", () => {
    const latest = [...BASE];
    latest[6] = 400; // sandbag lunges: +70 s (+21.2 %) vs 330 median
    latest[1] = 200; // sled push: +20 s (+11.1 %)
    const analysis = analyseStations([
      race(1, "2026-03-01", BASE, 400),
      race(2, "2026-05-01", BASE, 400),
      race(3, "2026-08-01", latest, 400),
    ]);
    expect(analysis).toMatchObject({
      status: "available",
      races_used: 3,
      latest_race_id: race(3, "2026-08-01", latest).id,
      weakest_station: "sandbag_lunges",
    });
    expect(analysis.stations[6]).toEqual({
      station: "sandbag_lunges",
      median_seconds: 330,
      latest_seconds: 400,
      delta_seconds: 70,
      delta_pct: 21.2,
    });
  });

  it("reports no weakest station when the latest race matches or beats every median", () => {
    const analysis = analyseStations([
      race(1, "2026-03-01", BASE, 400),
      race(2, "2026-05-01", BASE, 400),
    ]);
    expect(analysis.weakest_station).toBeNull();
  });

  it("computes PRs per division and per station", async () => {
    const faster = BASE.map((value) => value - 10);
    const result = await getHyroxPerformance(
      performanceClient({}),
      {},
      {
        now: NOW,
        loadState: stateWith((state) => {
          state.race_results.push(race(1, "2026-03-01", BASE, 400));
          state.race_results.push(race(2, "2026-05-01", faster, 400));
          state.race_results.push(race(3, "2026-06-01", BASE, 300, "pro_men"));
        }),
      }
    );
    expect(result.personal_records.best_total_by_division).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "open_men",
          race_id: race(2, "2026-05-01", faster).id,
        }),
        expect.objectContaining({ category: "pro_men" }),
      ])
    );
    expect(result.personal_records.best_station[0]).toEqual({
      station: "skierg",
      seconds: 230,
      race_id: race(2, "2026-05-01", faster).id,
    });
  });

  it("works without the local store (remote mode)", async () => {
    const result = await getHyroxPerformance(performanceClient({}), {}, { now: NOW });
    expect(result.store.status).toBe("not_configured");
    expect(result.races).toEqual([]);
    expect(result.station_analysis.status).toBe("insufficient_data");
    expect(hyroxPerformanceOutputSchema.parse(result)).toEqual(result);
  });

  it("excludes user-excluded workouts and counts them", async () => {
    const result = await getHyroxPerformance(
      performanceClient({ workouts: redditHyroxDay() }),
      {},
      {
        now: NOW,
        loadState: stateWith((state) => {
          state.annotations["run-4"] = {
            action: "exclude",
            reason: "misclassified",
            updated_at: "2026-10-16T00:00:00Z",
          };
        }),
      }
    );
    expect(result.weekly[0]!.run.workouts).toBe(5);
    expect(result.data_quality.sources.workout!.exclusions.user_excluded).toBe(1);
  });

  it("caps weekly output and validates the window", async () => {
    await expect(
      getHyroxPerformance(performanceClient({}), { start: "2025-01-01" }, { now: NOW })
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      getHyroxPerformance(performanceClient({}), { start: "nope" }, { now: NOW })
    ).rejects.toThrow();
    await expect(
      getHyroxPerformance(performanceClient({ workouts: new Error("x") }), {}, { now: NOW })
    ).rejects.toBeInstanceOf(WhoopNetworkError);
  });
});
