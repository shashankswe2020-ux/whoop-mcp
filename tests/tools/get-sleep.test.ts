import { describe, it, expect, vi } from "vitest";
import { getSleepCollection } from "../../src/tools/get-sleep.js";
import type { SleepCollection } from "../../src/api/types.js";
import { ENDPOINT_SLEEP } from "../../src/api/endpoints.js";
import { createMockClient } from "../helpers/mock-client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SLEEP_FIXTURE: SleepCollection = {
  records: [
    {
      id: "sleep-1",
      cycle_id: 100,
      user_id: 12345,
      created_at: "2026-04-10T06:00:00.000Z",
      updated_at: "2026-04-10T06:30:00.000Z",
      start: "2026-04-09T23:00:00.000Z",
      end: "2026-04-10T06:00:00.000Z",
      timezone_offset: "-04:00",
      nap: false,
      score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: 25200000,
          total_awake_time_milli: 1800000,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: 9000000,
          total_slow_wave_sleep_time_milli: 7200000,
          total_rem_sleep_time_milli: 7200000,
          sleep_cycle_count: 4,
          disturbance_count: 2,
        },
        sleep_needed: {
          baseline_milli: 28800000,
          need_from_sleep_debt_milli: 0,
          need_from_recent_strain_milli: 1800000,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: 15.2,
        sleep_performance_percentage: 92,
        sleep_consistency_percentage: 85,
        sleep_efficiency_percentage: 93,
      },
    },
  ],
  next_token: "sleep-page-2",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getSleepCollection", () => {
  it("calls the sleep endpoint with no query params when none provided", async () => {
    const client = createMockClient(SLEEP_FIXTURE);

    await getSleepCollection(client, {});

    expect(client.get).toHaveBeenCalledWith(ENDPOINT_SLEEP);
  });

  it("includes all params in query string when all provided", async () => {
    const client = createMockClient(SLEEP_FIXTURE);

    await getSleepCollection(client, {
      start: "2026-04-01T00:00:00.000Z",
      end: "2026-04-10T00:00:00.000Z",
      limit: 15,
      nextToken: "page2",
    });

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const url = new URL(calledPath, "https://placeholder.test");

    expect(url.pathname).toBe(ENDPOINT_SLEEP);
    expect(url.searchParams.get("start")).toBe("2026-04-01T00:00:00.000Z");
    expect(url.searchParams.get("end")).toBe("2026-04-10T00:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("15");
    expect(url.searchParams.get("nextToken")).toBe("page2");
  });

  it("omits undefined params from query string", async () => {
    const client = createMockClient(SLEEP_FIXTURE);

    await getSleepCollection(client, { start: "2026-04-01T00:00:00.000Z" });

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;

    expect(calledPath).not.toContain("limit");
    expect(calledPath).not.toContain("end");
    expect(calledPath).not.toContain("nextToken");
  });

  it("returns the sleep collection from the API", async () => {
    const client = createMockClient(SLEEP_FIXTURE);

    const result = await getSleepCollection(client, {});

    expect(result).toEqual(SLEEP_FIXTURE);
  });

  it("propagates API errors", async () => {
    const client = createMockClient(undefined);
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("WHOOP API error: 403 Forbidden")
    );

    await expect(getSleepCollection(client, {})).rejects.toThrow("WHOOP API error: 403 Forbidden");
  });
});
