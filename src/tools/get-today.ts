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
import { DYNAMIC_TTL_MS, CYCLE_TTL_MS } from "../resources/index.js";
import { WhoopNetworkError } from "../api/client.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import {
  asleepHours,
  DAY_MS,
  localDay,
  observedPeriod,
  parseRecords,
  sourceQuality,
  type DataQuality,
  type SourceQuality,
} from "./analytics-utils.js";

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
  time_in_bed_hours: number;
  asleep_hours: number;
  rem_hours: number;
  deep_hours: number;
  light_hours: number;
  awake_hours: number;
  performance_pct: number | null;
  efficiency_pct: number | null;
  respiratory_rate: number | null;
}

export interface TodayLastWorkout {
  sport_name: string;
  strain: number;
  occurred_at: string;
  percent_recorded: number;
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
  data_quality: DataQuality;
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
    parts.push(`${snapshot.sleep.asleep_hours}h sleep`);
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
export async function getToday(
  client: WhoopClient,
  now: Date = new Date()
): Promise<TodaySnapshot> {
  const [recoveryResult, sleepResult, cycleResult, workoutResult] = await Promise.allSettled([
    client.get<RecoveryCollection>(`${ENDPOINT_RECOVERY}?limit=25`, {
      cache: true,
      ttlMs: DYNAMIC_TTL_MS,
    }),
    client.get<SleepCollection>(`${ENDPOINT_SLEEP}?limit=25`, {
      cache: true,
      ttlMs: DYNAMIC_TTL_MS,
    }),
    client.get<CycleCollection>(`${ENDPOINT_CYCLE}?limit=25`, { cache: true, ttlMs: CYCLE_TTL_MS }),
    client.get<WorkoutCollection>(`${ENDPOINT_WORKOUT}?limit=25`, {
      cache: true,
      ttlMs: DYNAMIC_TTL_MS,
    }),
  ]);

  // Check if ALL primary endpoints failed (workout failure alone doesn't count)
  const primaryResults = [recoveryResult, sleepResult, cycleResult];
  const allPrimaryFailed = primaryResults.every((r) => r.status === "rejected");

  if (allPrimaryFailed) {
    throw new WhoopNetworkError(
      "All API calls failed. Unable to retrieve today's health snapshot."
    );
  }

  function unpack<T>(result: PromiseSettledResult<{ records: T[]; next_token?: string }>): {
    records: T[];
    quality: SourceQuality;
  } {
    if (result.status === "rejected")
      return { records: [], quality: { ...sourceQuality(), status: "fetch_failed" } };
    if (!Array.isArray(result.value?.records))
      return { records: [], quality: { ...sourceQuality(), status: "invalid" } };
    return {
      records: result.value.records.slice(0, 25),
      quality: sourceQuality(
        result.value.records.length,
        Boolean(result.value.next_token) || result.value.records.length > 25
      ),
    };
  }
  const recoveryData = unpack(recoveryResult);
  const sleepData = unpack(sleepResult);
  const cycleData = unpack(cycleResult);
  const workoutData = unpack(workoutResult);
  const cycles = parseRecords(
    cycleData.records,
    cycleRecordSchema.omit({ score: true }),
    cycleData.quality
  )
    .filter((record) => Date.parse(record.start) <= now.getTime())
    .sort((left, right) => Date.parse(right.start) - Date.parse(left.start));
  const cycleCandidate = cycles.find(
    (record) =>
      localDay(record.start, record.timezone_offset) ===
      localDay(now.toISOString(), record.timezone_offset)
  );
  const cycle = parseRecords(
    cycleCandidate ? [cycleCandidate] : [],
    cycleRecordSchema,
    cycleData.quality
  )[0];
  if (!cycleCandidate && cycles.length) cycleData.quality.status = "stale";
  const sleeps = parseRecords(
    sleepData.records,
    sleepRecordSchema.omit({ score: true }),
    sleepData.quality
  )
    .filter(
      (record) =>
        !record.nap &&
        Date.parse(record.end) <= now.getTime() &&
        Date.parse(record.end) > Date.parse(record.start)
    )
    .sort((left, right) => Date.parse(right.end) - Date.parse(left.end));
  const primarySleep = sleeps[0];
  const sleepCandidate =
    primarySleep &&
    localDay(primarySleep.end, primarySleep.timezone_offset) ===
      localDay(now.toISOString(), primarySleep.timezone_offset)
      ? primarySleep
      : undefined;
  const currentSleep = parseRecords(
    sleepCandidate ? [sleepCandidate] : [],
    sleepRecordSchema,
    sleepData.quality
  )[0];
  if (primarySleep && !sleepCandidate) sleepData.quality.status = "stale";
  const recoveries = parseRecords(recoveryData.records, recoveryRecordSchema, recoveryData.quality);
  const recoveryRecord =
    cycle && currentSleep && currentSleep.cycle_id === cycle.id
      ? recoveries.find(
          (record) =>
            record.cycle_id === cycle.id &&
            record.sleep_id === currentSleep.id &&
            record.user_id === cycle.user_id &&
            record.user_id === currentSleep.user_id
        )
      : undefined;
  const workouts = parseRecords(workoutData.records, workoutRecordSchema, workoutData.quality)
    .filter(
      (record) =>
        Date.parse(record.end) <= now.getTime() && Date.parse(record.end) > Date.parse(record.start)
    )
    .sort((left, right) => Date.parse(right.start) - Date.parse(left.start));
  function mark(
    record: { score_state: string; score?: unknown; updated_at: string } | undefined,
    quality: SourceQuality
  ): boolean {
    if (!record) return false;
    quality.source_updated_at = record.updated_at;
    quality.status =
      record.score_state === "PENDING_SCORE"
        ? "pending"
        : record.score_state !== "SCORED"
          ? "unscored"
          : record.score
            ? "available"
            : "invalid";
    quality.records_used = quality.status === "available" ? 1 : 0;
    return quality.status === "available";
  }
  const sleepAvailable = mark(currentSleep, sleepData.quality);
  const cycleAvailable = mark(cycle, cycleData.quality);
  const recoveryAvailable = mark(recoveryRecord, recoveryData.quality);
  if (!sleepAvailable && recoveryAvailable) {
    recoveryData.quality.status = sleepData.quality.status;
    recoveryData.quality.records_used = 0;
  }
  if (recoveryRecord?.score?.user_calibrating) recoveryData.quality.status = "calibrating";
  const workoutAvailable = mark(workouts[0], workoutData.quality);

  // Parse recovery
  let recovery: TodayRecovery | null = null;
  if (recoveryAvailable && sleepAvailable) {
    const record = recoveryRecord;
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
  if (sleepAvailable) {
    const record = currentSleep;
    if (record?.score_state === "SCORED" && record.score) {
      const stages = record.score.stage_summary;
      sleep = {
        total_hours: milliToHours(stages.total_in_bed_time_milli),
        time_in_bed_hours: milliToHours(stages.total_in_bed_time_milli),
        asleep_hours: Math.round(asleepHours(record) * 10) / 10,
        rem_hours: milliToHours(stages.total_rem_sleep_time_milli),
        deep_hours: milliToHours(stages.total_slow_wave_sleep_time_milli),
        light_hours: milliToHours(stages.total_light_sleep_time_milli),
        awake_hours: milliToHours(stages.total_awake_time_milli),
        performance_pct: record.score.sleep_performance_percentage ?? null,
        efficiency_pct: record.score.sleep_efficiency_percentage ?? null,
        respiratory_rate: record.score.respiratory_rate ?? null,
      };
    }
  }

  // Parse strain (cycle)
  let strain: TodayStrain | null = null;
  if (cycleAvailable) {
    const record = cycle;
    if (record?.score) {
      // Parse last workout
      let lastWorkout: TodayLastWorkout | null = null;
      if (workoutAvailable) {
        const workout = workouts[0];
        if (workout?.score) {
          lastWorkout = {
            sport_name: workout.sport_name,
            strain: workout.score.strain,
            occurred_at: workout.start,
            percent_recorded: workout.score.percent_recorded,
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
    timestamp: now.toISOString(),
    recovery,
    sleep,
    strain,
    summary: buildSummary({ recovery, sleep, strain }),
    data_quality: {
      evaluated_at: now.toISOString(),
      requested_period: {
        start: new Date(now.getTime() - DAY_MS).toISOString(),
        end: now.toISOString(),
      },
      observed_period: observedPeriod([
        ...(sleep ? [currentSleep!.end] : []),
        ...(strain ? [cycle!.start] : []),
      ]),
      sources: {
        recovery: recoveryData.quality,
        sleep: sleepData.quality,
        cycle: cycleData.quality,
        workout: workoutData.quality,
      },
      method_version: "today-2",
      limitations: [
        "Recorded offsets define local days; latest workout may be historical.",
        "Fetch time and cache status are not available from the client.",
      ],
    },
  };

  const unavailable = Object.entries(snapshot.data_quality.sources)
    .filter(([, quality]) => quality.status !== "available")
    .map(([name, quality]) => `${name}: ${quality.status}`);
  if (unavailable.length) snapshot.summary += `. ${unavailable.join(", ")}`;

  return snapshot;
}
