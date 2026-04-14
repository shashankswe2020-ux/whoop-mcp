/**
 * Tool: get_body_measurement
 *
 * Fetches the user's body measurements (height, weight, max heart rate).
 */

import type { WhoopClient } from "../api/client.js";
import type { BodyMeasurement } from "../api/types.js";
import { ENDPOINT_BODY_MEASUREMENT } from "../api/endpoints.js";

/**
 * Get the user's body measurements.
 *
 * @param client - Authenticated WHOOP API client
 * @returns Body measurement with height_meter, weight_kilogram, max_heart_rate
 */
export async function getBodyMeasurement(client: WhoopClient): Promise<BodyMeasurement> {
  return client.get<BodyMeasurement>(ENDPOINT_BODY_MEASUREMENT);
}
