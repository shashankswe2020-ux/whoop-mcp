/**
 * MCP Resources — in-memory cache with TTL and in-flight deduplication.
 *
 * Exposes 4 resources:
 * - whoop://v2/user/recovery/latest — most recent recovery score
 * - whoop://v2/user/sleep/latest — most recent sleep record
 * - whoop://v2/user/cycle/latest — most recent cycle
 * - whoop://v2/user/profile — user profile (cached 1hr)
 *
 * Cache is scoped to the ResourceCache instance (not global).
 * In-flight deduplication shares a single Promise for concurrent reads.
 * Token refresh invalidates all cached entries.
 */

import type { WhoopClient } from "../api/client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TTL for dynamic resources (recovery, sleep, cycle) — 5 minutes */
export const DYNAMIC_TTL_MS = 5 * 60 * 1000;

/** TTL for the profile resource — 1 hour */
export const PROFILE_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Cache types
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

// ---------------------------------------------------------------------------
// ResourceCache class
// ---------------------------------------------------------------------------

/**
 * In-memory cache with TTL and in-flight request deduplication.
 * Scoped to a single instance — not global.
 */
export class ResourceCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();
  private generation = 0;

  /**
   * Get a value from cache or fetch it.
   * Concurrent calls for the same key share a single in-flight request.
   * Uses a generation counter to prevent stale fetches from repopulating
   * a cache that was invalidated mid-flight.
   */
  async getOrFetch<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    // Check cache
    const entry = this.cache.get(key);
    if (entry && Date.now() < entry.expiry) {
      return entry.data as T;
    }

    // Deduplicate in-flight requests
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    // Capture generation before fetch — if invalidated mid-flight, don't cache
    const gen = this.generation;

    // Fetch and cache
    const promise = fetcher()
      .then((data) => {
        if (this.generation === gen) {
          this.cache.set(key, { data, expiry: Date.now() + ttlMs });
        }
        this.inflight.delete(key);
        return data;
      })
      .catch((error: unknown) => {
        this.inflight.delete(key);
        throw error;
      });

    this.inflight.set(key, promise);
    return promise;
  }

  /** Invalidate all cached entries (e.g., on token refresh). */
  invalidateAll(): void {
    this.cache.clear();
    this.generation++;
  }
}

// ---------------------------------------------------------------------------
// Resource definitions
// ---------------------------------------------------------------------------

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  ttlMs: number;
  fetch: (client: WhoopClient) => Promise<unknown>;
}

export const RESOURCE_DEFINITIONS: ResourceDefinition[] = [
  {
    uri: "whoop://v2/user/recovery/latest",
    name: "Latest Recovery",
    description: "Most recent recovery score including HRV, resting heart rate, and SpO2.",
    mimeType: "application/json",
    ttlMs: DYNAMIC_TTL_MS,
    fetch: async (client) => {
      const result = await client.get<{ records: unknown[] }>("/v2/recovery?limit=1");
      if (result.records.length === 0) {
        return { message: "No recovery data available." };
      }
      return result.records[0];
    },
  },
  {
    uri: "whoop://v2/user/sleep/latest",
    name: "Latest Sleep",
    description: "Most recent sleep record including stages, duration, and performance.",
    mimeType: "application/json",
    ttlMs: DYNAMIC_TTL_MS,
    fetch: async (client) => {
      const result = await client.get<{ records: unknown[] }>("/v2/activity/sleep?limit=1");
      if (result.records.length === 0) {
        return { message: "No sleep data available." };
      }
      return result.records[0];
    },
  },
  {
    uri: "whoop://v2/user/cycle/latest",
    name: "Latest Cycle",
    description: "Most recent physiological cycle including strain and calorie data.",
    mimeType: "application/json",
    ttlMs: DYNAMIC_TTL_MS,
    fetch: async (client) => {
      const result = await client.get<{ records: unknown[] }>("/v2/cycle?limit=1");
      if (result.records.length === 0) {
        return { message: "No cycle data available." };
      }
      return result.records[0];
    },
  },
  {
    uri: "whoop://v2/user/profile",
    name: "User Profile",
    description: "Authenticated user's basic profile — name and email.",
    mimeType: "application/json",
    ttlMs: PROFILE_TTL_MS,
    fetch: async (client) => {
      return client.get("/v2/user/profile/basic");
    },
  },
];

// ---------------------------------------------------------------------------
// Resource registration
// ---------------------------------------------------------------------------

/**
 * Register all WHOOP resources on the given MCP server.
 * Returns the ResourceCache instance for cache invalidation on token refresh.
 */
export function registerResources(server: McpServer, client: WhoopClient): ResourceCache {
  const cache = new ResourceCache();

  for (const def of RESOURCE_DEFINITIONS) {
    server.registerResource(
      def.name,
      def.uri,
      { description: def.description, mimeType: def.mimeType },
      async (uri: URL) => {
        try {
          const data = await cache.getOrFetch(def.uri, def.ttlMs, () => def.fetch(client));
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: def.mimeType,
                text: JSON.stringify(data, null, 2),
              },
            ],
          };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error";
          console.error(`[whoop-mcp] Resource read failed for ${def.uri}: ${message}`);
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "application/json",
                text: JSON.stringify({ error: message }),
              },
            ],
          };
        }
      }
    );
  }

  return cache;
}
