/**
 * Tool: get_today
 *
 * Composite tool that fetches today's recovery, last night's sleep,
 * current cycle strain, and most recent workout in parallel.
 * Returns a unified snapshot with a human-readable summary.
 */

import type { WhoopClient } from "../api/client.js";
import type {
  RecoveryCollection,
  SleepCollection,
  CycleCollection,
  WorkoutCollection,
} from "../api/types.js";
import {
  ENDPOINT_RECOVERY,
  ENDPOINT_SLEEP,
  ENDPOINT_WORKOUT,
  ENDPOINT_CYCLE,
} from "../api/endpoints.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TodayRecovery {
  score: number;
  hrv_rmssd_milli: number;
  resting_heart_rate: number;
  spo2_pct: number | null;
  skin_temp_celsius: number | null;
}

export interface TodaySleep {
  total_hours: number;
  rem_hours: number;
  deep_hours: number;
  light_hours: number;
  awake_hours: number;
  performance_pct: number;
  efficiency_pct: number;
  respiratory_rate: number | null;
}

export interface TodayLastWorkout {
  sport_name: string;
  strain: number;
}

export interface TodayStrain {
  day_strain: number;
  energy_burned_kj: number;
  last_workout: TodayLastWorkout | null;
}

export interface TodaySnapshot {
  timestamp: string;
  recovery: TodayRecovery | null;
  sleep: TodaySleep | null;
  strain: TodayStrain | null;
  summary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MILLI_PER_HOUR = 1000 * 60 * 60;

function milliToHours(ms: number): number {
  return Math.round((ms / MILLI_PER_HOUR) * 10) / 10;
}

function buildSummary(snapshot: {
  recovery: TodayRecovery | null;
  sleep: TodaySleep | null;
  strain: TodayStrain | null;
}): string {
  const parts: string[] = [];

  if (snapshot.recovery) {
    const score = snapshot.recovery.score;
    const zone = score >= 67 ? "green" : score >= 34 ? "yellow" : "red";
    parts.push(`Recovery ${score}% (${zone})`);
  }

  if (snapshot.sleep) {
    parts.push(`${snapshot.sleep.total_hours}h sleep`);
  }

  if (snapshot.strain) {
    parts.push(`strain ${snapshot.strain.day_strain}`);
  }

  if (parts.length === 0) {
    return "No data available yet today";
  }

  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Get today's complete health snapshot.
 *
 * Fetches recovery, sleep, cycle, and workout data in parallel.
 * If individual endpoints fail, returns null for those sections.
 * Only throws if ALL endpoints fail.
 *
 * @param client - Authenticated WHOOP API client
 * @returns Today's snapshot with recovery, sleep, strain, and summary
 * @throws Error if all API calls fail
 */
export async function getToday(client: WhoopClient): Promise<TodaySnapshot> {
  const [recoveryResult, sleepResult, cycleResult, workoutResult] = await Promise.allSettled([
    client.get<RecoveryCollection>(`${ENDPOINT_RECOVERY}?limit=1`),
    client.get<SleepCollection>(`${ENDPOINT_SLEEP}?limit=1`),
    client.get<CycleCollection>(`${ENDPOINT_CYCLE}?limit=1`),
    client.get<WorkoutCollection>(`${ENDPOINT_WORKOUT}?limit=1`),
  ]);

  // Check if ALL primary endpoints failed (workout failure alone doesn't count)
  const primaryResults = [recoveryResult, sleepResult, cycleResult];
  const allPrimaryFailed = primaryResults.every((r) => r.status === "rejected");

  if (allPrimaryFailed) {
    throw new Error("All API calls failed. Unable to retrieve today's health snapshot.");
  }

  // Parse recovery
  let recovery: TodayRecovery | null = null;
  if (recoveryResult.status === "fulfilled") {
    const record = recoveryResult.value.records[0];
    if (record?.score) {
      recovery = {
        score: record.score.recovery_score,
        hrv_rmssd_milli: record.score.hrv_rmssd_milli,
        resting_heart_rate: record.score.resting_heart_rate,
        spo2_pct: record.score.spo2_percentage ?? null,
        skin_temp_celsius: record.score.skin_temp_celsius ?? null,
      };
    }
  }

  // Parse sleep
  let sleep: TodaySleep | null = null;
  if (sleepResult.status === "fulfilled") {
    const record = sleepResult.value.records[0];
    if (record?.score) {
      const stages = record.score.stage_summary;
      sleep = {
        total_hours: milliToHours(stages.total_in_bed_time_milli),
        rem_hours: milliToHours(stages.total_rem_sleep_time_milli),
        deep_hours: milliToHours(stages.total_slow_wave_sleep_time_milli),
        light_hours: milliToHours(stages.total_light_sleep_time_milli),
        awake_hours: milliToHours(stages.total_awake_time_milli),
        performance_pct: record.score.sleep_performance_percentage ?? 0,
        efficiency_pct: record.score.sleep_efficiency_percentage ?? 0,
        respiratory_rate: record.score.respiratory_rate ?? null,
      };
    }
  }

  // Parse strain (cycle)
  let strain: TodayStrain | null = null;
  if (cycleResult.status === "fulfilled") {
    const record = cycleResult.value.records[0];
    if (record?.score) {
      // Parse last workout
      let lastWorkout: TodayLastWorkout | null = null;
      if (workoutResult.status === "fulfilled") {
        const workout = workoutResult.value.records[0];
        if (workout?.score) {
          lastWorkout = {
            sport_name: workout.sport_name,
            strain: workout.score.strain,
          };
        }
      }

      strain = {
        day_strain: record.score.strain,
        energy_burned_kj: record.score.kilojoule,
        last_workout: lastWorkout,
      };
    }
  }

  const snapshot: TodaySnapshot = {
    timestamp: new Date().toISOString(),
    recovery,
    sleep,
    strain,
    summary: buildSummary({ recovery, sleep, strain }),
  };

  return snapshot;
}
