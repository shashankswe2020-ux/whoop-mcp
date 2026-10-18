import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WhoopClient } from "../src/api/client.js";
import type { Cycle, Recovery, Sleep, Workout } from "../src/api/types.js";
import { createDashboardApi } from "../src/dashboard/api.js";
import { startDashboardServer } from "../src/dashboard/server.js";
import { DAY_MS } from "../src/tools/analytics-utils.js";

// Synthetic fixture for reproducible screenshots. Never reads credentials or contacts WHOOP.
const now = new Date("2026-10-19T18:00:00Z");
const workouts: Workout[] = [];
const sleep: Sleep[] = [];
const recovery: Recovery[] = [];
const cycles: Cycle[] = [];
for (let index = 0; index < 56; index++) {
  const date = new Date(now.getTime() - (55 - index) * DAY_MS).toISOString().slice(0, 10);
  const start = `${date}T08:00:00.000Z`;
  const end = `${date}T09:00:00.000Z`;
  const zoneMinutes = [4, 12, 20, 16, 7, 1];
  const score = {
    strain: 8 + (index % 8),
    average_heart_rate: 132 + (index % 20),
    max_heart_rate: 172,
    kilojoule: 1600,
    percent_recorded: 100,
    zone_durations: {
      zone_zero_milli: zoneMinutes[0]! * 60_000,
      zone_one_milli: zoneMinutes[1]! * 60_000,
      zone_two_milli: zoneMinutes[2]! * 60_000,
      zone_three_milli: zoneMinutes[3]! * 60_000,
      zone_four_milli: zoneMinutes[4]! * 60_000,
      zone_five_milli: zoneMinutes[5]! * 60_000,
    },
  };
  if (index % 7 !== 0)
    workouts.push({
      id: `sample-${index}`,
      user_id: 42,
      created_at: end,
      updated_at: end,
      start,
      end,
      timezone_offset: "+00:00",
      sport_name: ["running", "cycling", "swimming", "weightlifting"][index % 4]!,
      score_state: "SCORED",
      score,
    });
  if (index < 21 || (index % 11 === 0 && index !== 55)) continue;
  const sleepId = `sample-sleep-${index}`;
  const cycleId = 1000 + index;
  const sleepEnd = `${date}T07:00:00.000Z`;
  const asleepHours = 6 + (index % 9) * 0.25;
  sleep.push({
    id: sleepId,
    cycle_id: cycleId,
    user_id: 42,
    created_at: sleepEnd,
    updated_at: sleepEnd,
    start: new Date(Date.parse(sleepEnd) - (asleepHours + 0.5) * 3_600_000).toISOString(),
    end: sleepEnd,
    timezone_offset: "+00:00",
    nap: false,
    score_state: "SCORED",
    score: {
      stage_summary: {
        total_in_bed_time_milli: (asleepHours + 0.5) * 3_600_000,
        total_awake_time_milli: 1_800_000,
        total_no_data_time_milli: 0,
        total_light_sleep_time_milli: asleepHours * 0.5 * 3_600_000,
        total_slow_wave_sleep_time_milli: asleepHours * 0.25 * 3_600_000,
        total_rem_sleep_time_milli: asleepHours * 0.25 * 3_600_000,
        sleep_cycle_count: 4,
        disturbance_count: 1,
      },
      sleep_needed: {
        baseline_milli: 28_800_000,
        need_from_sleep_debt_milli: 1_800_000,
        need_from_recent_nap_milli: 0,
        need_from_recent_strain_milli: 0,
      },
      sleep_performance_percentage: 85,
      respiratory_rate: 15,
    },
  });
  recovery.push({
    cycle_id: cycleId,
    sleep_id: sleepId,
    user_id: 42,
    created_at: sleepEnd,
    updated_at: sleepEnd,
    score_state: "SCORED",
    score: {
      user_calibrating: false,
      recovery_score: 35 + ((index * 7) % 60),
      hrv_rmssd_milli: 48 + (index % 24),
      resting_heart_rate: 50 + (index % 9),
    },
  });
  cycles.push({
    id: cycleId,
    user_id: 42,
    created_at: sleepEnd,
    updated_at: sleepEnd,
    start: `${date}T00:00:00.000Z`,
    end: index === 55 ? null : `${date}T23:59:59.000Z`,
    timezone_offset: "+00:00",
    score_state: "SCORED",
    score: { strain: 12.5, kilojoule: 9000, average_heart_rate: 70, max_heart_rate: 172 },
  });
}
// One intentionally suspect record exercises the audit workflow.
workouts.push({
  ...workouts[0]!,
  id: "sample-distance-check",
  sport_name: "running",
  start: "2026-10-18T10:00:00.000Z",
  end: "2026-10-18T10:05:00.000Z",
  score: { ...workouts[0]!.score!, distance_meter: 12000 },
});
// A synthetic run/erg chain exercises the session renderer without fabricated station splits.
for (let index = 0; index < 9; index++) {
  const start = new Date(Date.parse("2026-10-19T12:00:00Z") + index * 360_000).toISOString();
  workouts.push({
    ...workouts[0]!,
    id: `sample-segment-${index}`,
    sport_name: index % 3 === 1 ? "rowing" : "running",
    start,
    end: new Date(Date.parse(start) + 300_000).toISOString(),
    score: {
      ...workouts[0]!.score!,
      average_heart_rate: 135 + index * 3,
      max_heart_rate: 155 + index * 3,
      strain: 5 + index / 3,
      zone_durations: {
        zone_zero_milli: 0,
        zone_one_milli: 0,
        zone_two_milli: 120_000,
        zone_three_milli: 120_000,
        zone_four_milli: 60_000,
        zone_five_milli: 0,
      },
    },
  });
}
const sources: Record<string, unknown[]> = {
  "/v2/activity/workout": workouts,
  "/v2/activity/sleep": sleep,
  "/v2/recovery": recovery,
  "/v2/cycle": cycles,
};
const client: WhoopClient = {
  get: async <T>(path: string): Promise<T> => {
    const url = new URL(path, "http://fixture.invalid");
    const start = url.searchParams.get("start") ?? "";
    const end = url.searchParams.get("end") ?? "9999";
    const records = (sources[url.pathname] ?? [])
      .filter((record) => {
        const row = record as { start?: string; created_at: string };
        const at = row.start ?? row.created_at;
        return at >= start && at < end;
      })
      .sort((left, right) => {
        const a = left as { start?: string; created_at: string };
        const b = right as { start?: string; created_at: string };
        return (b.start ?? b.created_at).localeCompare(a.start ?? a.created_at);
      });
    return { records, next_token: null } as T;
  },
};
const directory = await mkdtemp(join(tmpdir(), "whoop-preview-"));
const server = await startDashboardServer({
  api: createDashboardApi({ client, directory, now: () => now }),
});
console.log(`${server.origin}/?view=today#token=${server.token()}`);
// The production server is unref'ed; keep this standalone preview alive for at most 30 minutes.
const lifetime = setTimeout(() => void close(), 30 * 60_000);
const close = async (): Promise<void> => {
  clearTimeout(lifetime);
  await server.close();
  await rm(directory, { recursive: true, force: true });
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
