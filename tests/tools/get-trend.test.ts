/**
 * Tests for get_trend tool.
 *
 * Verifies that get_trend:
 * - Maps metric names to correct endpoint + field extraction
 * - Returns statistics (mean, median, std_dev, min, max)
 * - Returns trend direction + slope + confidence
 * - Detects anomalies (>2σ from mean)
 * - Errors for < 2 data points
 * - Returns "stable" for constant values
 * - Filters unscored records
 * - Accepts days parameter (7–90, default 30)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WhoopClient } from "../../src/api/client.js";
import { getTrend } from "../../src/tools/get-trend.js";
import type { Recovery, Sleep, Cycle, PaginatedResponse } from "../../src/api/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(): { client: WhoopClient; getMock: ReturnType<typeof vi.fn> } {
  const getMock = vi.fn();
  const client = { get: getMock } as unknown as WhoopClient;
  return { client, getMock };
}

function makeRecovery(opts: {
  recovery_score: number;
  hrv: number;
  rhr: number;
  date?: string;
}): Recovery {
  return {
    cycle_id: 1,
    sleep_id: "s1",
    user_id: 100,
    created_at: opts.date ?? "2026-05-01T06:00:00.000Z",
    updated_at: opts.date ?? "2026-05-01T06:00:00.000Z",
    score_state: "SCORED",
    score: {
      user_calibrating: false,
      recovery_score: opts.recovery_score,
      resting_heart_rate: opts.rhr,
      hrv_rmssd_milli: opts.hrv,
      spo2_percentage: 98,
      skin_temp_celsius: 33.5,
    },
  };
}

function makeSleep(startIso: string, endIso: string, performance?: number): Sleep {
  return {
    id: `sleep-${startIso}`,
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
      sleep_performance_percentage: performance ?? 85,
      sleep_consistency_percentage: 90,
      sleep_efficiency_percentage: 88,
    },
  };
}

function makeCycle(strain: number, date?: string): Cycle {
  return {
    id: 1,
    user_id: 100,
    created_at: date ?? "2026-05-01T00:00:00.000Z",
    updated_at: date ?? "2026-05-01T23:59:59.000Z",
    start: date ?? "2026-05-01T00:00:00.000Z",
    end: date ?? "2026-05-01T23:59:59.000Z",
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

describe("getTrend", () => {
  let client: WhoopClient;
  let getMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T12:00:00.000Z"));
    const mock = createMockClient();
    client = mock.client;
    getMock = mock.getMock;
  });

  it("maps 'recovery' metric to recovery endpoint and recovery_score field", async () => {
    const recoveries = [
      makeRecovery({ recovery_score: 70, hrv: 55, rhr: 52 }),
      makeRecovery({ recovery_score: 75, hrv: 60, rhr: 54 }),
      makeRecovery({ recovery_score: 80, hrv: 65, rhr: 56 }),
    ];
    getMock.mockResolvedValueOnce(paginated(recoveries));

    const result = await getTrend(client, { metric: "recovery" });

    expect(result.metric).toBe("recovery");
    expect(result.values).toEqual([70, 75, 80]);
    expect(getMock.mock.calls[0]?.[0]).toContain("/v2/recovery");
  });

  it("maps 'hrv' metric to recovery endpoint and hrv_rmssd_milli field", async () => {
    const recoveries = [
      makeRecovery({ recovery_score: 70, hrv: 50, rhr: 52 }),
      makeRecovery({ recovery_score: 75, hrv: 60, rhr: 54 }),
      makeRecovery({ recovery_score: 80, hrv: 70, rhr: 56 }),
    ];
    getMock.mockResolvedValueOnce(paginated(recoveries));

    const result = await getTrend(client, { metric: "hrv" });

    expect(result.values).toEqual([50, 60, 70]);
  });

  it("maps 'rhr' metric to recovery endpoint and resting_heart_rate field", async () => {
    const recoveries = [
      makeRecovery({ recovery_score: 70, hrv: 55, rhr: 52 }),
      makeRecovery({ recovery_score: 75, hrv: 60, rhr: 54 }),
    ];
    getMock.mockResolvedValueOnce(paginated(recoveries));

    const result = await getTrend(client, { metric: "rhr" });

    expect(result.values).toEqual([52, 54]);
  });

  it("maps 'sleep_duration' metric to sleep endpoint and computes hours from start/end", async () => {
    const sleeps = [
      makeSleep("2026-05-25T22:00:00Z", "2026-05-26T06:00:00Z"), // 8h
      makeSleep("2026-05-26T23:00:00Z", "2026-05-27T06:30:00Z"), // 7.5h
    ];
    getMock.mockResolvedValueOnce(paginated(sleeps));

    const result = await getTrend(client, { metric: "sleep_duration" });

    expect(result.values[0]).toBeCloseTo(8, 1);
    expect(result.values[1]).toBeCloseTo(7.5, 1);
    expect(getMock.mock.calls[0]?.[0]).toContain("/v2/activity/sleep");
  });

  it("maps 'sleep_performance' metric to sleep endpoint and sleep_performance_percentage", async () => {
    const sleeps = [
      makeSleep("2026-05-25T22:00:00Z", "2026-05-26T06:00:00Z", 85),
      makeSleep("2026-05-26T22:00:00Z", "2026-05-27T06:00:00Z", 90),
    ];
    getMock.mockResolvedValueOnce(paginated(sleeps));

    const result = await getTrend(client, { metric: "sleep_performance" });

    expect(result.values).toEqual([85, 90]);
  });

  it("maps 'strain' metric to cycle endpoint and score.strain", async () => {
    const cycles = [makeCycle(12.5), makeCycle(14.0), makeCycle(10.0)];
    getMock.mockResolvedValueOnce(paginated(cycles));

    const result = await getTrend(client, { metric: "strain" });

    expect(result.values).toEqual([12.5, 14.0, 10.0]);
    expect(getMock.mock.calls[0]?.[0]).toContain("/v2/cycle");
  });

  it("returns correct statistics", async () => {
    // Values: 60, 70, 80, 90, 100
    const recoveries = [60, 70, 80, 90, 100].map((s) =>
      makeRecovery({ recovery_score: s, hrv: 55, rhr: 52 })
    );
    getMock.mockResolvedValueOnce(paginated(recoveries));

    const result = await getTrend(client, { metric: "recovery" });

    expect(result.statistics.mean).toBe(80);
    expect(result.statistics.median).toBe(80);
    expect(result.statistics.min).toBe(60);
    expect(result.statistics.max).toBe(100);
    expect(result.statistics.std_dev).toBeGreaterThan(0);
  });

  it("returns trend direction with slope and confidence", async () => {
    // Monotonically increasing → improving with high confidence
    const recoveries = [50, 60, 70, 80, 90, 100].map((s) =>
      makeRecovery({ recovery_score: s, hrv: 55, rhr: 52 })
    );
    getMock.mockResolvedValueOnce(paginated(recoveries));

    const result = await getTrend(client, { metric: "recovery" });

    expect(result.trend.direction).toBe("improving");
    expect(result.trend.slope).toBeGreaterThan(0);
    expect(result.trend.confidence).toBe("high");
  });

  it("returns declining trend for decreasing values", async () => {
    const recoveries = [100, 90, 80, 70, 60, 50].map((s) =>
      makeRecovery({ recovery_score: s, hrv: 55, rhr: 52 })
    );
    getMock.mockResolvedValueOnce(paginated(recoveries));

    const result = await getTrend(client, { metric: "recovery" });

    expect(result.trend.direction).toBe("declining");
    expect(result.trend.slope).toBeLessThan(0);
  });

  it("returns stable when all values are identical (zero variance)", async () => {
    const recoveries = [75, 75, 75, 75, 75].map((s) =>
      makeRecovery({ recovery_score: s, hrv: 55, rhr: 52 })
    );
    getMock.mockResolvedValueOnce(paginated(recoveries));

    const result = await getTrend(client, { metric: "recovery" });

    expect(result.trend.direction).toBe("stable");
    expect(result.statistics.std_dev).toBe(0);
  });

  it("detects anomalies (>2σ from mean)", async () => {
    // 10 values around 70, one outlier at 20
    const scores = [70, 72, 68, 71, 69, 73, 70, 71, 20, 70];
    const recoveries = scores.map((s) => makeRecovery({ recovery_score: s, hrv: 55, rhr: 52 }));
    getMock.mockResolvedValueOnce(paginated(recoveries));

    const result = await getTrend(client, { metric: "recovery" });

    expect(result.anomalies.length).toBeGreaterThan(0);
    expect(result.anomalies[0]!.value).toBe(20);
    expect(result.anomalies[0]!.deviation_from_mean).toBeGreaterThan(2);
  });

  it("throws error for < 2 data points", async () => {
    getMock.mockResolvedValueOnce(
      paginated([makeRecovery({ recovery_score: 70, hrv: 55, rhr: 52 })])
    );

    await expect(getTrend(client, { metric: "recovery" })).rejects.toThrow("at least 2");
  });

  it("throws error for 0 data points", async () => {
    getMock.mockResolvedValueOnce(paginated([]));

    await expect(getTrend(client, { metric: "recovery" })).rejects.toThrow("at least 2");
  });

  it("filters unscored records", async () => {
    const recoveries: Recovery[] = [
      makeRecovery({ recovery_score: 70, hrv: 55, rhr: 52 }),
      {
        ...makeRecovery({ recovery_score: 50, hrv: 40, rhr: 60 }),
        score_state: "PENDING_SCORE",
        score: undefined,
      },
      makeRecovery({ recovery_score: 80, hrv: 65, rhr: 54 }),
    ];
    getMock.mockResolvedValueOnce(paginated(recoveries));

    const result = await getTrend(client, { metric: "recovery" });

    expect(result.values).toEqual([70, 80]);
  });

  it("defaults to 30 days when days not specified", async () => {
    getMock.mockResolvedValueOnce(
      paginated([
        makeRecovery({ recovery_score: 70, hrv: 55, rhr: 52 }),
        makeRecovery({ recovery_score: 75, hrv: 60, rhr: 54 }),
      ])
    );

    const result = await getTrend(client, { metric: "recovery" });

    expect(result.period.days).toBe(30);
    // Check the query includes appropriate date range
    const call = getMock.mock.calls[0]?.[0] as string;
    expect(call).toContain("start=");
  });

  it("includes period start, end, and days in output", async () => {
    getMock.mockResolvedValueOnce(
      paginated([
        makeRecovery({ recovery_score: 70, hrv: 55, rhr: 52 }),
        makeRecovery({ recovery_score: 75, hrv: 60, rhr: 54 }),
      ])
    );

    const result = await getTrend(client, { metric: "recovery", days: 14 });

    expect(result.period.days).toBe(14);
    expect(result.period.start).toBeDefined();
    expect(result.period.end).toBeDefined();
  });
});
