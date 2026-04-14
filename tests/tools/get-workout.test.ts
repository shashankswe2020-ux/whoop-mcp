import { describe, it, expect, vi } from "vitest";
import { getWorkoutCollection } from "../../src/tools/get-workout.js";
import type { WorkoutCollection } from "../../src/api/types.js";
import { ENDPOINT_WORKOUT } from "../../src/api/endpoints.js";
import { createMockClient } from "../helpers/mock-client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKOUT_FIXTURE: WorkoutCollection = {
  records: [
    {
      id: "workout-1",
      user_id: 12345,
      created_at: "2026-04-10T18:00:00.000Z",
      updated_at: "2026-04-10T19:00:00.000Z",
      start: "2026-04-10T17:00:00.000Z",
      end: "2026-04-10T18:00:00.000Z",
      timezone_offset: "-04:00",
      sport_name: "Running",
      score_state: "SCORED",
      sport_id: 63,
      score: {
        strain: 14.2,
        average_heart_rate: 155,
        max_heart_rate: 182,
        kilojoule: 2100,
        percent_recorded: 100,
        zone_durations: {
          zone_zero_milli: 0,
          zone_one_milli: 120000,
          zone_two_milli: 600000,
          zone_three_milli: 1200000,
          zone_four_milli: 900000,
          zone_five_milli: 180000,
        },
        distance_meter: 8500,
        altitude_gain_meter: 45,
        altitude_change_meter: 2,
      },
    },
  ],
  next_token: "workout-page-2",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getWorkoutCollection", () => {
  it("calls the workout endpoint with no query params when none provided", async () => {
    const client = createMockClient(WORKOUT_FIXTURE);

    await getWorkoutCollection(client, {});

    expect(client.get).toHaveBeenCalledWith(ENDPOINT_WORKOUT);
  });

  it("includes all params in query string when all provided", async () => {
    const client = createMockClient(WORKOUT_FIXTURE);

    await getWorkoutCollection(client, {
      start: "2026-04-01T00:00:00.000Z",
      end: "2026-04-10T00:00:00.000Z",
      limit: 20,
      nextToken: "page3",
    });

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const url = new URL(calledPath, "https://placeholder.test");

    expect(url.pathname).toBe(ENDPOINT_WORKOUT);
    expect(url.searchParams.get("start")).toBe("2026-04-01T00:00:00.000Z");
    expect(url.searchParams.get("end")).toBe("2026-04-10T00:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("nextToken")).toBe("page3");
  });

  it("omits undefined params from query string", async () => {
    const client = createMockClient(WORKOUT_FIXTURE);

    await getWorkoutCollection(client, { limit: 5 });

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;

    expect(calledPath).not.toContain("start");
    expect(calledPath).not.toContain("end");
    expect(calledPath).not.toContain("nextToken");
  });

  it("returns the workout collection from the API", async () => {
    const client = createMockClient(WORKOUT_FIXTURE);

    const result = await getWorkoutCollection(client, {});

    expect(result).toEqual(WORKOUT_FIXTURE);
  });

  it("propagates API errors", async () => {
    const client = createMockClient(undefined);
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("WHOOP API error: 503 Service Unavailable")
    );

    await expect(getWorkoutCollection(client, {})).rejects.toThrow(
      "WHOOP API error: 503 Service Unavailable"
    );
  });
});
