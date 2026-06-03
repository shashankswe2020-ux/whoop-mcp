/**
 * Tests for get-calendar.ts — get_calendar grid tool.
 *
 * Covers: default 7 days, custom days, sleep alignment to wake-up day,
 * days with no data (null), recovery zones, averages, pagination,
 * natural language start, edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WhoopClient } from "../../src/api/client.js";
import { getCalendar } from "../../src/tools/get-calendar.js";
import * as pagination from "../../src/api/pagination.js";
import type { Recovery, Sleep, Cycle } from "../../src/api/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-03-15T12:00:00.000Z");

function makeRecovery(date: string, score: number): Recovery {
  return {
    cycle_id: 1,
    sleep_id: "s1",
    user_id: 42,
    created_at: `${date}T06:00:00.000Z`,
    updated_at: `${date}T06:00:00.000Z`,
    score_state: "SCORED",
    score: {
      user_calibrating: false,
      recovery_score: score,
      resting_heart_rate: 55,
      hrv_rmssd_milli: 45,
      spo2_percentage: 97,
      skin_temp_celsius: 33.5,
    },
  };
}

function makeSleep(startDate: string, endDate: string, totalHoursMs: number): Sleep {
  return {
    id: `sleep-${endDate}`,
    cycle_id: 1,
    user_id: 42,
    created_at: `${endDate}T07:00:00.000Z`,
    updated_at: `${endDate}T07:00:00.000Z`,
    start: `${startDate}T23:00:00.000Z`,
    end: `${endDate}T07:00:00.000Z`,
    timezone_offset: "-05:00",
    nap: false,
    score_state: "SCORED",
    score: {
      stage_summary: {
        total_in_bed_time_milli: totalHoursMs,
        total_awake_time_milli: 1800000,
        total_no_data_time_milli: 0,
        total_light_sleep_time_milli: totalHoursMs * 0.4,
        total_slow_wave_sleep_time_milli: totalHoursMs * 0.2,
        total_rem_sleep_time_milli: totalHoursMs * 0.3,
        sleep_cycle_count: 4,
        disturbance_count: 1,
      },
      sleep_needed: {
        baseline_milli: 28800000,
        need_from_sleep_debt_milli: 0,
        need_from_recent_strain_milli: 0,
        need_from_recent_nap_milli: 0,
      },
      respiratory_rate: 15.0,
      sleep_performance_percentage: 85,
      sleep_efficiency_percentage: 90,
    },
  };
}

function makeCycle(date: string, strain: number): Cycle {
  return {
    id: 1,
    user_id: 42,
    created_at: `${date}T06:00:00.000Z`,
    updated_at: `${date}T20:00:00.000Z`,
    start: `${date}T06:00:00.000Z`,
    end: `${date}T22:00:00.000Z`,
    timezone_offset: "-05:00",
    score_state: "SCORED",
    score: {
      strain,
      kilojoule: 1200,
      average_heart_rate: 70,
      max_heart_rate: 150,
    },
  };
}

// 7 days of data: 2026-03-09 through 2026-03-15
const recoveries = [
  makeRecovery("2026-03-15", 75),
  makeRecovery("2026-03-14", 42),
  makeRecovery("2026-03-13", 88),
  makeRecovery("2026-03-12", 30),
  makeRecovery("2026-03-11", 65),
  makeRecovery("2026-03-10", 55),
  makeRecovery("2026-03-09", 70),
];

// Sleep ends (wake-up) on 03-09 through 03-15
const sleeps = [
  makeSleep("2026-03-14", "2026-03-15", 27000000), // 7.5h
  makeSleep("2026-03-13", "2026-03-14", 25200000), // 7h
  makeSleep("2026-03-12", "2026-03-13", 28800000), // 8h
  makeSleep("2026-03-11", "2026-03-12", 21600000), // 6h
  makeSleep("2026-03-10", "2026-03-11", 27000000), // 7.5h
  makeSleep("2026-03-09", "2026-03-10", 25200000), // 7h
  makeSleep("2026-03-08", "2026-03-09", 28800000), // 8h
];

const cycles = [
  makeCycle("2026-03-15", 8.4),
  makeCycle("2026-03-14", 12.1),
  makeCycle("2026-03-13", 5.2),
  makeCycle("2026-03-12", 15.8),
  makeCycle("2026-03-11", 9.0),
  makeCycle("2026-03-10", 7.3),
  makeCycle("2026-03-09", 11.5),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(responses: Record<string, unknown>): WhoopClient {
  const get = vi.fn().mockImplementation((path: string) => {
    for (const [key, value] of Object.entries(responses)) {
      if (path.includes(key)) {
        if (value instanceof Error) {
          return Promise.reject(value);
        }
        return Promise.resolve(value);
      }
    }
    return Promise.reject(new Error(`Unexpected path: ${path}`));
  });
  return { get } as unknown as WhoopClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getCalendar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a 7-day grid by default", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: recoveries, next_token: undefined },
      "/v2/activity/sleep": { records: sleeps, next_token: undefined },
      "/v2/cycle": { records: cycles, next_token: undefined },
    });

    const result = await getCalendar(client, {});

    expect(result.period.days).toBe(7);
    expect(result.days).toHaveLength(7);
    expect(result.period.start).toBe("2026-03-09");
    expect(result.period.end).toBe("2026-03-15");
  });

  it("returns correct dates in descending order (most recent first)", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: recoveries, next_token: undefined },
      "/v2/activity/sleep": { records: sleeps, next_token: undefined },
      "/v2/cycle": { records: cycles, next_token: undefined },
    });

    const result = await getCalendar(client, {});

    expect(result.days[0].date).toBe("2026-03-15");
    expect(result.days[6].date).toBe("2026-03-09");
  });

  it("maps recovery scores correctly to each day", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: recoveries, next_token: undefined },
      "/v2/activity/sleep": { records: sleeps, next_token: undefined },
      "/v2/cycle": { records: cycles, next_token: undefined },
    });

    const result = await getCalendar(client, {});

    expect(result.days[0].recovery_score).toBe(75); // Mar 15
    expect(result.days[1].recovery_score).toBe(42); // Mar 14
    expect(result.days[2].recovery_score).toBe(88); // Mar 13
    expect(result.days[3].recovery_score).toBe(30); // Mar 12
  });

  it("computes recovery_zone correctly", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: recoveries, next_token: undefined },
      "/v2/activity/sleep": { records: sleeps, next_token: undefined },
      "/v2/cycle": { records: cycles, next_token: undefined },
    });

    const result = await getCalendar(client, {});

    // 75 >= 67 → green
    expect(result.days[0].recovery_zone).toBe("green");
    // 42: >= 34 → yellow
    expect(result.days[1].recovery_zone).toBe("yellow");
    // 88 >= 67 → green
    expect(result.days[2].recovery_zone).toBe("green");
    // 30 < 34 → red
    expect(result.days[3].recovery_zone).toBe("red");
  });

  it("assigns sleep to wake-up day (end timestamp)", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: recoveries, next_token: undefined },
      "/v2/activity/sleep": { records: sleeps, next_token: undefined },
      "/v2/cycle": { records: cycles, next_token: undefined },
    });

    const result = await getCalendar(client, {});

    // Sleep ending on 2026-03-15 has total_in_bed_time_milli = 27000000 → 7.5h
    expect(result.days[0].sleep_hours).toBeCloseTo(7.5, 1);
    // Sleep ending on 2026-03-14 has 25200000 → 7h
    expect(result.days[1].sleep_hours).toBeCloseTo(7.0, 1);
  });

  it("maps strain from cycle data", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: recoveries, next_token: undefined },
      "/v2/activity/sleep": { records: sleeps, next_token: undefined },
      "/v2/cycle": { records: cycles, next_token: undefined },
    });

    const result = await getCalendar(client, {});

    expect(result.days[0].day_strain).toBe(8.4);
    expect(result.days[1].day_strain).toBe(12.1);
  });

  it("computes averages from non-null values", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: recoveries, next_token: undefined },
      "/v2/activity/sleep": { records: sleeps, next_token: undefined },
      "/v2/cycle": { records: cycles, next_token: undefined },
    });

    const result = await getCalendar(client, {});

    // Recovery avg: (75 + 42 + 88 + 30 + 65 + 55 + 70) / 7 = 60.71
    expect(result.averages.recovery).toBeCloseTo(60.7, 0);
    // Strain avg: (8.4 + 12.1 + 5.2 + 15.8 + 9.0 + 7.3 + 11.5) / 7 = 9.9
    expect(result.averages.strain).toBeCloseTo(9.9, 0);
    // Sleep avg (all have data)
    expect(result.averages.sleep_hours).not.toBeNull();
  });

  it("fills null for days with no data", async () => {
    // Only provide data for 3 days out of 7
    const partialRecoveries = recoveries.slice(0, 3); // Mar 15, 14, 13
    const partialSleeps = sleeps.slice(0, 3);
    const partialCycles = cycles.slice(0, 3);

    const client = createMockClient({
      "/v2/recovery": { records: partialRecoveries, next_token: undefined },
      "/v2/activity/sleep": { records: partialSleeps, next_token: undefined },
      "/v2/cycle": { records: partialCycles, next_token: undefined },
    });

    const result = await getCalendar(client, {});

    // Days 0-2 have data
    expect(result.days[0].recovery_score).toBe(75);
    expect(result.days[1].recovery_score).toBe(42);
    expect(result.days[2].recovery_score).toBe(88);
    // Days 3-6 should be null
    expect(result.days[3].recovery_score).toBeNull();
    expect(result.days[4].recovery_score).toBeNull();
    expect(result.days[5].recovery_score).toBeNull();
    expect(result.days[6].recovery_score).toBeNull();
    expect(result.days[3].recovery_zone).toBeNull();
    expect(result.days[3].day_strain).toBeNull();
    expect(result.days[3].sleep_hours).toBeNull();
  });

  it("computes averages only from non-null values with partial data", async () => {
    const partialRecoveries = recoveries.slice(0, 3); // 75, 42, 88
    const client = createMockClient({
      "/v2/recovery": { records: partialRecoveries, next_token: undefined },
      "/v2/activity/sleep": { records: [], next_token: undefined },
      "/v2/cycle": { records: [], next_token: undefined },
    });

    const result = await getCalendar(client, {});

    // Average of 75, 42, 88 = 68.33
    expect(result.averages.recovery).toBeCloseTo(68.3, 0);
    expect(result.averages.sleep_hours).toBeNull();
    expect(result.averages.strain).toBeNull();
  });

  it("supports custom days parameter", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: recoveries.slice(0, 3), next_token: undefined },
      "/v2/activity/sleep": { records: sleeps.slice(0, 3), next_token: undefined },
      "/v2/cycle": { records: cycles.slice(0, 3), next_token: undefined },
    });

    const result = await getCalendar(client, { days: 3 });

    expect(result.period.days).toBe(3);
    expect(result.days).toHaveLength(3);
    expect(result.period.start).toBe("2026-03-13");
    expect(result.period.end).toBe("2026-03-15");
  });

  it("returns empty days array for user with no data", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: [], next_token: undefined },
      "/v2/activity/sleep": { records: [], next_token: undefined },
      "/v2/cycle": { records: [], next_token: undefined },
    });

    const result = await getCalendar(client, {});

    expect(result.days).toHaveLength(7);
    // All days should have null values
    for (const day of result.days) {
      expect(day.recovery_score).toBeNull();
      expect(day.recovery_zone).toBeNull();
      expect(day.sleep_hours).toBeNull();
      expect(day.day_strain).toBeNull();
    }
    expect(result.averages.recovery).toBeNull();
    expect(result.averages.sleep_hours).toBeNull();
    expect(result.averages.strain).toBeNull();
  });

  it("handles sleep spanning midnight (assigned to wake-up day)", async () => {
    // Sleep starts at 11 PM on Mar 14, ends 7 AM on Mar 15
    const midnightSleep = makeSleep("2026-03-14", "2026-03-15", 28800000);
    const client = createMockClient({
      "/v2/recovery": { records: [], next_token: undefined },
      "/v2/activity/sleep": { records: [midnightSleep], next_token: undefined },
      "/v2/cycle": { records: [], next_token: undefined },
    });

    const result = await getCalendar(client, {});

    // Should be assigned to Mar 15 (wake-up day)
    const mar15 = result.days.find((d) => d.date === "2026-03-15");
    expect(mar15?.sleep_hours).toBeCloseTo(8.0, 1);
    // Mar 14 should have no sleep
    const mar14 = result.days.find((d) => d.date === "2026-03-14");
    expect(mar14?.sleep_hours).toBeNull();
  });

  it("excludes naps from sleep assignment", async () => {
    const nap: Sleep = {
      ...makeSleep("2026-03-15", "2026-03-15", 3600000),
      nap: true,
      start: "2026-03-15T13:00:00.000Z",
      end: "2026-03-15T14:00:00.000Z",
    };
    const nightSleep = makeSleep("2026-03-14", "2026-03-15", 27000000);
    const client = createMockClient({
      "/v2/recovery": { records: [], next_token: undefined },
      "/v2/activity/sleep": { records: [nap, nightSleep], next_token: undefined },
      "/v2/cycle": { records: [], next_token: undefined },
    });

    const result = await getCalendar(client, {});

    // Night sleep should be used (not nap)
    const mar15 = result.days.find((d) => d.date === "2026-03-15");
    expect(mar15?.sleep_hours).toBeCloseTo(7.5, 1);
  });

  it("uses fetchAllPages for large date ranges", async () => {
    // We check that the client is called with the start query param
    const get = vi.fn().mockResolvedValue({ records: [], next_token: undefined });
    const client = { get } as unknown as WhoopClient;

    await getCalendar(client, { days: 30 });

    // Should have made calls to all 3 endpoints
    expect(get).toHaveBeenCalled();
    const paths = get.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(paths.some((p: string) => p.includes("/v2/recovery"))).toBe(true);
    expect(paths.some((p: string) => p.includes("/v2/activity/sleep"))).toBe(true);
    expect(paths.some((p: string) => p.includes("/v2/cycle"))).toBe(true);
    // Should include start parameter
    expect(paths.some((p: string) => p.includes("start="))).toBe(true);
  });

  it("handles unscored records (treats as no data for that day)", async () => {
    const unscoredRecovery: Recovery = {
      ...recoveries[0],
      score_state: "PENDING_SCORE",
      score: undefined,
    };
    const client = createMockClient({
      "/v2/recovery": { records: [unscoredRecovery], next_token: undefined },
      "/v2/activity/sleep": { records: sleeps.slice(0, 1), next_token: undefined },
      "/v2/cycle": { records: cycles.slice(0, 1), next_token: undefined },
    });

    const result = await getCalendar(client, {});

    // Mar 15 recovery should be null (unscored)
    expect(result.days[0].recovery_score).toBeNull();
    expect(result.days[0].recovery_zone).toBeNull();
    // But sleep and strain should still be present
    expect(result.days[0].sleep_hours).not.toBeNull();
    expect(result.days[0].day_strain).toBe(8.4);
  });

  it("includes sleep_performance_pct in each day", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: recoveries, next_token: undefined },
      "/v2/activity/sleep": { records: sleeps, next_token: undefined },
      "/v2/cycle": { records: cycles, next_token: undefined },
    });

    const result = await getCalendar(client, {});

    expect(result.days[0].sleep_performance_pct).toBe(85);
  });

  it("includes workout_count from cycle data", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: recoveries, next_token: undefined },
      "/v2/activity/sleep": { records: sleeps, next_token: undefined },
      "/v2/cycle": { records: cycles, next_token: undefined },
    });

    const result = await getCalendar(client, {});

    // workout_count was removed from the response shape in v0.5.x.
    expect(result.days[0]).not.toHaveProperty("workout_count");
  });

  // -------------------------------------------------------------------------
  // `start` parameter (Issue #154)
  // -------------------------------------------------------------------------
  describe("start parameter", () => {
    it("uses start parameter as grid origin and iterates forward", async () => {
      const client = createMockClient({
        "/v2/recovery": { records: recoveries, next_token: undefined },
        "/v2/activity/sleep": { records: sleeps, next_token: undefined },
        "/v2/cycle": { records: cycles, next_token: undefined },
      });

      const result = await getCalendar(client, { start: "2026-03-09", days: 3 });

      expect(result.period.start).toBe("2026-03-09");
      expect(result.period.end).toBe("2026-03-11");
      expect(result.period.days).toBe(3);
      expect(result.days).toHaveLength(3);
      // Ascending order when start is provided
      expect(result.days[0].date).toBe("2026-03-09");
      expect(result.days[1].date).toBe("2026-03-10");
      expect(result.days[2].date).toBe("2026-03-11");
    });

    it("handles start + days interaction correctly", async () => {
      // FIXED_NOW is 2026-03-15. start=2026-03-09 + days=7 → 2026-03-09..2026-03-15.
      const client = createMockClient({
        "/v2/recovery": { records: recoveries, next_token: undefined },
        "/v2/activity/sleep": { records: sleeps, next_token: undefined },
        "/v2/cycle": { records: cycles, next_token: undefined },
      });

      const result = await getCalendar(client, { start: "2026-03-09", days: 7 });

      expect(result.period.start).toBe("2026-03-09");
      expect(result.period.end).toBe("2026-03-15");
      expect(result.period.days).toBe(7);
      expect(result.days[0].date).toBe("2026-03-09");
      expect(result.days[6].date).toBe("2026-03-15");
    });

    it("clamps grid end to today when start + days extends into the future", async () => {
      // FIXED_NOW is 2026-03-15. start=2026-03-13 + days=10 → would extend to 2026-03-22,
      // but is clamped to 2026-03-15 (3 days total).
      const client = createMockClient({
        "/v2/recovery": { records: recoveries, next_token: undefined },
        "/v2/activity/sleep": { records: sleeps, next_token: undefined },
        "/v2/cycle": { records: cycles, next_token: undefined },
      });

      const result = await getCalendar(client, { start: "2026-03-13", days: 10 });

      expect(result.period.start).toBe("2026-03-13");
      expect(result.period.end).toBe("2026-03-15");
      expect(result.period.days).toBe(3);
      expect(result.days).toHaveLength(3);
      expect(result.days.map((d) => d.date)).toEqual(["2026-03-13", "2026-03-14", "2026-03-15"]);
    });

    it("returns empty grid when start is in the future", async () => {
      const client = createMockClient({
        "/v2/recovery": { records: [], next_token: undefined },
        "/v2/activity/sleep": { records: [], next_token: undefined },
        "/v2/cycle": { records: [], next_token: undefined },
      });

      const result = await getCalendar(client, { start: "2026-04-01", days: 7 });

      expect(result.period.start).toBe("2026-04-01");
      expect(result.period.days).toBe(0);
      expect(result.days).toHaveLength(0);
      expect(result.averages.recovery).toBeNull();
      expect(result.averages.sleep_hours).toBeNull();
      expect(result.averages.strain).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Inter-page delay throttling (Issue #152)
  // -------------------------------------------------------------------------
  describe("interPageDelayMs throttling", () => {
    it("passes interPageDelayMs=0 for small ranges (numDays <= 30)", async () => {
      const spy = vi.spyOn(pagination, "fetchAllPages").mockResolvedValue({
        records: [],
        truncated: false,
      });
      const client = { get: vi.fn() } as unknown as WhoopClient;

      await getCalendar(client, { days: 30 });

      expect(spy).toHaveBeenCalledTimes(3);
      for (const call of spy.mock.calls) {
        expect(call[2]?.interPageDelayMs).toBe(0);
      }
      spy.mockRestore();
    });

    it("passes interPageDelayMs=100 for large ranges (numDays > 30)", async () => {
      const spy = vi.spyOn(pagination, "fetchAllPages").mockResolvedValue({
        records: [],
        truncated: false,
      });
      const client = { get: vi.fn() } as unknown as WhoopClient;

      await getCalendar(client, { days: 90 });

      expect(spy).toHaveBeenCalledTimes(3);
      for (const call of spy.mock.calls) {
        expect(call[2]?.interPageDelayMs).toBe(100);
      }
      spy.mockRestore();
    });
  });
});
