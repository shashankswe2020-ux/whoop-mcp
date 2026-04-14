import { describe, it, expect, vi } from "vitest";
import { getCycleCollection } from "../../src/tools/get-cycle.js";
import type { CycleCollection } from "../../src/api/types.js";
import { ENDPOINT_CYCLE } from "../../src/api/endpoints.js";
import { createMockClient } from "../helpers/mock-client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CYCLE_FIXTURE: CycleCollection = {
  records: [
    {
      id: 200,
      user_id: 12345,
      created_at: "2026-04-10T00:00:00.000Z",
      updated_at: "2026-04-10T23:59:59.000Z",
      start: "2026-04-10T00:00:00.000Z",
      end: "2026-04-10T23:59:59.000Z",
      timezone_offset: "-04:00",
      score_state: "SCORED",
      score: {
        strain: 12.5,
        kilojoule: 9500,
        average_heart_rate: 68,
        max_heart_rate: 182,
      },
    },
  ],
  next_token: "cycle-page-2",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getCycleCollection", () => {
  it("calls the cycle endpoint with no query params when none provided", async () => {
    const client = createMockClient(CYCLE_FIXTURE);

    await getCycleCollection(client, {});

    expect(client.get).toHaveBeenCalledWith(ENDPOINT_CYCLE);
  });

  it("includes all params in query string when all provided", async () => {
    const client = createMockClient(CYCLE_FIXTURE);

    await getCycleCollection(client, {
      start: "2026-04-01T00:00:00.000Z",
      end: "2026-04-10T00:00:00.000Z",
      limit: 10,
      nextToken: "next-page",
    });

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const url = new URL(calledPath, "https://placeholder.test");

    expect(url.pathname).toBe(ENDPOINT_CYCLE);
    expect(url.searchParams.get("start")).toBe("2026-04-01T00:00:00.000Z");
    expect(url.searchParams.get("end")).toBe("2026-04-10T00:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("nextToken")).toBe("next-page");
  });

  it("omits undefined params from query string", async () => {
    const client = createMockClient(CYCLE_FIXTURE);

    await getCycleCollection(client, { end: "2026-04-10T00:00:00.000Z" });

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;

    expect(calledPath).not.toContain("start");
    expect(calledPath).not.toContain("limit");
    expect(calledPath).not.toContain("nextToken");
  });

  it("returns the cycle collection from the API", async () => {
    const client = createMockClient(CYCLE_FIXTURE);

    const result = await getCycleCollection(client, {});

    expect(result).toEqual(CYCLE_FIXTURE);
  });

  it("propagates API errors", async () => {
    const client = createMockClient(undefined);
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("WHOOP API error: 404 Not Found")
    );

    await expect(getCycleCollection(client, {})).rejects.toThrow("WHOOP API error: 404 Not Found");
  });
});
