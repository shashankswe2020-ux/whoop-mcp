import { vi } from "vitest";
import type { WhoopClient } from "../../src/api/client.js";
import type { Cycle, Recovery, Sleep, Workout, ZoneDurations } from "../../src/api/types.js";

const MIN = 60_000;

export interface WorkoutSpec {
  id: string;
  sport: string;
  /** UTC ISO start */
  start: string;
  durationSeconds: number;
  avgHr?: number;
  maxHr?: number;
  strain?: number;
  kcal?: number;
  distance?: number | null;
  zonesMinutes?: [number, number, number, number, number, number];
  offset?: string;
  scoreState?: Workout["score_state"];
  percentRecorded?: number;
}

export function zones(minutes: [number, number, number, number, number, number]): ZoneDurations {
  return {
    zone_zero_milli: minutes[0] * MIN,
    zone_one_milli: minutes[1] * MIN,
    zone_two_milli: minutes[2] * MIN,
    zone_three_milli: minutes[3] * MIN,
    zone_four_milli: minutes[4] * MIN,
    zone_five_milli: minutes[5] * MIN,
  };
}

export function workout(spec: WorkoutSpec): Workout {
  const end = new Date(Date.parse(spec.start) + spec.durationSeconds * 1000).toISOString();
  const scoreState = spec.scoreState ?? "SCORED";
  return {
    id: spec.id,
    user_id: 42,
    created_at: end,
    updated_at: end,
    start: spec.start,
    end,
    timezone_offset: spec.offset ?? "+05:30",
    sport_name: spec.sport,
    score_state: scoreState,
    score:
      scoreState === "SCORED"
        ? {
            strain: spec.strain ?? 5,
            average_heart_rate: spec.avgHr ?? 140,
            max_heart_rate: spec.maxHr ?? 160,
            kilojoule: (spec.kcal ?? 50) * 4.184,
            percent_recorded: spec.percentRecorded ?? 100,
            zone_durations: zones(spec.zonesMinutes ?? [0, spec.durationSeconds / 60, 0, 0, 0, 0]),
            distance_meter: spec.distance ?? null,
          }
        : null,
  };
}

/** Local (+05:30) "HH:MM:SS" on 2026-10-15 → UTC ISO. */
function ist(time: string): string {
  return new Date(`2026-10-15T${time}+05:30`).toISOString();
}

/**
 * The HYROX simulation + lift from the r/whoop session report (2026-10-15).
 * Durations, HR, strain and kcal are taken from the report's segment table; start seconds are
 * chosen so tracked time = 40:24 and session span = 46:26 (transition 6:02, 13.0 %).
 */
export function redditHyroxDay(): Workout[] {
  const rows: Array<[string, string, string, number, number, number, number, number, number?]> = [
    ["run-1", "running", "19:32:00", 429, 142, 161, 5.3, 72],
    ["ski-1", "skiing", "19:39:30", 157, 147, 162, 4.5, 30, 1700],
    ["run-2", "running", "19:42:30", 349, 145, 162, 5.1, 62],
    ["row-1", "rowing", "19:50:00", 178, 122, 131, 4.1, 18],
    ["run-3", "running", "19:53:20", 347, 155, 169, 5.7, 74],
    ["run-4", "running", "20:00:10", 78, 118, 148, 4.0, 7],
    ["run-5", "running", "20:02:00", 375, 141, 152, 4.9, 62],
    ["ski-2", "skiing", "20:09:00", 201, 117, 145, 4.1, 16],
    ["run-6", "running", "20:13:16", 310, 162, 171, 5.9, 75, 11_700],
    ["lift-1", "weightlifting", "20:48:00", 3303, 115, 142, 11.9, 238],
  ];
  return rows.map(([id, sport, time, durationSeconds, avgHr, maxHr, strain, kcal, distance]) =>
    workout({
      id,
      sport,
      start: ist(time),
      durationSeconds,
      avgHr,
      maxHr,
      strain,
      kcal,
      distance: distance ?? null,
    })
  );
}

/**
 * One workout per day for `days` days ending on `endDay` (UTC, offset +00:00), each with
 * `zonesMinutes` in zone 1..5 (index 1..5). Edwards TRIMP per day = Σ minutes × zone.
 */
export function dailyWorkouts(
  endDay: string,
  days: number,
  sport: string,
  zonesMinutes: [number, number, number, number, number, number],
  idPrefix = sport
): Workout[] {
  const end = Date.parse(`${endDay}T07:00:00Z`);
  return Array.from({ length: days }, (_, index) => {
    const start = new Date(end - (days - 1 - index) * 86_400_000).toISOString();
    const minutes = zonesMinutes.reduce((total, value) => total + value, 0);
    return workout({
      id: `${idPrefix}-${index}`,
      sport,
      start,
      durationSeconds: minutes * 60,
      zonesMinutes,
      offset: "+00:00",
    });
  });
}

export interface PerformanceSources {
  workouts?: Workout[] | Error;
  sleep?: Sleep[] | Error;
  recovery?: Recovery[] | Error;
  cycles?: Cycle[] | Error;
}

/** Mock WHOOP client serving fixed records per endpoint; filters workouts by the `start`/`end` query. */
export function performanceClient(sources: PerformanceSources): WhoopClient & {
  get: ReturnType<typeof vi.fn>;
} {
  const byPath: Record<string, unknown[] | Error> = {
    "/v2/activity/workout": sources.workouts ?? [],
    "/v2/activity/sleep": sources.sleep ?? [],
    "/v2/recovery": sources.recovery ?? [],
    "/v2/cycle": sources.cycles ?? [],
  };
  return {
    get: vi.fn(async (path: string) => {
      const [base, query] = path.split("?");
      const data = byPath[base!];
      if (data instanceof Error) throw data;
      const params = new URLSearchParams(query);
      const start = Date.parse(params.get("start") ?? "1970-01-01T00:00:00Z");
      const end = Date.parse(params.get("end") ?? "2999-01-01T00:00:00Z");
      const records = (data ?? []).filter((record) => {
        const at = Date.parse(
          (record as { start?: string; created_at: string }).start ??
            (record as { created_at: string }).created_at
        );
        return at >= start && at < end;
      });
      return { records, next_token: null };
    }),
  } as unknown as WhoopClient & { get: ReturnType<typeof vi.fn> };
}

export interface NightSpec {
  /** Local wake-up day YYYY-MM-DD. */
  day: string;
  recovery: number;
  hrv?: number;
  rhr?: number;
  offset?: string;
  sleepHours?: number;
  debtHours?: number;
  spo2?: number;
  respiratoryRate?: number;
}

/** A main sleep ending 07:00 local on `day` plus its linked recovery. */
export function night(spec: NightSpec): { sleep: Sleep; recovery: Recovery } {
  const offset = spec.offset ?? "+05:30";
  const end = new Date(`${spec.day}T07:00:00${offset}`).toISOString();
  const hours = spec.sleepHours ?? 7.5;
  const sleep: Sleep = {
    id: `sleep-${spec.day}`,
    cycle_id: Number(spec.day.replaceAll("-", "")),
    user_id: 42,
    created_at: end,
    updated_at: end,
    start: new Date(Date.parse(end) - (hours + 0.5) * 3_600_000).toISOString(),
    end,
    timezone_offset: offset,
    nap: false,
    score_state: "SCORED",
    score: {
      stage_summary: {
        total_in_bed_time_milli: (hours + 0.5) * 3_600_000,
        total_awake_time_milli: 1_800_000,
        total_no_data_time_milli: 0,
        total_light_sleep_time_milli: hours * 0.5 * 3_600_000,
        total_slow_wave_sleep_time_milli: hours * 0.25 * 3_600_000,
        total_rem_sleep_time_milli: hours * 0.25 * 3_600_000,
        sleep_cycle_count: 4,
        disturbance_count: 1,
      },
      sleep_needed: {
        baseline_milli: 28_800_000,
        need_from_recent_strain_milli: 0,
        need_from_recent_nap_milli: 0,
        need_from_sleep_debt_milli: (spec.debtHours ?? 0.5) * 3_600_000,
      },
      respiratory_rate: spec.respiratoryRate ?? 15.2,
      sleep_performance_percentage: 90,
    },
  };
  const recovery: Recovery = {
    cycle_id: sleep.cycle_id,
    sleep_id: sleep.id,
    user_id: 42,
    created_at: end,
    updated_at: end,
    score_state: "SCORED",
    score: {
      user_calibrating: false,
      recovery_score: spec.recovery,
      resting_heart_rate: spec.rhr ?? 52,
      hrv_rmssd_milli: spec.hrv ?? 60,
      spo2_percentage: spec.spo2 ?? 96,
    },
  };
  return { sleep, recovery };
}

/** `count` consecutive nights ending on `endDay`, all with the given recovery unless overridden. */
export function nights(
  endDay: string,
  count: number,
  base: Omit<NightSpec, "day">,
  overrides: Record<string, Partial<NightSpec>> = {}
): { sleep: Sleep[]; recovery: Recovery[] } {
  const end = Date.parse(`${endDay}T00:00:00Z`);
  const items = Array.from({ length: count }, (_, index) => {
    const day = new Date(end - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10);
    return night({ ...base, ...overrides[day], day });
  });
  return { sleep: items.map((item) => item.sleep), recovery: items.map((item) => item.recovery) };
}

export function cycle(day: string, strain: number, offset = "+05:30"): Cycle {
  const start = new Date(`${day}T06:00:00${offset}`).toISOString();
  return {
    id: Number(day.replaceAll("-", "")),
    user_id: 42,
    created_at: start,
    updated_at: start,
    start,
    end: new Date(Date.parse(start) + 86_400_000).toISOString(),
    timezone_offset: offset,
    score_state: "SCORED",
    score: { strain, kilojoule: 12_000, average_heart_rate: 80, max_heart_rate: 171 },
  };
}
