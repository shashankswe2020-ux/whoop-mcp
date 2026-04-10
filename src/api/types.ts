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
