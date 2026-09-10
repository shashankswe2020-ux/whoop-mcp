import { vi } from "vitest";
import type { WhoopClient } from "../../src/api/client.js";
import type { Cycle, Recovery, Sleep } from "../../src/api/types.js";

export const ANALYTICS_NOW = new Date("2026-09-10T12:00:00Z");
export function sleepFixture(index: number): Sleep {
  const end = new Date(ANALYTICS_NOW.getTime() - index * 86_400_000 - 6 * 3_600_000).toISOString();
  return {
    id: `sleep-${index}`,
    cycle_id: index,
    user_id: 42,
    created_at: end,
    updated_at: end,
    start: new Date(Date.parse(end) - 8 * 3_600_000).toISOString(),
    end,
    timezone_offset: "+00:00",
    nap: false,
    score_state: "SCORED",
    score: {
      stage_summary: {
        total_in_bed_time_milli: 28_800_000,
        total_awake_time_milli: 3_600_000,
        total_no_data_time_milli: 0,
        total_light_sleep_time_milli: 14_400_000,
        total_slow_wave_sleep_time_milli: 3_600_000,
        total_rem_sleep_time_milli: 7_200_000,
        sleep_cycle_count: 4,
        disturbance_count: 1,
      },
      sleep_needed: {
        baseline_milli: 32_400_000,
        need_from_recent_strain_milli: 0,
        need_from_recent_nap_milli: -3_600_000,
        need_from_sleep_debt_milli: 18_000_000,
      },
      respiratory_rate: 15,
    },
  };
}
export function cycleFixture(index: number): Cycle {
  const sleep = sleepFixture(index);
  return {
    id: index,
    user_id: 42,
    created_at: sleep.end,
    updated_at: sleep.end,
    start: sleep.end,
    timezone_offset: "+00:00",
    score_state: "SCORED",
  };
}
export function recoveryFixture(index: number): Recovery {
  const sleep = sleepFixture(index);
  return {
    cycle_id: index,
    sleep_id: sleep.id,
    user_id: 42,
    created_at: sleep.end,
    updated_at: sleep.end,
    score_state: "SCORED",
    score: {
      user_calibrating: false,
      recovery_score: 70,
      resting_heart_rate: 50,
      hrv_rmssd_milli: index === 0 ? 100 : 40,
    },
  };
}
export function analyticsClient(count = 20, overrides: Record<string, unknown> = {}): WhoopClient {
  const data: Record<string, unknown> = {
    "/v2/activity/sleep": {
      records: Array.from({ length: count }, (_, index) => sleepFixture(index)),
    },
    "/v2/cycle": { records: Array.from({ length: count }, (_, index) => cycleFixture(index)) },
    "/v2/recovery": {
      records: Array.from({ length: count }, (_, index) => recoveryFixture(index)),
    },
    ...overrides,
  };
  return {
    get: vi.fn(async (path: string) => {
      const response = data[path.split("?")[0]!];
      if (response instanceof Error) throw response;
      return response;
    }),
  } as unknown as WhoopClient;
}
