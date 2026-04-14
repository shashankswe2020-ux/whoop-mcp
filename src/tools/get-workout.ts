/**
 * Tool: get_workout_collection
 *
 * Fetches paginated workout records for a date range.
 * Returns strain, heart rate zones, calories, and sport type.
 */

import type { WhoopClient } from "../api/client.js";
import type { WorkoutCollection } from "../api/types.js";
import { ENDPOINT_WORKOUT } from "../api/endpoints.js";
import { buildCollectionQuery } from "./collection-utils.js";
import type { CollectionParams } from "./collection-utils.js";

/**
 * Get workout records for a date range.
 *
 * @param client - Authenticated WHOOP API client
 * @param params - Optional filtering: start, end, limit, nextToken
 * @returns Paginated workout collection
 */
export async function getWorkoutCollection(
  client: WhoopClient,
  params: CollectionParams
): Promise<WorkoutCollection> {
  const query = buildCollectionQuery(params);
  return client.get<WorkoutCollection>(`${ENDPOINT_WORKOUT}${query}`);
}
