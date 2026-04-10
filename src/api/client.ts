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

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Create a WHOOP API client.
 *
 * The client prepends the base URL to all paths, injects the Bearer token,
 * and parses JSON responses. Throws `WhoopApiError` on non-2xx responses.
 */
export function createWhoopClient(options: WhoopClientOptions): WhoopClient {
  const baseUrl = options.baseUrl ?? WHOOP_API_BASE_URL;

  return {
    async get<T>(path: string): Promise<T> {
      const url = `${baseUrl}${path}`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${options.accessToken}`,
            "Content-Type": "application/json",
          },
        });
      } catch (error: unknown) {
        // Don't wrap WhoopApiError — only wrap network-level errors
        if (error instanceof WhoopApiError) {
          throw error;
        }
        throw new WhoopNetworkError(error);
      }

      if (!response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = await response.text();
        }
        throw new WhoopApiError(response.status, response.statusText, body);
      }

      return (await response.json()) as T;
    },
  };
}
