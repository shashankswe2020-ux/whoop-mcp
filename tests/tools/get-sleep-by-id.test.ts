import { describe, it, expect, vi } from "vitest";
import { getSleepById } from "../../src/tools/get-sleep-by-id.js";
import { ENDPOINT_SLEEP } from "../../src/api/endpoints.js";
import type { Sleep } from "../../src/api/types.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schema (mirrors server.ts registration)
// ---------------------------------------------------------------------------

const stringIdSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SLEEP_FIXTURE: Sleep = {
  id: "sleep-abc-123",
  cycle_id: 100,
  user_id: 12345,
  created_at: "2026-04-10T06:00:00.000Z",
  updated_at: "2026-04-10T06:30:00.000Z",
  start: "2026-04-09T23:00:00.000Z",
  end: "2026-04-10T06:00:00.000Z",
  timezone_offset: "-04:00",
  nap: false,
  score_state: "SCORED",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getSleepById", () => {
  it("calls the correct endpoint with the given ID", async () => {
    const getMock = vi.fn().mockResolvedValue(SLEEP_FIXTURE);
    const client = { get: getMock } as never;

    await getSleepById(client, "sleep-abc-123");

    expect(getMock).toHaveBeenCalledWith(
      `${ENDPOINT_SLEEP}/${encodeURIComponent("sleep-abc-123")}`
    );
  });

  it("returns the sleep record", async () => {
    const getMock = vi.fn().mockResolvedValue(SLEEP_FIXTURE);
    const client = { get: getMock } as never;

    const result = await getSleepById(client, "sleep-abc-123");

    expect(result).toEqual(SLEEP_FIXTURE);
  });

  it("encodes special characters in the ID", async () => {
    const getMock = vi.fn().mockResolvedValue(SLEEP_FIXTURE);
    const client = { get: getMock } as never;

    await getSleepById(client, "id-with_underscore");

    expect(getMock).toHaveBeenCalledWith(
      `${ENDPOINT_SLEEP}/${encodeURIComponent("id-with_underscore")}`
    );
  });

  it("propagates errors from the client", async () => {
    const { WhoopApiError } = await import("../../src/api/client.js");
    const getMock = vi.fn().mockRejectedValue(new WhoopApiError(404, "Not Found", {}));
    const client = { get: getMock } as never;

    await expect(getSleepById(client, "nonexistent")).rejects.toThrow(WhoopApiError);
  });
});

describe("sleep ID validation (Zod schema)", () => {
  it("rejects path traversal attempts", () => {
    expect(() => stringIdSchema.parse({ id: "../../admin" })).toThrow();
    expect(() => stringIdSchema.parse({ id: "foo/bar" })).toThrow();
    expect(() => stringIdSchema.parse({ id: "id/../secret" })).toThrow();
  });

  it("rejects IDs with special characters", () => {
    expect(() => stringIdSchema.parse({ id: "id with spaces" })).toThrow();
    expect(() => stringIdSchema.parse({ id: "id&param=val" })).toThrow();
    expect(() => stringIdSchema.parse({ id: "" })).toThrow();
  });

  it("accepts valid IDs", () => {
    expect(stringIdSchema.parse({ id: "sleep-abc-123" })).toEqual({ id: "sleep-abc-123" });
    expect(stringIdSchema.parse({ id: "abc_def" })).toEqual({ id: "abc_def" });
    expect(stringIdSchema.parse({ id: "ABC123" })).toEqual({ id: "ABC123" });
  });
});
