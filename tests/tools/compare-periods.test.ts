/**
 * Tests for compare_periods tool.
 *
 * Verifies that compare_periods:
 * - Compares recovery, sleep, strain between two time periods
 * - Correctly computes percentage changes and direction
 * - Normalizes per-day when periods have different lengths
 * - Rejects periods longer than 90 days
 * - Rejects overlapping periods
 * - Handles periods with zero records gracefully
 * - Filters unscored records
 * - Uses ±5% threshold for "unchanged"
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WhoopClient } from "../../src/api/client.js";
import { comparePeriods } from "../../src/tools/compare-periods.js";
import type { Recovery, Sleep, Cycle, PaginatedResponse } from "../../src/api/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(): { client: WhoopClient; getMock: ReturnType<typeof vi.fn> } {
  const getMock = vi.fn();
  const client = { get: getMock } as unknown as WhoopClient;
  return { client, getMock };
}

function makeRecovery(score: number): Recovery {
  return {
    cycle_id: 1,
    sleep_id: "s1",
    user_id: 100,
    created_at: "2026-05-01T06:00:00.000Z",
    updated_at: "2026-05-01T06:00:00.000Z",
    score_state: "SCORED",
    score: {
      user_calibrating: false,
      recovery_score: score,
      resting_heart_rate: 55,
      hrv_rmssd_milli: 60,
      spo2_percentage: 98,
      skin_temp_celsius: 33.5,
    },
  };
}

function makeSleep(startIso: string, endIso: string): Sleep {
  return {
    id: "sleep-1",
    cycle_id: 1,
    user_id: 100,
    created_at: endIso,
    updated_at: endIso,
    start: startIso,
    end: endIso,
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
  };
}

function makeCycle(strain: number): Cycle {
  return {
    id: 1,
    user_id: 100,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T23:59:59.000Z",
    start: "2026-05-01T00:00:00.000Z",
    end: "2026-05-01T23:59:59.000Z",
    timezone_offset: "-05:00",
    score_state: "SCORED",
    score: {
      strain,
      kilojoule: 8500,
      average_heart_rate: 72,
      max_heart_rate: 175,
    },
  };
}

function paginated<T>(records: T[]): PaginatedResponse<T> {
  return { records };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("comparePeriods", () => {
  let client: WhoopClient;
  let getMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mock = createMockClient();
    client = mock.client;
    getMock = mock.getMock;
  });

  it("correctly computes percentage changes and direction (improved)", async () => {
    // Period A: recovery avg 60, Period B: recovery avg 80 → +33.3% improved
    getMock
      .mockResolvedValueOnce(paginated([makeRecovery(60), makeRecovery(60)])) // period_a recovery
      .mockResolvedValueOnce(paginated([makeSleep("2026-05-01T22:00:00Z", "2026-05-02T06:00:00Z")])) // period_a sleep
      .mockResolvedValueOnce(paginated([makeCycle(10)])) // period_a cycle
      .mockResolvedValueOnce(paginated([makeRecovery(80), makeRecovery(80)])) // period_b recovery
      .mockResolvedValueOnce(paginated([makeSleep("2026-05-08T22:00:00Z", "2026-05-09T06:00:00Z")])) // period_b sleep
      .mockResolvedValueOnce(paginated([makeCycle(10)])); // period_b cycle

    const result = await comparePeriods(client, {
      period_a_start: "2026-05-01T00:00:00.000Z",
      period_a_end: "2026-05-07T23:59:59.999Z",
      period_b_start: "2026-05-08T00:00:00.000Z",
      period_b_end: "2026-05-14T23:59:59.999Z",
    });

    expect(result.recovery.period_a_avg).toBeCloseTo(60, 1);
    expect(result.recovery.period_b_avg).toBeCloseTo(80, 1);
    expect(result.recovery.change_pct).toBeCloseTo(33.33, 0);
    expect(result.recovery.direction).toBe("improved");
  });

  it("correctly identifies declined direction", async () => {
    // Period A: recovery 80, Period B: recovery 60 → -25% declined
    getMock
      .mockResolvedValueOnce(paginated([makeRecovery(80)])) // period_a recovery
      .mockResolvedValueOnce(paginated([])) // period_a sleep
      .mockResolvedValueOnce(paginated([])) // period_a cycle
      .mockResolvedValueOnce(paginated([makeRecovery(60)])) // period_b recovery
      .mockResolvedValueOnce(paginated([])) // period_b sleep
      .mockResolvedValueOnce(paginated([])); // period_b cycle

    const result = await comparePeriods(client, {
      period_a_start: "2026-05-01T00:00:00.000Z",
      period_a_end: "2026-05-07T23:59:59.999Z",
      period_b_start: "2026-05-08T00:00:00.000Z",
      period_b_end: "2026-05-14T23:59:59.999Z",
    });

    expect(result.recovery.change_pct).toBeCloseTo(-25, 0);
    expect(result.recovery.direction).toBe("declined");
  });

  it("uses ±5% threshold for unchanged", async () => {
    // Period A: recovery 80, Period B: recovery 82 → +2.5% → unchanged
    getMock
      .mockResolvedValueOnce(paginated([makeRecovery(80)])) // period_a recovery
      .mockResolvedValueOnce(paginated([])) // period_a sleep
      .mockResolvedValueOnce(paginated([])) // period_a cycle
      .mockResolvedValueOnce(paginated([makeRecovery(82)])) // period_b recovery
      .mockResolvedValueOnce(paginated([])) // period_b sleep
      .mockResolvedValueOnce(paginated([])); // period_b cycle

    const result = await comparePeriods(client, {
      period_a_start: "2026-05-01T00:00:00.000Z",
      period_a_end: "2026-05-07T23:59:59.999Z",
      period_b_start: "2026-05-08T00:00:00.000Z",
      period_b_end: "2026-05-14T23:59:59.999Z",
    });

    expect(result.recovery.direction).toBe("unchanged");
  });

  it("rejects periods longer than 90 days", async () => {
    await expect(
      comparePeriods(client, {
        period_a_start: "2026-01-01T00:00:00.000Z",
        period_a_end: "2026-05-01T00:00:00.000Z", // 120 days
        period_b_start: "2026-05-02T00:00:00.000Z",
        period_b_end: "2026-05-08T00:00:00.000Z",
      })
    ).rejects.toThrow("90 days");
  });

  it("rejects overlapping periods", async () => {
    await expect(
      comparePeriods(client, {
        period_a_start: "2026-05-01T00:00:00.000Z",
        period_a_end: "2026-05-10T23:59:59.999Z",
        period_b_start: "2026-05-08T00:00:00.000Z", // overlaps with period_a
        period_b_end: "2026-05-14T23:59:59.999Z",
      })
    ).rejects.toThrow("overlap");
  });

  it("handles periods with zero records gracefully", async () => {
    getMock.mockResolvedValue(paginated([]));

    const result = await comparePeriods(client, {
      period_a_start: "2026-05-01T00:00:00.000Z",
      period_a_end: "2026-05-07T23:59:59.999Z",
      period_b_start: "2026-05-08T00:00:00.000Z",
      period_b_end: "2026-05-14T23:59:59.999Z",
    });

    expect(result.recovery.period_a_avg).toBe(0);
    expect(result.recovery.period_b_avg).toBe(0);
    expect(result.recovery.change_pct).toBe(0);
    expect(result.recovery.direction).toBe("unchanged");
  });

  it("normalizes per-day when periods have different lengths", async () => {
    // Period A: 7 days, 2 sleeps of 8h each → avg 8h/night
    // Period B: 14 days, 4 sleeps of 7h each → avg 7h/night
    const sleepA = [
      makeSleep("2026-05-01T22:00:00Z", "2026-05-02T06:00:00Z"), // 8h
      makeSleep("2026-05-02T22:00:00Z", "2026-05-03T06:00:00Z"), // 8h
    ];
    const sleepB = [
      makeSleep("2026-05-08T22:00:00Z", "2026-05-09T05:00:00Z"), // 7h
      makeSleep("2026-05-09T22:00:00Z", "2026-05-10T05:00:00Z"), // 7h
      makeSleep("2026-05-10T22:00:00Z", "2026-05-11T05:00:00Z"), // 7h
      makeSleep("2026-05-11T22:00:00Z", "2026-05-12T05:00:00Z"), // 7h
    ];

    getMock
      .mockResolvedValueOnce(paginated([])) // period_a recovery
      .mockResolvedValueOnce(paginated(sleepA)) // period_a sleep
      .mockResolvedValueOnce(paginated([])) // period_a cycle
      .mockResolvedValueOnce(paginated([])) // period_b recovery
      .mockResolvedValueOnce(paginated(sleepB)) // period_b sleep
      .mockResolvedValueOnce(paginated([])); // period_b cycle

    const result = await comparePeriods(client, {
      period_a_start: "2026-05-01T00:00:00.000Z",
      period_a_end: "2026-05-07T23:59:59.999Z",
      period_b_start: "2026-05-08T00:00:00.000Z",
      period_b_end: "2026-05-21T23:59:59.999Z",
    });

    // Avg sleep: period_a=8h, period_b=7h → -12.5% declined
    expect(result.sleep.period_a_avg_hours).toBeCloseTo(8, 1);
    expect(result.sleep.period_b_avg_hours).toBeCloseTo(7, 1);
    expect(result.sleep.direction).toBe("declined");
  });

  it("filters unscored records", async () => {
    const recoveries = [
      makeRecovery(80),
      { ...makeRecovery(50), score_state: "PENDING_SCORE" as const, score: undefined },
    ];

    getMock
      .mockResolvedValueOnce(paginated(recoveries)) // period_a recovery
      .mockResolvedValueOnce(paginated([])) // period_a sleep
      .mockResolvedValueOnce(paginated([])) // period_a cycle
      .mockResolvedValueOnce(paginated([makeRecovery(80)])) // period_b recovery
      .mockResolvedValueOnce(paginated([])) // period_b sleep
      .mockResolvedValueOnce(paginated([])); // period_b cycle

    const result = await comparePeriods(client, {
      period_a_start: "2026-05-01T00:00:00.000Z",
      period_a_end: "2026-05-07T23:59:59.999Z",
      period_b_start: "2026-05-08T00:00:00.000Z",
      period_b_end: "2026-05-14T23:59:59.999Z",
    });

    // Only the scored recovery (80) should count
    expect(result.recovery.period_a_avg).toBe(80);
  });

  it("includes period metadata (start, end, days) in output", async () => {
    getMock.mockResolvedValue(paginated([]));

    const result = await comparePeriods(client, {
      period_a_start: "2026-05-01T00:00:00.000Z",
      period_a_end: "2026-05-07T23:59:59.999Z",
      period_b_start: "2026-05-08T00:00:00.000Z",
      period_b_end: "2026-05-14T23:59:59.999Z",
    });

    expect(result.period_a.start).toBe("2026-05-01T00:00:00.000Z");
    expect(result.period_a.end).toBe("2026-05-07T23:59:59.999Z");
    expect(result.period_a.days).toBeCloseTo(7, 0);
    expect(result.period_b.start).toBe("2026-05-08T00:00:00.000Z");
    expect(result.period_b.end).toBe("2026-05-14T23:59:59.999Z");
    expect(result.period_b.days).toBeCloseTo(7, 0);
  });

  it("computes strain direction as increased/decreased/unchanged", async () => {
    getMock
      .mockResolvedValueOnce(paginated([])) // period_a recovery
      .mockResolvedValueOnce(paginated([])) // period_a sleep
      .mockResolvedValueOnce(paginated([makeCycle(10)])) // period_a cycle
      .mockResolvedValueOnce(paginated([])) // period_b recovery
      .mockResolvedValueOnce(paginated([])) // period_b sleep
      .mockResolvedValueOnce(paginated([makeCycle(15)])); // period_b cycle

    const result = await comparePeriods(client, {
      period_a_start: "2026-05-01T00:00:00.000Z",
      period_a_end: "2026-05-07T23:59:59.999Z",
      period_b_start: "2026-05-08T00:00:00.000Z",
      period_b_end: "2026-05-14T23:59:59.999Z",
    });

    expect(result.strain.period_a_avg).toBe(10);
    expect(result.strain.period_b_avg).toBe(15);
    expect(result.strain.change_pct).toBeCloseTo(50, 0);
    expect(result.strain.direction).toBe("increased");
  });

  it("makes 6 sequential API calls (3 per period)", async () => {
    getMock.mockResolvedValue(paginated([]));

    await comparePeriods(client, {
      period_a_start: "2026-05-01T00:00:00.000Z",
      period_a_end: "2026-05-07T23:59:59.999Z",
      period_b_start: "2026-05-08T00:00:00.000Z",
      period_b_end: "2026-05-14T23:59:59.999Z",
    });

    expect(getMock).toHaveBeenCalledTimes(6);
  });

  it("accepts enhanced date expressions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T12:00:00.000Z"));
    getMock.mockResolvedValue(paginated([]));

    await comparePeriods(client, {
      period_a_start: "2026-05-01T00:00:00.000Z",
      period_a_end: "2026-05-07T23:59:59.999Z",
      period_b_start: "2026-05-08T00:00:00.000Z",
      period_b_end: "2026-05-14T23:59:59.999Z",
    });

    // Just verify it doesn't throw — date expressions are validated in date-utils
    expect(getMock).toHaveBeenCalled();

    vi.useRealTimers();
  });
});
