/**
 * WHOOP API HTTP client.
 *
 * Thin wrapper around native `fetch` that injects the OAuth Bearer token,
 * prepends the WHOOP API base URL, parses JSON responses, and throws
 * typed errors for non-2xx status codes.
 */

import { WHOOP_API_BASE_URL } from "./endpoints.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for creating a WHOOP API client */
export interface WhoopClientOptions {
  accessToken: string;
  /** Override base URL — useful for testing. Defaults to WHOOP_API_BASE_URL. */
  baseUrl?: string;
  /** Callback to refresh the access token on 401. Returns a new access token. */
  onTokenRefresh?: () => Promise<string>;
}

/** WHOOP API client returned by createWhoopClient */
export interface WhoopClient {
  /** Send a GET request and parse the JSON response as T */
  get<T>(path: string): Promise<T>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error thrown when the WHOOP API returns a non-2xx response */
export class WhoopApiError extends Error {
  public override readonly name = "WhoopApiError";

  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    public readonly body: unknown,
  ) {
    super(`WHOOP API error: ${statusCode} ${statusText}`);
  }
}

/** Error thrown when a network-level failure prevents reaching the WHOOP API */
export class WhoopNetworkError extends Error {
  public override readonly name = "WhoopNetworkError";

  constructor(cause: unknown) {
    super(
      "Network error: Unable to reach the WHOOP API. Check your internet connection.",
      { cause },
    );
  }
}

/** Error thrown when token refresh fails during automatic 401 recovery */
export class WhoopAuthError extends Error {
  public override readonly name = "WhoopAuthError";

  constructor(cause: unknown) {
    super(
      "Authentication error: Failed to refresh token. Re-authentication may be required.",
      { cause },
    );
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of retries for 429 rate limit responses */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff (1s, 2s, 4s) */
const BASE_RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a given number of milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the Retry-After header as seconds.
 * Returns the delay in milliseconds, or null if the header is missing/unparseable.
 */
function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isNaN(seconds) || seconds < 0) {
    return null;
  }
  return seconds * 1000;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Create a WHOOP API client.
 *
 * The client prepends the base URL to all paths, injects the Bearer token,
 * parses JSON responses, retries 429 rate limit responses with backoff,
 * and throws typed errors for non-2xx status codes.
 */
export function createWhoopClient(options: WhoopClientOptions): WhoopClient {
  const baseUrl = options.baseUrl ?? WHOOP_API_BASE_URL;

  async function doFetch(url: string, accessToken: string): Promise<Response> {
    try {
      return await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });
    } catch (error: unknown) {
      if (error instanceof WhoopApiError) {
        throw error;
      }
      throw new WhoopNetworkError(error);
    }
  }

  async function parseErrorBody(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return await response.text();
    }
  }

  return {
    async get<T>(path: string): Promise<T> {
      const url = `${baseUrl}${path}`;
      let currentToken = options.accessToken;
      let lastError: WhoopApiError | undefined;
      let lastResponse: Response | undefined;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        // Wait before retry (not before the first attempt)
        if (attempt > 0 && lastResponse) {
          const retryDelay =
            parseRetryAfter(lastResponse) ??
            BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          await delay(retryDelay);
        }

        const response = await doFetch(url, currentToken);

        if (response.ok) {
          return (await response.json()) as T;
        }

        const body = await parseErrorBody(response);
        const apiError = new WhoopApiError(
          response.status,
          response.statusText,
          body,
        );

        // Only retry on 429 rate limit
        if (response.status === 429) {
          lastError = apiError;
          lastResponse = response;
          continue;
        }

        // 401: attempt token refresh once
        if (response.status === 401 && options.onTokenRefresh) {
          let newToken: string;
          try {
            newToken = await options.onTokenRefresh();
          } catch (refreshError: unknown) {
            throw new WhoopAuthError(refreshError);
          }

          // Retry with the new token
          const retryResponse = await doFetch(url, newToken);
          if (retryResponse.ok) {
            return (await retryResponse.json()) as T;
          }

          // Retry also failed — throw the original error
          const retryBody = await parseErrorBody(retryResponse);
          throw new WhoopApiError(
            retryResponse.status,
            retryResponse.statusText,
            retryBody,
          );
        }

        // All other errors: throw immediately
        throw apiError;
      }

      // All retries exhausted
      throw lastError!;
    },
  };
}
