import { describe, it, expect, vi } from "vitest";
import { getRecoveryCollection } from "../../src/tools/get-recovery.js";
import type { RecoveryCollection } from "../../src/api/types.js";
import { ENDPOINT_RECOVERY } from "../../src/api/endpoints.js";
import { createMockClient } from "../helpers/mock-client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RECOVERY_FIXTURE: RecoveryCollection = {
  records: [
    {
      cycle_id: 100,
      sleep_id: "sleep-1",
      user_id: 12345,
      created_at: "2026-04-10T08:00:00.000Z",
      updated_at: "2026-04-10T08:30:00.000Z",
      score_state: "SCORED",
      score: {
        user_calibrating: false,
        recovery_score: 85,
        resting_heart_rate: 52,
        hrv_rmssd_milli: 65.3,
        spo2_percentage: 97.5,
        skin_temp_celsius: 33.2,
      },
    },
  ],
  next_token: "abc123",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getRecoveryCollection", () => {
  it("calls the recovery endpoint with no query params when none provided", async () => {
    const client = createMockClient(RECOVERY_FIXTURE);

    await getRecoveryCollection(client, {});

    expect(client.get).toHaveBeenCalledWith(ENDPOINT_RECOVERY);
  });

  it("includes start param in query string", async () => {
    const client = createMockClient(RECOVERY_FIXTURE);

    await getRecoveryCollection(client, {
      start: "2026-04-01T00:00:00.000Z",
    });

    expect(client.get).toHaveBeenCalledWith(
      `${ENDPOINT_RECOVERY}?start=2026-04-01T00%3A00%3A00.000Z`
    );
  });

  it("includes end param in query string", async () => {
    const client = createMockClient(RECOVERY_FIXTURE);

    await getRecoveryCollection(client, {
      end: "2026-04-10T00:00:00.000Z",
    });

    expect(client.get).toHaveBeenCalledWith(
      `${ENDPOINT_RECOVERY}?end=2026-04-10T00%3A00%3A00.000Z`
    );
  });

  it("includes limit param in query string", async () => {
    const client = createMockClient(RECOVERY_FIXTURE);

    await getRecoveryCollection(client, { limit: 5 });

    expect(client.get).toHaveBeenCalledWith(`${ENDPOINT_RECOVERY}?limit=5`);
  });

  it("includes nextToken param in query string", async () => {
    const client = createMockClient(RECOVERY_FIXTURE);

    await getRecoveryCollection(client, { nextToken: "token123" });

    expect(client.get).toHaveBeenCalledWith(`${ENDPOINT_RECOVERY}?nextToken=token123`);
  });

  it("includes all params in query string when all provided", async () => {
    const client = createMockClient(RECOVERY_FIXTURE);

    await getRecoveryCollection(client, {
      start: "2026-04-01T00:00:00.000Z",
      end: "2026-04-10T00:00:00.000Z",
      limit: 25,
      nextToken: "page2",
    });

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const url = new URL(calledPath, "https://placeholder.test");

    expect(url.pathname).toBe(ENDPOINT_RECOVERY);
    expect(url.searchParams.get("start")).toBe("2026-04-01T00:00:00.000Z");
    expect(url.searchParams.get("end")).toBe("2026-04-10T00:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("nextToken")).toBe("page2");
  });

  it("omits undefined params from query string", async () => {
    const client = createMockClient(RECOVERY_FIXTURE);

    await getRecoveryCollection(client, {
      start: "2026-04-01T00:00:00.000Z",
      limit: undefined,
    });

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;

    expect(calledPath).not.toContain("limit");
    expect(calledPath).not.toContain("end");
    expect(calledPath).not.toContain("nextToken");
  });

  it("returns the recovery collection from the API", async () => {
    const client = createMockClient(RECOVERY_FIXTURE);

    const result = await getRecoveryCollection(client, {});

    expect(result).toEqual(RECOVERY_FIXTURE);
  });

  it("calls the endpoint exactly once", async () => {
    const client = createMockClient(RECOVERY_FIXTURE);

    await getRecoveryCollection(client, {});

    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it("propagates API errors", async () => {
    const client = createMockClient(undefined);
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("WHOOP API error: 429 Too Many Requests")
    );

    await expect(getRecoveryCollection(client, {})).rejects.toThrow(
      "WHOOP API error: 429 Too Many Requests"
    );
  });
});
