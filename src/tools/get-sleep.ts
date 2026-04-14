/**
 * Tool: get_sleep_collection
 *
 * Fetches paginated sleep records for a date range.
 * Returns sleep stages, duration, respiratory rate, and performance scores.
 */

import type { WhoopClient } from "../api/client.js";
import type { SleepCollection } from "../api/types.js";
import { ENDPOINT_SLEEP } from "../api/endpoints.js";
import { buildCollectionQuery } from "./collection-utils.js";
import type { CollectionParams } from "./collection-utils.js";

/**
 * Get sleep records for a date range.
 *
 * @param client - Authenticated WHOOP API client
 * @param params - Optional filtering: start, end, limit, nextToken
 * @returns Paginated sleep collection
 */
export async function getSleepCollection(
  client: WhoopClient,
  params: CollectionParams
): Promise<SleepCollection> {
  const query = buildCollectionQuery(params);
  return client.get<SleepCollection>(`${ENDPOINT_SLEEP}${query}`);
}
