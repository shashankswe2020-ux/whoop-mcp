/**
 * MCP Resources — ambient health context backed by the shared API client cache.
 *
 * Exposes 4 resources:
 * - whoop://v2/user/recovery/latest — most recent recovery score
 * - whoop://v2/user/sleep/latest — most recent sleep record
 * - whoop://v2/user/cycle/latest — most recent cycle
 * - whoop://v2/user/profile — user profile (cached 1hr)
 *
 * Caching, in-flight deduplication, and invalidation are handled by the
 * `MemoryCache` injected into the WHOOP client (opt-in per request via the
 * `cache` option). Because resources and tools share that one cache keyed by
 * request path, a warm `get_today` can be served entirely from cache.
 */

import type { WhoopClient } from "../api/client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL for recovery and sleep resources — 5 minutes */
export const DYNAMIC_TTL_MS = 5 * 60 * 1000;

/** TTL for the cycle resource — 2 minutes (strain updates more frequently) */
export const CYCLE_TTL_MS = 2 * 60 * 1000;

/** TTL for the profile resource — 1 hour */
export const PROFILE_TTL_MS = 60 * 60 * 1000;

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
      const result = await client.get<{ records: unknown[] }>("/v2/recovery?limit=1", {
        cache: true,
        ttlMs: DYNAMIC_TTL_MS,
      });
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
      const result = await client.get<{ records: unknown[] }>("/v2/activity/sleep?limit=1", {
        cache: true,
        ttlMs: DYNAMIC_TTL_MS,
      });
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
    ttlMs: CYCLE_TTL_MS,
    fetch: async (client) => {
      const result = await client.get<{ records: unknown[] }>("/v2/cycle?limit=1", {
        cache: true,
        ttlMs: CYCLE_TTL_MS,
      });
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
      return client.get("/v2/user/profile/basic", { cache: true, ttlMs: PROFILE_TTL_MS });
    },
  },
];

// ---------------------------------------------------------------------------
// Resource registration
// ---------------------------------------------------------------------------

/**
 * Register all WHOOP resources on the given MCP server.
 *
 * Caching is delegated to the client's shared `MemoryCache`; this function is
 * stateless and registers read handlers only.
 */
export function registerResources(server: McpServer, client: WhoopClient): void {
  for (const def of RESOURCE_DEFINITIONS) {
    server.registerResource(
      def.name,
      def.uri,
      { description: def.description, mimeType: def.mimeType },
      async (uri: URL) => {
        try {
          const data = await def.fetch(client);
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: def.mimeType,
                text: JSON.stringify(data, null, 2),
              },
            ],
          };
        } catch {
          const message = "Resource unavailable. Retry later or verify authorization.";
          console.error(`[whoop-mcp] Resource read failed for ${def.uri}`);
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
}
