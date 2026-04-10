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
