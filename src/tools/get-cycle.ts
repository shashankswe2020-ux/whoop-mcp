/**
 * Tool: get_cycle_collection
 *
 * Fetches paginated physiological cycles for a date range.
 * Returns strain, calories, and heart rate data per cycle.
 */

import type { WhoopClient } from "../api/client.js";
import type { CycleCollection } from "../api/types.js";
import { ENDPOINT_CYCLE } from "../api/endpoints.js";
import { buildCollectionQuery } from "./collection-utils.js";
import type { CollectionParams } from "./collection-utils.js";

/**
 * Get physiological cycles for a date range.
 *
 * @param client - Authenticated WHOOP API client
 * @param params - Optional filtering: start, end, limit, nextToken
 * @returns Paginated cycle collection
 */
export async function getCycleCollection(
  client: WhoopClient,
  params: CollectionParams
): Promise<CycleCollection> {
  const query = buildCollectionQuery(params);
  return client.get<CycleCollection>(`${ENDPOINT_CYCLE}${query}`);
}
