/**
 * Shared types and utilities for collection tool handlers.
 *
 * All 4 collection tools (recovery, sleep, workout, cycle) use the same
 * query parameter shape and query string building logic.
 *
 * Enhanced date expressions ("today", "last 7 days", etc.) are resolved
 * to ISO 8601 before sending to the WHOOP API.
 */

import { resolveDateExpression, InvalidDateExpression } from "./date-utils.js";

/** Input params shared by all collection endpoints */
export interface CollectionParams {
  start?: string;
  end?: string;
  limit?: number;
  nextToken?: string;
}

/**
 * Resolve a date expression to an ISO 8601 start value.
 * If already ISO 8601, passes through unchanged.
 * Returns undefined if input is undefined.
 */
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize a date-only string (YYYY-MM-DD) to a full ISO 8601 datetime.
 * The WHOOP API requires a full datetime for start/end query parameters;
 * date-only strings return HTTP 404.
 */
function normalizeToISO8601(value: string): string {
  if (DATE_ONLY_REGEX.test(value)) {
    return value + "T00:00:00.000Z";
  }
  return value;
}

function resolveStart(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const resolved = resolveDateExpression(value);
    return normalizeToISO8601(resolved.start);
  } catch (e) {
    if (e instanceof InvalidDateExpression) {
      throw e;
    }
    return normalizeToISO8601(value);
  }
}

/**
 * Resolve a date expression to an ISO 8601 end value.
 * If already ISO 8601, passes through unchanged.
 * Returns undefined if input is undefined.
 */
function resolveEnd(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const resolved = resolveDateExpression(value);
    return normalizeToISO8601(resolved.end);
  } catch (e) {
    if (e instanceof InvalidDateExpression) {
      throw e;
    }
    return normalizeToISO8601(value);
  }
}

/**
 * Build a query string from collection params.
 * Resolves enhanced date expressions in start/end to ISO 8601.
 * Omits undefined values. Returns empty string if no params are set.
 *
 * @param params - Optional collection query parameters
 * @returns Query string (e.g. "?start=...&limit=5") or empty string
 */
export function buildCollectionQuery(params: CollectionParams): string {
  const searchParams = new URLSearchParams();

  const start = resolveStart(params.start);
  const end = resolveEnd(params.end);

  if (start !== undefined) {
    searchParams.set("start", start);
  }
  if (end !== undefined) {
    searchParams.set("end", end);
  }
  if (params.limit !== undefined) {
    searchParams.set("limit", String(params.limit));
  }
  if (params.nextToken !== undefined) {
    searchParams.set("nextToken", params.nextToken);
  }

  const query = searchParams.toString();
  return query ? `?${query}` : "";
}
