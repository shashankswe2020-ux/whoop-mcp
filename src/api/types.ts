/**
 * TypeScript types for all WHOOP API responses.
 *
 * Property names use snake_case to match the JSON responses
 * from the WHOOP API (no casing transformation).
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Score state returned by all scorable entities */
export type ScoreState = "SCORED" | "PENDING_SCORE" | "UNSCORABLE";

/** Generic paginated response shape used by all collection endpoints */
export interface PaginatedResponse<T> {
  records: T[];
  next_token?: string;
}

// ---------------------------------------------------------------------------
// User types
// ---------------------------------------------------------------------------

/** GET /v2/user/profile/basic */
export interface UserProfile {
  user_id: number;
  email: string;
  first_name: string;
  last_name: string;
}

/** GET /v2/user/measurement/body */
export interface BodyMeasurement {
  height_meter: number;
  weight_kilogram: number;
  max_heart_rate: number;
}

// ---------------------------------------------------------------------------
// Recovery types
// ---------------------------------------------------------------------------

/** Score details for a recovery — only present when score_state is "SCORED" */
export interface RecoveryScore {
  user_calibrating: boolean;
  recovery_score: number;
  resting_heart_rate: number;
  hrv_rmssd_milli: number;
  spo2_percentage?: number;
  skin_temp_celsius?: number;
}

/** A single recovery record */
export interface Recovery {
  cycle_id: number;
  sleep_id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: ScoreState;
  score?: RecoveryScore;
}

/** GET /v2/recovery — paginated */
export type RecoveryCollection = PaginatedResponse<Recovery>;

// ---------------------------------------------------------------------------
// Sleep types
// ---------------------------------------------------------------------------

/** Breakdown of time spent in each sleep stage */
export interface SleepStageSummary {
  total_in_bed_time_milli: number;
  total_awake_time_milli: number;
  total_no_data_time_milli: number;
  total_light_sleep_time_milli: number;
  total_slow_wave_sleep_time_milli: number;
  total_rem_sleep_time_milli: number;
  sleep_cycle_count: number;
  disturbance_count: number;
}

/** Breakdown of how much sleep the user needed */
export interface SleepNeeded {
  baseline_milli: number;
  need_from_sleep_debt_milli: number;
  need_from_recent_strain_milli: number;
  need_from_recent_nap_milli: number;
}

/** Score details for a sleep — only present when score_state is "SCORED" */
export interface SleepScore {
  stage_summary: SleepStageSummary;
  sleep_needed: SleepNeeded;
  respiratory_rate?: number;
  sleep_performance_percentage?: number;
  sleep_consistency_percentage?: number;
  sleep_efficiency_percentage?: number;
}

/** A single sleep record */
export interface Sleep {
  id: string;
  cycle_id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  nap: boolean;
  score_state: ScoreState;
  v1_id?: number;
  score?: SleepScore;
}

/** GET /v2/activity/sleep — paginated */
export type SleepCollection = PaginatedResponse<Sleep>;

// ---------------------------------------------------------------------------
// Cycle types
// ---------------------------------------------------------------------------

/** Score details for a physiological cycle — strain and heart rate */
export interface CycleScore {
  strain: number;
  kilojoule: number;
  average_heart_rate: number;
  max_heart_rate: number;
}

/** A single physiological cycle */
export interface Cycle {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end?: string;
  timezone_offset: string;
  score_state: ScoreState;
  score?: CycleScore;
}

/** GET /v2/cycle — paginated */
export type CycleCollection = PaginatedResponse<Cycle>;
