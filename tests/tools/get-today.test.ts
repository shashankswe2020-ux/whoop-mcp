/**
 * Tests for get-today.ts — get_today composite tool.
 *
 * Covers: all succeed, one fails (partial), all fail, summary generation,
 * no workout case, null recovery/sleep.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WhoopClient } from "../../src/api/client.js";
import { getToday } from "../../src/tools/get-today.js";
import type { Recovery, Sleep, Cycle, Workout } from "../../src/api/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-03-15T12:00:00.000Z");

const mockRecovery: Recovery = {
  cycle_id: 1001,
  sleep_id: "sleep-1",
  user_id: 42,
  created_at: "2026-03-15T06:00:00.000Z",
  updated_at: "2026-03-15T06:00:00.000Z",
  score_state: "SCORED",
  score: {
    user_calibrating: false,
    recovery_score: 72,
    resting_heart_rate: 55,
    hrv_rmssd_milli: 45.2,
    spo2_percentage: 97,
    skin_temp_celsius: 33.5,
  },
};

const mockSleep: Sleep = {
  id: "sleep-1",
  cycle_id: 1001,
  user_id: 42,
  created_at: "2026-03-15T06:00:00.000Z",
  updated_at: "2026-03-15T06:00:00.000Z",
  start: "2026-03-14T22:30:00.000Z",
  end: "2026-03-15T06:00:00.000Z",
  timezone_offset: "-05:00",
  nap: false,
  score_state: "SCORED",
  score: {
    stage_summary: {
      total_in_bed_time_milli: 27000000, // 7.5h
      total_awake_time_milli: 1800000, // 0.5h
      total_no_data_time_milli: 0,
      total_light_sleep_time_milli: 10800000, // 3h
      total_slow_wave_sleep_time_milli: 5400000, // 1.5h
      total_rem_sleep_time_milli: 7200000, // 2h
      sleep_cycle_count: 4,
      disturbance_count: 2,
    },
    sleep_needed: {
      baseline_milli: 28800000,
      need_from_sleep_debt_milli: 0,
      need_from_recent_strain_milli: 0,
      need_from_recent_nap_milli: 0,
    },
    respiratory_rate: 15.2,
    sleep_performance_percentage: 85,
    sleep_efficiency_percentage: 92,
  },
};

const mockCycle: Cycle = {
  id: 1001,
  user_id: 42,
  created_at: "2026-03-15T06:00:00.000Z",
  updated_at: "2026-03-15T12:00:00.000Z",
  start: "2026-03-15T06:00:00.000Z",
  timezone_offset: "-05:00",
  score_state: "SCORED",
  score: {
    strain: 8.4,
    kilojoule: 1200,
    average_heart_rate: 68,
    max_heart_rate: 155,
  },
};

const mockWorkout: Workout = {
  id: "workout-1",
  user_id: 42,
  created_at: "2026-03-15T08:00:00.000Z",
  updated_at: "2026-03-15T09:00:00.000Z",
  start: "2026-03-15T08:00:00.000Z",
  end: "2026-03-15T09:00:00.000Z",
  timezone_offset: "-05:00",
  sport_name: "Running",
  score_state: "SCORED",
  score: {
    strain: 12.5,
    average_heart_rate: 145,
    max_heart_rate: 172,
    kilojoule: 800,
    percent_recorded: 100,
    zone_durations: {
      zone_zero_milli: 0,
      zone_one_milli: 60000,
      zone_two_milli: 120000,
      zone_three_milli: 1800000,
      zone_four_milli: 600000,
      zone_five_milli: 0,
    },
  },
};

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

describe("getToday", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a complete snapshot when all endpoints succeed", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: [mockRecovery], next_token: undefined },
      "/v2/activity/sleep": { records: [mockSleep], next_token: undefined },
      "/v2/cycle": { records: [mockCycle], next_token: undefined },
      "/v2/activity/workout": { records: [mockWorkout], next_token: undefined },
    });

    const result = await getToday(client);

    expect(result.timestamp).toBe("2026-03-15T12:00:00.000Z");
    expect(result.recovery).not.toBeNull();
    expect(result.recovery!.score).toBe(72);
    expect(result.recovery!.hrv_rmssd_milli).toBe(45.2);
    expect(result.recovery!.resting_heart_rate).toBe(55);
    expect(result.recovery!.spo2_pct).toBe(97);
    expect(result.recovery!.skin_temp_celsius).toBe(33.5);

    expect(result.sleep).not.toBeNull();
    expect(result.sleep!.total_hours).toBeCloseTo(7.5, 1);
    expect(result.sleep!.rem_hours).toBeCloseTo(2.0, 1);
    expect(result.sleep!.deep_hours).toBeCloseTo(1.5, 1);
    expect(result.sleep!.light_hours).toBeCloseTo(3.0, 1);
    expect(result.sleep!.awake_hours).toBeCloseTo(0.5, 1);
    expect(result.sleep!.performance_pct).toBe(85);
    expect(result.sleep!.efficiency_pct).toBe(92);
    expect(result.sleep!.respiratory_rate).toBe(15.2);

    expect(result.strain).not.toBeNull();
    expect(result.strain!.day_strain).toBe(8.4);
    expect(result.strain!.energy_burned_kj).toBe(1200);
    expect(result.strain!.last_workout).not.toBeNull();
    expect(result.strain!.last_workout!.sport_name).toBe("Running");
    expect(result.strain!.last_workout!.strain).toBe(12.5);
  });

  it("includes a human-readable summary", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: [mockRecovery], next_token: undefined },
      "/v2/activity/sleep": { records: [mockSleep], next_token: undefined },
      "/v2/cycle": { records: [mockCycle], next_token: undefined },
      "/v2/activity/workout": { records: [mockWorkout], next_token: undefined },
    });

    const result = await getToday(client);

    expect(result.summary).toContain("72%");
    expect(result.summary).toContain("7.5h sleep");
    expect(result.summary).toContain("8.4");
  });

  it("returns null recovery when recovery endpoint fails", async () => {
    const client = createMockClient({
      "/v2/recovery": new Error("API timeout"),
      "/v2/activity/sleep": { records: [mockSleep], next_token: undefined },
      "/v2/cycle": { records: [mockCycle], next_token: undefined },
      "/v2/activity/workout": { records: [mockWorkout], next_token: undefined },
    });

    const result = await getToday(client);

    expect(result.recovery).toBeNull();
    expect(result.sleep).not.toBeNull();
    expect(result.strain).not.toBeNull();
  });

  it("returns null sleep when sleep endpoint fails", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: [mockRecovery], next_token: undefined },
      "/v2/activity/sleep": new Error("API timeout"),
      "/v2/cycle": { records: [mockCycle], next_token: undefined },
      "/v2/activity/workout": { records: [mockWorkout], next_token: undefined },
    });

    const result = await getToday(client);

    expect(result.recovery).not.toBeNull();
    expect(result.sleep).toBeNull();
    expect(result.strain).not.toBeNull();
  });

  it("returns null strain when cycle endpoint fails", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: [mockRecovery], next_token: undefined },
      "/v2/activity/sleep": { records: [mockSleep], next_token: undefined },
      "/v2/cycle": new Error("API timeout"),
      "/v2/activity/workout": { records: [mockWorkout], next_token: undefined },
    });

    const result = await getToday(client);

    expect(result.recovery).not.toBeNull();
    expect(result.sleep).not.toBeNull();
    expect(result.strain).toBeNull();
  });

  it("throws when ALL endpoints fail", async () => {
    const client = createMockClient({
      "/v2/recovery": new Error("fail 1"),
      "/v2/activity/sleep": new Error("fail 2"),
      "/v2/cycle": new Error("fail 3"),
      "/v2/activity/workout": new Error("fail 4"),
    });

    await expect(getToday(client)).rejects.toThrow(/all.*failed/i);
  });

  it("throws when all 3 primary endpoints fail (even if workout succeeds)", async () => {
    const client = createMockClient({
      "/v2/recovery": new Error("fail 1"),
      "/v2/activity/sleep": new Error("fail 2"),
      "/v2/cycle": new Error("fail 3"),
      "/v2/activity/workout": { records: [mockWorkout], next_token: undefined },
    });

    await expect(getToday(client)).rejects.toThrow(/all.*failed/i);
  });

  it("returns null recovery when no recovery records exist", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: [], next_token: undefined },
      "/v2/activity/sleep": { records: [mockSleep], next_token: undefined },
      "/v2/cycle": { records: [mockCycle], next_token: undefined },
      "/v2/activity/workout": { records: [mockWorkout], next_token: undefined },
    });

    const result = await getToday(client);

    expect(result.recovery).toBeNull();
    expect(result.sleep).not.toBeNull();
    expect(result.strain).not.toBeNull();
  });

  it("returns null sleep when no sleep records exist", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: [mockRecovery], next_token: undefined },
      "/v2/activity/sleep": { records: [], next_token: undefined },
      "/v2/cycle": { records: [mockCycle], next_token: undefined },
      "/v2/activity/workout": { records: [mockWorkout], next_token: undefined },
    });

    const result = await getToday(client);

    expect(result.sleep).toBeNull();
  });

  it("returns null last_workout when no workouts exist", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: [mockRecovery], next_token: undefined },
      "/v2/activity/sleep": { records: [mockSleep], next_token: undefined },
      "/v2/cycle": { records: [mockCycle], next_token: undefined },
      "/v2/activity/workout": { records: [], next_token: undefined },
    });

    const result = await getToday(client);

    expect(result.strain).not.toBeNull();
    expect(result.strain!.last_workout).toBeNull();
  });

  it("returns null last_workout when workout endpoint fails (but cycle succeeds)", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: [mockRecovery], next_token: undefined },
      "/v2/activity/sleep": { records: [mockSleep], next_token: undefined },
      "/v2/cycle": { records: [mockCycle], next_token: undefined },
      "/v2/activity/workout": new Error("workout API failed"),
    });

    const result = await getToday(client);

    expect(result.strain).not.toBeNull();
    expect(result.strain!.last_workout).toBeNull();
  });

  it("handles unscored recovery (no score field)", async () => {
    const unscoredRecovery: Recovery = {
      ...mockRecovery,
      score_state: "PENDING_SCORE",
      score: undefined,
    };
    const client = createMockClient({
      "/v2/recovery": { records: [unscoredRecovery], next_token: undefined },
      "/v2/activity/sleep": { records: [mockSleep], next_token: undefined },
      "/v2/cycle": { records: [mockCycle], next_token: undefined },
      "/v2/activity/workout": { records: [mockWorkout], next_token: undefined },
    });

    const result = await getToday(client);

    expect(result.recovery).toBeNull();
  });

  it("handles unscored sleep (no score field)", async () => {
    const unscoredSleep: Sleep = {
      ...mockSleep,
      score_state: "PENDING_SCORE",
      score: undefined,
    };
    const client = createMockClient({
      "/v2/recovery": { records: [mockRecovery], next_token: undefined },
      "/v2/activity/sleep": { records: [unscoredSleep], next_token: undefined },
      "/v2/cycle": { records: [mockCycle], next_token: undefined },
      "/v2/activity/workout": { records: [mockWorkout], next_token: undefined },
    });

    const result = await getToday(client);

    expect(result.sleep).toBeNull();
  });

  it("handles unscored cycle (no score field)", async () => {
    const unscoredCycle: Cycle = {
      ...mockCycle,
      score_state: "PENDING_SCORE",
      score: undefined,
    };
    const client = createMockClient({
      "/v2/recovery": { records: [mockRecovery], next_token: undefined },
      "/v2/activity/sleep": { records: [mockSleep], next_token: undefined },
      "/v2/cycle": { records: [unscoredCycle], next_token: undefined },
      "/v2/activity/workout": { records: [mockWorkout], next_token: undefined },
    });

    const result = await getToday(client);

    expect(result.strain).toBeNull();
  });

  it("generates summary with partial data (recovery only)", async () => {
    const client = createMockClient({
      "/v2/recovery": { records: [mockRecovery], next_token: undefined },
      "/v2/activity/sleep": new Error("fail"),
      "/v2/cycle": new Error("fail"),
      "/v2/activity/workout": new Error("fail"),
    });

    const result = await getToday(client);

    expect(result.summary).toContain("72%");
    expect(result.summary).not.toContain("sleep");
    expect(result.summary).not.toContain("strain");
  });

  it("generates summary with sleep missing spo2 and skin_temp", async () => {
    const recoveryNoExtras: Recovery = {
      ...mockRecovery,
      score: {
        ...mockRecovery.score!,
        spo2_percentage: undefined,
        skin_temp_celsius: undefined,
      },
    };
    const client = createMockClient({
      "/v2/recovery": { records: [recoveryNoExtras], next_token: undefined },
      "/v2/activity/sleep": { records: [mockSleep], next_token: undefined },
      "/v2/cycle": { records: [mockCycle], next_token: undefined },
      "/v2/activity/workout": { records: [mockWorkout], next_token: undefined },
    });

    const result = await getToday(client);

    expect(result.recovery!.spo2_pct).toBeNull();
    expect(result.recovery!.skin_temp_celsius).toBeNull();
  });

  it("makes all API calls in parallel", async () => {
    const callOrder: string[] = [];
    const get = vi.fn().mockImplementation((path: string) => {
      callOrder.push(path);
      if (path.includes("/v2/recovery")) {
        return Promise.resolve({ records: [mockRecovery] });
      }
      if (path.includes("/v2/activity/sleep")) {
        return Promise.resolve({ records: [mockSleep] });
      }
      if (path.includes("/v2/cycle")) {
        return Promise.resolve({ records: [mockCycle] });
      }
      if (path.includes("/v2/activity/workout")) {
        return Promise.resolve({ records: [mockWorkout] });
      }
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });
    const client = { get } as unknown as WhoopClient;

    await getToday(client);

    // All 4 calls should have been made
    expect(get).toHaveBeenCalledTimes(4);
    // Verify the paths called
    expect(callOrder.some((p) => p.includes("/v2/recovery"))).toBe(true);
    expect(callOrder.some((p) => p.includes("/v2/activity/sleep"))).toBe(true);
    expect(callOrder.some((p) => p.includes("/v2/cycle"))).toBe(true);
    expect(callOrder.some((p) => p.includes("/v2/activity/workout"))).toBe(true);
  });
});
