/**
 * Tests for get_weekly_summary tool.
 *
 * Verifies that the weekly summary:
 * - Fetches recovery, sleep, workout, cycle for a 7-day period
 * - Computes correct averages/aggregates
 * - Determines recovery trend via linear regression
 * - Handles partial failures gracefully (some endpoints down)
 * - Returns error only if ALL 4 endpoints fail
 * - Filters unscored records
 * - Defaults to current week
 * - Accepts enhanced date expressions
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WhoopClient } from "../../src/api/client.js";
import { getWeeklySummary } from "../../src/tools/get-weekly-summary.js";
import type { Recovery, Sleep, Workout, Cycle, PaginatedResponse } from "../../src/api/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(): { client: WhoopClient; getMock: ReturnType<typeof vi.fn> } {
  const getMock = vi.fn();
  const client = { get: getMock } as unknown as WhoopClient;
  return { client, getMock };
}

function makeRecovery(
  overrides: Partial<Recovery> & { score?: Partial<Recovery["score"]> } = {}
): Recovery {
  return {
    cycle_id: 1,
    sleep_id: "s1",
    user_id: 100,
    created_at: "2026-05-26T06:00:00.000Z",
    updated_at: "2026-05-26T06:00:00.000Z",
    score_state: "SCORED",
    score: {
      user_calibrating: false,
      recovery_score: 75,
      resting_heart_rate: 55,
      hrv_rmssd_milli: 60,
      spo2_percentage: 98,
      skin_temp_celsius: 33.5,
      ...overrides.score,
    },
    ...overrides,
    // Re-apply score to override the spread
  } as Recovery;
}

function makeSleep(overrides: Partial<Sleep> = {}): Sleep {
  return {
    id: "sleep-1",
    cycle_id: 1,
    user_id: 100,
    created_at: "2026-05-26T06:00:00.000Z",
    updated_at: "2026-05-26T06:00:00.000Z",
    start: "2026-05-25T22:00:00.000Z",
    end: "2026-05-26T06:00:00.000Z",
    timezone_offset: "-05:00",
    nap: false,
    score_state: "SCORED",
    score: {
      stage_summary: {
        total_in_bed_time_milli: 28800000,
        total_awake_time_milli: 3600000,
        total_no_data_time_milli: 0,
        total_light_sleep_time_milli: 10800000,
        total_slow_wave_sleep_time_milli: 7200000,
        total_rem_sleep_time_milli: 7200000,
        sleep_cycle_count: 4,
        disturbance_count: 2,
      },
      sleep_needed: {
        baseline_milli: 28800000,
        need_from_sleep_debt_milli: 0,
        need_from_recent_strain_milli: 0,
        need_from_recent_nap_milli: 0,
      },
      respiratory_rate: 15,
      sleep_performance_percentage: 85,
      sleep_consistency_percentage: 90,
      sleep_efficiency_percentage: 88,
    },
    ...overrides,
  };
}

function makeWorkout(overrides: Partial<Workout> = {}): Workout {
  return {
    id: "workout-1",
    user_id: 100,
    created_at: "2026-05-26T10:00:00.000Z",
    updated_at: "2026-05-26T10:00:00.000Z",
    start: "2026-05-26T10:00:00.000Z",
    end: "2026-05-26T11:00:00.000Z",
    timezone_offset: "-05:00",
    sport_name: "Running",
    score_state: "SCORED",
    score: {
      strain: 12.5,
      average_heart_rate: 145,
      max_heart_rate: 175,
      kilojoule: 1200,
      percent_recorded: 100,
      zone_durations: {
        zone_zero_milli: 0,
        zone_one_milli: 600000,
        zone_two_milli: 1200000,
        zone_three_milli: 1200000,
        zone_four_milli: 600000,
        zone_five_milli: 0,
      },
    },
    ...overrides,
  };
}

function makeCycle(overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: 1,
    user_id: 100,
    created_at: "2026-05-26T00:00:00.000Z",
    updated_at: "2026-05-26T23:59:59.000Z",
    start: "2026-05-26T00:00:00.000Z",
    end: "2026-05-26T23:59:59.000Z",
    timezone_offset: "-05:00",
    score_state: "SCORED",
    score: {
      strain: 14.2,
      kilojoule: 8500,
      average_heart_rate: 72,
      max_heart_rate: 175,
    },
    ...overrides,
  };
}

/** Create a paginated response wrapper */
function paginated<T>(records: T[]): PaginatedResponse<T> {
  return { records };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getWeeklySummary", () => {
  let client: WhoopClient;
  let getMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Set current date to Thursday 2026-05-28 12:00:00 UTC
    vi.setSystemTime(new Date("2026-05-28T12:00:00.000Z"));
    const mock = createMockClient();
    client = mock.client;
    getMock = mock.getMock;
  });

  it("defaults to current week (Monday to now) when no week_start provided", async () => {
    getMock.mockResolvedValue(paginated([]));

    await getWeeklySummary(client, {});

    // Should fetch with start = Monday 2026-05-25T00:00:00.000Z
    const firstCall = getMock.mock.calls[0]?.[0] as string;
    expect(firstCall).toContain("start=2026-05-25T00%3A00%3A00.000Z");
  });

  it("computes correct recovery averages from scored records", async () => {
    const recoveries = [
      makeRecovery({
        score: {
          user_calibrating: false,
          recovery_score: 70,
          resting_heart_rate: 52,
          hrv_rmssd_milli: 55,
          spo2_percentage: 98,
          skin_temp_celsius: 33,
        },
      }),
      makeRecovery({
        score: {
          user_calibrating: false,
          recovery_score: 80,
          resting_heart_rate: 58,
          hrv_rmssd_milli: 65,
          spo2_percentage: 97,
          skin_temp_celsius: 34,
        },
      }),
      makeRecovery({
        score: {
          user_calibrating: false,
          recovery_score: 60,
          resting_heart_rate: 54,
          hrv_rmssd_milli: 50,
          spo2_percentage: 99,
          skin_temp_celsius: 33.5,
        },
      }),
    ];

    getMock
      .mockResolvedValueOnce(paginated(recoveries)) // recovery
      .mockResolvedValueOnce(paginated([])) // sleep
      .mockResolvedValueOnce(paginated([])) // workout
      .mockResolvedValueOnce(paginated([])); // cycle

    const result = await getWeeklySummary(client, {});

    expect(result.recovery.average_score).toBeCloseTo(70, 1);
    expect(result.recovery.min_score).toBe(60);
    expect(result.recovery.max_score).toBe(80);
    expect(result.recovery.average_hrv).toBeCloseTo(56.67, 1);
    expect(result.recovery.average_rhr).toBeCloseTo(54.67, 1);
  });

  it("computes correct sleep averages", async () => {
    // 8 hours sleep, 85% performance, 88% efficiency
    const sleeps = [
      makeSleep({ start: "2026-05-25T22:00:00.000Z", end: "2026-05-26T06:00:00.000Z" }),
      makeSleep({
        start: "2026-05-26T23:00:00.000Z",
        end: "2026-05-27T06:30:00.000Z",
        score: {
          stage_summary: {
            total_in_bed_time_milli: 27000000,
            total_awake_time_milli: 3000000,
            total_no_data_time_milli: 0,
            total_light_sleep_time_milli: 10000000,
            total_slow_wave_sleep_time_milli: 7000000,
            total_rem_sleep_time_milli: 7000000,
            sleep_cycle_count: 3,
            disturbance_count: 1,
          },
          sleep_needed: {
            baseline_milli: 28800000,
            need_from_sleep_debt_milli: 1800000,
            need_from_recent_strain_milli: 0,
            need_from_recent_nap_milli: 0,
          },
          respiratory_rate: 14,
          sleep_performance_percentage: 75,
          sleep_consistency_percentage: 85,
          sleep_efficiency_percentage: 80,
        },
      }),
    ];

    getMock
      .mockResolvedValueOnce(paginated([])) // recovery
      .mockResolvedValueOnce(paginated(sleeps)) // sleep
      .mockResolvedValueOnce(paginated([])) // workout
      .mockResolvedValueOnce(paginated([])); // cycle

    const result = await getWeeklySummary(client, {});

    // Sleep 1: 8h = 28800000ms, Sleep 2: 7.5h = 27000000ms → avg 7.75h
    expect(result.sleep.average_duration_hours).toBeCloseTo(7.75, 1);
    expect(result.sleep.average_performance_pct).toBeCloseTo(80, 1);
    expect(result.sleep.average_efficiency_pct).toBeCloseTo(84, 1);
  });

  it("computes correct workout stats with sport breakdown", async () => {
    const workouts = [
      makeWorkout({
        sport_name: "Running",
        score: {
          strain: 12.5,
          average_heart_rate: 145,
          max_heart_rate: 175,
          kilojoule: 1200,
          percent_recorded: 100,
          zone_durations: {
            zone_zero_milli: 0,
            zone_one_milli: 0,
            zone_two_milli: 0,
            zone_three_milli: 0,
            zone_four_milli: 0,
            zone_five_milli: 0,
          },
        },
      }),
      makeWorkout({
        id: "workout-2",
        sport_name: "Running",
        score: {
          strain: 10.0,
          average_heart_rate: 140,
          max_heart_rate: 170,
          kilojoule: 1000,
          percent_recorded: 100,
          zone_durations: {
            zone_zero_milli: 0,
            zone_one_milli: 0,
            zone_two_milli: 0,
            zone_three_milli: 0,
            zone_four_milli: 0,
            zone_five_milli: 0,
          },
        },
      }),
      makeWorkout({
        id: "workout-3",
        sport_name: "Cycling",
        score: {
          strain: 8.0,
          average_heart_rate: 135,
          max_heart_rate: 160,
          kilojoule: 900,
          percent_recorded: 100,
          zone_durations: {
            zone_zero_milli: 0,
            zone_one_milli: 0,
            zone_two_milli: 0,
            zone_three_milli: 0,
            zone_four_milli: 0,
            zone_five_milli: 0,
          },
        },
      }),
    ];

    getMock
      .mockResolvedValueOnce(paginated([])) // recovery
      .mockResolvedValueOnce(paginated([])) // sleep
      .mockResolvedValueOnce(paginated(workouts)) // workout
      .mockResolvedValueOnce(paginated([])); // cycle

    const result = await getWeeklySummary(client, {});

    expect(result.workouts.count).toBe(3);
    expect(result.workouts.total_strain).toBeCloseTo(30.5, 1);
    expect(result.workouts.total_calories_kj).toBe(3100);
    expect(result.workouts.sport_breakdown).toEqual({ Running: 2, Cycling: 1 });
  });

  it("computes correct strain averages from cycle data", async () => {
    const cycles = [
      makeCycle({
        score: { strain: 14.2, kilojoule: 8500, average_heart_rate: 72, max_heart_rate: 175 },
      }),
      makeCycle({
        id: 2,
        score: { strain: 10.0, kilojoule: 7000, average_heart_rate: 68, max_heart_rate: 165 },
      }),
    ];

    getMock
      .mockResolvedValueOnce(paginated([])) // recovery
      .mockResolvedValueOnce(paginated([])) // sleep
      .mockResolvedValueOnce(paginated([])) // workout
      .mockResolvedValueOnce(paginated(cycles)); // cycle

    const result = await getWeeklySummary(client, {});

    expect(result.strain.average_daily_strain).toBeCloseTo(12.1, 1);
    expect(result.strain.max_daily_strain).toBe(14.2);
  });

  it("determines recovery trend using linear regression", async () => {
    // Improving: 50, 55, 60, 65, 70, 75, 80
    const recoveries = [50, 55, 60, 65, 70, 75, 80].map((score) =>
      makeRecovery({
        score: {
          user_calibrating: false,
          recovery_score: score,
          resting_heart_rate: 55,
          hrv_rmssd_milli: 60,
          spo2_percentage: 98,
          skin_temp_celsius: 33,
        },
      })
    );

    getMock
      .mockResolvedValueOnce(paginated(recoveries))
      .mockResolvedValueOnce(paginated([]))
      .mockResolvedValueOnce(paginated([]))
      .mockResolvedValueOnce(paginated([]));

    const result = await getWeeklySummary(client, {});

    expect(result.recovery.trend).toBe("improving");
  });

  it("filters out unscored records (PENDING_SCORE, UNSCORABLE)", async () => {
    const recoveries = [
      makeRecovery({
        score: {
          user_calibrating: false,
          recovery_score: 70,
          resting_heart_rate: 52,
          hrv_rmssd_milli: 55,
          spo2_percentage: 98,
          skin_temp_celsius: 33,
        },
      }),
      makeRecovery({ score_state: "PENDING_SCORE", score: undefined }),
      makeRecovery({ score_state: "UNSCORABLE", score: undefined }),
    ];

    getMock
      .mockResolvedValueOnce(paginated(recoveries))
      .mockResolvedValueOnce(paginated([]))
      .mockResolvedValueOnce(paginated([]))
      .mockResolvedValueOnce(paginated([]));

    const result = await getWeeklySummary(client, {});

    // Only 1 scored recovery
    expect(result.recovery.average_score).toBe(70);
    expect(result.recovery.min_score).toBe(70);
    expect(result.recovery.max_score).toBe(70);
  });

  it("returns partial results with warnings when some endpoints fail", async () => {
    getMock
      .mockResolvedValueOnce(paginated([makeRecovery()])) // recovery OK
      .mockRejectedValueOnce(new Error("Sleep endpoint unavailable")) // sleep fails
      .mockResolvedValueOnce(paginated([])) // workout OK
      .mockResolvedValueOnce(paginated([])); // cycle OK

    const result = await getWeeklySummary(client, {});

    expect(result.recovery.average_score).toBe(75);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings![0]).toContain("sleep");
  });

  it("throws error when ALL 4 endpoints fail", async () => {
    getMock
      .mockRejectedValueOnce(new Error("Recovery down"))
      .mockRejectedValueOnce(new Error("Sleep down"))
      .mockRejectedValueOnce(new Error("Workout down"))
      .mockRejectedValueOnce(new Error("Cycle down"));

    await expect(getWeeklySummary(client, {})).rejects.toThrow("All endpoints failed");
  });

  it("accepts enhanced date expression for week_start", async () => {
    getMock.mockResolvedValue(paginated([]));

    await getWeeklySummary(client, { week_start: "last week" });

    // "last week" on Thursday 2026-05-28 → Monday 2026-05-18 to Sunday 2026-05-24
    const firstCall = getMock.mock.calls[0]?.[0] as string;
    expect(firstCall).toContain("start=2026-05-18T00%3A00%3A00.000Z");
  });

  it("returns zero values when no scored data available", async () => {
    getMock.mockResolvedValue(paginated([]));

    const result = await getWeeklySummary(client, {});

    expect(result.recovery.average_score).toBe(0);
    expect(result.recovery.min_score).toBe(0);
    expect(result.recovery.max_score).toBe(0);
    expect(result.recovery.trend).toBe("stable");
    expect(result.sleep.average_duration_hours).toBe(0);
    expect(result.workouts.count).toBe(0);
    expect(result.strain.average_daily_strain).toBe(0);
  });

  it("uses fetchAllPages with serialized calls (4 sequential calls)", async () => {
    getMock.mockResolvedValue(paginated([]));

    await getWeeklySummary(client, {});

    // Should make exactly 4 API calls (one per endpoint)
    expect(getMock).toHaveBeenCalledTimes(4);
  });

  it("includes week_start and week_end in the output", async () => {
    getMock.mockResolvedValue(paginated([]));

    const result = await getWeeklySummary(client, {});

    // Current week: Monday 2026-05-25 to Sunday 2026-05-31
    expect(result.week_start).toBe("2026-05-25T00:00:00.000Z");
    expect(result.week_end).toContain("2026-05-31");
  });

  it("correctly handles week_start as ISO 8601 string", async () => {
    getMock.mockResolvedValue(paginated([]));

    await getWeeklySummary(client, { week_start: "2026-05-12T00:00:00.000Z" });

    const firstCall = getMock.mock.calls[0]?.[0] as string;
    expect(firstCall).toContain("start=2026-05-12T00%3A00%3A00.000Z");
  });

  it("excludes naps from sleep duration calculation", async () => {
    const sleeps = [
      makeSleep({ nap: false, start: "2026-05-25T22:00:00.000Z", end: "2026-05-26T06:00:00.000Z" }),
      makeSleep({
        id: "nap-1",
        nap: true,
        start: "2026-05-26T14:00:00.000Z",
        end: "2026-05-26T14:30:00.000Z",
      }),
    ];

    getMock
      .mockResolvedValueOnce(paginated([])) // recovery
      .mockResolvedValueOnce(paginated(sleeps)) // sleep
      .mockResolvedValueOnce(paginated([])) // workout
      .mockResolvedValueOnce(paginated([])); // cycle

    const result = await getWeeklySummary(client, {});

    // Only 1 non-nap sleep: 8 hours
    expect(result.sleep.average_duration_hours).toBeCloseTo(8, 1);
  });
});
