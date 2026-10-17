import { describe, expect, it } from "vitest";
import { getRaceReadiness, raceReadinessOutputSchema } from "../../src/tools/get-race-readiness.js";
import { emptyPerformanceState } from "../../src/performance/schemas.js";
import { dailyWorkouts, nights, performanceClient } from "../helpers/performance-fixtures.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const ZONES: [number, number, number, number, number, number] = [0, 20, 20, 0, 0, 0];

/** 60 days of swim/bike/run ending 2026-10-12, then a 7-day rest → positive form. */
function triathlonBlock(): ReturnType<typeof dailyWorkouts> {
  return [
    ...dailyWorkouts("2026-10-12", 60, "swimming", ZONES, "swim"),
    ...dailyWorkouts("2026-10-12", 60, "cycling", ZONES, "bike"),
    ...dailyWorkouts("2026-10-12", 60, "running", ZONES, "run"),
  ];
}

function wellness(todayRecovery: number, debtHours = 0.5): ReturnType<typeof nights> {
  return nights(
    "2026-10-20",
    31,
    { recovery: 70, offset: "+00:00", debtHours },
    { "2026-10-20": { recovery: todayRecovery, offset: "+00:00", debtHours } }
  );
}

describe("get_race_readiness", () => {
  it("returns ready with five evidenced components when everything is green", async () => {
    const result = await getRaceReadiness(
      performanceClient({ workouts: triathlonBlock(), ...wellness(80) }),
      { sport: "triathlon" },
      { now: NOW }
    );
    expect(raceReadinessOutputSchema.parse(result)).toEqual(result);
    expect(result.today).toBe("2026-10-20");
    expect(result.components.map((component) => [component.id, component.band])).toEqual([
      ["recovery", "green"],
      ["form", "green"],
      ["specificity", "green"],
      ["sleep", "green"],
      ["taper", "not_applicable"],
    ]);
    expect(result.band).toBe("ready");
    for (const component of result.components) {
      expect(component.metric.method).toBeTruthy();
      expect(component.metric.method_version).toBe("1.0.0");
      expect(Array.isArray(component.metric.limitations)).toBe(true);
    }
    expect(result.load.series.length).toBeLessThanOrEqual(90);
    expect(result.components[0]!.rationale).toContain("30-day mean is 70%");
  });

  it("returns insufficient_data without NaN when history is short", async () => {
    const result = await getRaceReadiness(
      performanceClient({ workouts: dailyWorkouts("2026-10-19", 10, "running", ZONES) }),
      { sport: "hyrox" },
      { now: NOW }
    );
    expect(result.band).toBe("insufficient_data");
    expect(result.load.status).toBe("insufficient_data");
    expect(JSON.stringify(result)).not.toContain("NaN");
    expect(raceReadinessOutputSchema.parse(result)).toEqual(result);
  });

  it("is not_ready when any component is red", async () => {
    const result = await getRaceReadiness(
      performanceClient({ workouts: triathlonBlock(), ...wellness(20) }),
      { sport: "triathlon" },
      { now: NOW }
    );
    expect(result.components[0]!.band).toBe("red");
    expect(result.band).toBe("not_ready");
  });

  it("uses WHOOP's sleep-debt need for the sleep component", async () => {
    const result = await getRaceReadiness(
      performanceClient({ workouts: triathlonBlock(), ...wellness(80, 6) }),
      { sport: "triathlon" },
      { now: NOW }
    );
    expect(result.components[3]).toMatchObject({ id: "sleep", band: "red" });
  });

  it("evaluates the taper when the race is within 14 days", async () => {
    const result = await getRaceReadiness(
      performanceClient({ workouts: triathlonBlock(), ...wellness(80) }),
      { sport: "triathlon", race_date: "2026-10-25" },
      { now: NOW }
    );
    expect(result.days_to_race).toBe(5);
    expect(result.components[4]).toMatchObject({ id: "taper", band: "green" });
  });

  it("flags HYROX specificity until functional work is confirmed as HYROX", async () => {
    const workouts = [
      ...dailyWorkouts("2026-10-12", 60, "running", ZONES, "run"),
      ...dailyWorkouts("2026-10-12", 60, "functional fitness", ZONES, "ff"),
    ];
    const client = (): ReturnType<typeof performanceClient> =>
      performanceClient({ workouts, ...wellness(80) });
    const before = await getRaceReadiness(client(), { sport: "hyrox" }, { now: NOW });
    expect(before.components[2]!.band).toBe("amber");

    const state = emptyPerformanceState();
    state.rules.push({ sport_name: "functional fitness", discipline: "hyrox" });
    const after = await getRaceReadiness(
      client(),
      { sport: "hyrox" },
      { now: NOW, loadState: async () => state }
    );
    expect(after.components[2]!.band).toBe("green");
    expect(after.store.status).toBe("available");
  });

  it("treats missing recovery today as unknown, not as a stale value", async () => {
    const yesterdayOnly = nights("2026-10-19", 30, { recovery: 80, offset: "+00:00" });
    const result = await getRaceReadiness(
      performanceClient({ workouts: triathlonBlock(), ...yesterdayOnly }),
      { sport: "triathlon" },
      { now: NOW }
    );
    expect(result.components[0]!.band).toBe("unknown");
    expect(result.components[3]!.band).toBe("green");
  });

  it("validates input", async () => {
    const client = performanceClient({});
    await expect(
      getRaceReadiness(client, { sport: "marathon" as "hyrox" }, { now: NOW })
    ).rejects.toThrow();
    await expect(
      getRaceReadiness(client, { sport: "hyrox", race_date: "2028-01-01" }, { now: NOW })
    ).rejects.toBeInstanceOf(RangeError);
  });
});
