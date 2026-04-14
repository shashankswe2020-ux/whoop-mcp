/**
 * Tool: get_recovery_collection
 *
 * Fetches paginated recovery scores for a date range.
 * Returns HRV, resting heart rate, SpO2, and skin temp for each day.
 */

import type { WhoopClient } from "../api/client.js";
import type { RecoveryCollection } from "../api/types.js";
import { ENDPOINT_RECOVERY } from "../api/endpoints.js";
import { buildCollectionQuery } from "./collection-utils.js";
import type { CollectionParams } from "./collection-utils.js";

/**
 * Get recovery scores for a date range.
 *
 * @param client - Authenticated WHOOP API client
 * @param params - Optional filtering: start, end, limit, nextToken
 * @returns Paginated recovery collection
 */
export async function getRecoveryCollection(
  client: WhoopClient,
  params: CollectionParams
): Promise<RecoveryCollection> {
  const query = buildCollectionQuery(params);
  return client.get<RecoveryCollection>(`${ENDPOINT_RECOVERY}${query}`);
}
