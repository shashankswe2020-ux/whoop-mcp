/**
 * Auto-pagination utility for WHOOP API collection endpoints.
 *
 * Follows `next_token` across multiple pages with rate-limit safety guards:
 * - Hard cap on total records (ABSOLUTE_MAX_RECORDS = 500)
 * - Configurable max pages (default 20)
 * - Inter-page delay to respect rate limits (default 200ms)
 * - AbortSignal support for cancellation
 */

import type { WhoopClient } from "./client.js";
import type { PaginatedResponse } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Absolute maximum records — cannot be overridden by caller */
export const ABSOLUTE_MAX_RECORDS = 500;

/** Default maximum records per fetchAllPages call */
const DEFAULT_MAX_RECORDS = 100;

/** Default maximum pages to fetch */
const DEFAULT_MAX_PAGES = 20;

/** Default inter-page delay in milliseconds */
const DEFAULT_INTER_PAGE_DELAY_MS = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for fetchAllPages */
export interface FetchAllPagesOptions {
  /** Maximum number of records to return (capped at ABSOLUTE_MAX_RECORDS). Default: 100 */
  maxRecords?: number;
  /** Maximum number of pages to fetch. Default: 20 */
  maxPages?: number;
  /** Delay between page fetches in milliseconds. Default: 200 */
  interPageDelayMs?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

/** Result from fetchAllPages */
export interface FetchAllPagesResult<T> {
  /** Collected records from all pages */
  records: T[];
  /** True if pagination was stopped before exhausting all pages */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Append nextToken to a path, handling existing query parameters.
 */
function appendNextToken(path: string, nextToken: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}nextToken=${encodeURIComponent(nextToken)}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Fetch all pages from a paginated WHOOP API endpoint.
 *
 * Follows `next_token` until exhausted or a safety cap is hit.
 * Returns collected records and whether pagination was truncated.
 *
 * @param client - WHOOP API client
 * @param path - Endpoint path (may include query params)
 * @param options - Pagination options
 */
export async function fetchAllPages<T>(
  client: WhoopClient,
  path: string,
  options: FetchAllPagesOptions = {}
): Promise<FetchAllPagesResult<T>> {
  const maxRecords = Math.min(options.maxRecords ?? DEFAULT_MAX_RECORDS, ABSOLUTE_MAX_RECORDS);
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const interPageDelayMs = options.interPageDelayMs ?? DEFAULT_INTER_PAGE_DELAY_MS;
  const signal = options.signal;

  const allRecords: T[] = [];
  let currentPath = path;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    // Check abort signal before fetching (except first page)
    if (pagesFetched > 0 && signal?.aborted) {
      return { records: allRecords, truncated: true };
    }

    // Inter-page delay (not before the first page)
    if (pagesFetched > 0 && interPageDelayMs > 0) {
      await delay(interPageDelayMs);
    }

    const response = await client.get<PaginatedResponse<T>>(currentPath);
    pagesFetched++;

    // Append records up to maxRecords
    const remaining = maxRecords - allRecords.length;
    if (response.records.length <= remaining) {
      allRecords.push(...response.records);
    } else {
      allRecords.push(...response.records.slice(0, remaining));
      return { records: allRecords, truncated: true };
    }

    // Check if we've hit maxRecords exactly
    if (allRecords.length >= maxRecords) {
      const truncated = response.next_token !== undefined;
      return { records: allRecords, truncated };
    }

    // No more pages
    if (!response.next_token) {
      return { records: allRecords, truncated: false };
    }

    // Check abort signal after fetch (before continuing to next page)
    if (signal?.aborted) {
      return { records: allRecords, truncated: true };
    }

    // Prepare next page
    currentPath = appendNextToken(path, response.next_token);
  }

  // Hit maxPages cap
  return { records: allRecords, truncated: true };
}
