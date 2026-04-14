import { describe, it, expect, vi } from "vitest";
import { getBodyMeasurement } from "../../src/tools/get-body-measurement.js";
import type { BodyMeasurement } from "../../src/api/types.js";
import { ENDPOINT_BODY_MEASUREMENT } from "../../src/api/endpoints.js";
import { createMockClient } from "../helpers/mock-client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BODY_MEASUREMENT_FIXTURE: BodyMeasurement = {
  height_meter: 1.78,
  weight_kilogram: 75.5,
  max_heart_rate: 195,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getBodyMeasurement", () => {
  it("calls the correct endpoint", async () => {
    const client = createMockClient(BODY_MEASUREMENT_FIXTURE);

    await getBodyMeasurement(client);

    expect(client.get).toHaveBeenCalledWith(ENDPOINT_BODY_MEASUREMENT);
  });

  it("calls the endpoint exactly once", async () => {
    const client = createMockClient(BODY_MEASUREMENT_FIXTURE);

    await getBodyMeasurement(client);

    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it("returns the body measurement from the API", async () => {
    const client = createMockClient(BODY_MEASUREMENT_FIXTURE);

    const result = await getBodyMeasurement(client);

    expect(result).toEqual(BODY_MEASUREMENT_FIXTURE);
  });

  it("propagates API errors", async () => {
    const client = createMockClient(undefined);
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("WHOOP API error: 500 Internal Server Error")
    );

    await expect(getBodyMeasurement(client)).rejects.toThrow(
      "WHOOP API error: 500 Internal Server Error"
    );
  });
});
