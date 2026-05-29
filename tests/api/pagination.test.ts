import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAllPages } from "../../src/api/pagination.js";
import type { WhoopClient } from "../../src/api/client.js";
import type { PaginatedResponse } from "../../src/api/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockRecord {
  id: number;
  value: string;
}

function createMockClient(
  responses: Array<PaginatedResponse<MockRecord>>
): { client: WhoopClient; getMock: ReturnType<typeof vi.fn> } {
  const getMock = vi.fn();
  responses.forEach((response) => {
    getMock.mockResolvedValueOnce(response);
  });
  return {
    client: { get: getMock } as unknown as WhoopClient,
    getMock,
  };
}

function makeRecords(start: number, count: number): MockRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    id: start + i,
    value: `record-${start + i}`,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchAllPages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Basic functionality
  // -------------------------------------------------------------------------

  it("returns records from a single page with no next_token", async () => {
    const records = makeRecords(1, 5);
    const { client } = createMockClient([{ records }]);

    const result = await fetchAllPages<MockRecord>(client, "/v2/recovery");

    expect(result.records).toEqual(records);
    expect(result.truncated).toBe(false);
  });

  it("returns empty result for empty first page", async () => {
    const { client } = createMockClient([{ records: [] }]);

    const result = await fetchAllPages<MockRecord>(client, "/v2/recovery");

    expect(result.records).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("follows next_token across multiple pages", async () => {
    const page1 = makeRecords(1, 5);
    const page2 = makeRecords(6, 5);
    const page3 = makeRecords(11, 3);

    const { client, getMock } = createMockClient([
      { records: page1, next_token: "token_2" },
      { records: page2, next_token: "token_3" },
      { records: page3 },
    ]);

    const result = await fetchAllPages<MockRecord>(client, "/v2/recovery", {
      interPageDelayMs: 0,
    });

    expect(result.records).toEqual([...page1, ...page2, ...page3]);
    expect(result.truncated).toBe(false);
    expect(getMock).toHaveBeenCalledTimes(3);
  });

  it("passes next_token as query parameter", async () => {
    const { client, getMock } = createMockClient([
      { records: makeRecords(1, 5), next_token: "abc123" },
      { records: makeRecords(6, 3) },
    ]);

    await fetchAllPages<MockRecord>(client, "/v2/recovery", { interPageDelayMs: 0 });

    expect(getMock).toHaveBeenCalledWith("/v2/recovery?nextToken=abc123");
  });

  it("preserves existing query parameters when appending nextToken", async () => {
    const { client, getMock } = createMockClient([
      { records: makeRecords(1, 5), next_token: "abc123" },
      { records: makeRecords(6, 3) },
    ]);

    await fetchAllPages<MockRecord>(client, "/v2/recovery?start=2026-01-01&limit=25", {
      interPageDelayMs: 0,
    });

    expect(getMock).toHaveBeenNthCalledWith(1, "/v2/recovery?start=2026-01-01&limit=25");
    expect(getMock).toHaveBeenNthCalledWith(
      2,
      "/v2/recovery?start=2026-01-01&limit=25&nextToken=abc123"
    );
  });

  // -------------------------------------------------------------------------
  // maxRecords cap
  // -------------------------------------------------------------------------

  it("stops when maxRecords is reached and returns truncated=true", async () => {
    const { client, getMock } = createMockClient([
      { records: makeRecords(1, 10), next_token: "token_2" },
      { records: makeRecords(11, 10), next_token: "token_3" },
    ]);

    const result = await fetchAllPages<MockRecord>(client, "/v2/recovery", {
      maxRecords: 15,
      interPageDelayMs: 0,
    });

    // Should fetch page 1 (10 records) then page 2 (10 records), but trim to 15
    expect(result.records).toHaveLength(15);
    expect(result.truncated).toBe(true);
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it("stops fetching more pages once maxRecords reached from first page", async () => {
    const { client, getMock } = createMockClient([
      { records: makeRecords(1, 20), next_token: "token_2" },
    ]);

    const result = await fetchAllPages<MockRecord>(client, "/v2/recovery", {
      maxRecords: 10,
      interPageDelayMs: 0,
    });

    expect(result.records).toHaveLength(10);
    expect(result.truncated).toBe(true);
    // Should NOT fetch page 2 since we already have enough
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("defaults maxRecords to 100", async () => {
    // Create 11 pages of 10 records each (110 total)
    const responses: Array<PaginatedResponse<MockRecord>> = [];
    for (let i = 0; i < 11; i++) {
      responses.push({
        records: makeRecords(i * 10 + 1, 10),
        next_token: i < 10 ? `token_${i + 2}` : undefined,
      });
    }
    const { client } = createMockClient(responses);

    const result = await fetchAllPages<MockRecord>(client, "/v2/recovery", {
      interPageDelayMs: 0,
    });

    expect(result.records).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  // -------------------------------------------------------------------------
  // ABSOLUTE_MAX_RECORDS hard cap
  // -------------------------------------------------------------------------

  it("caps maxRecords at ABSOLUTE_MAX_RECORDS (500)", async () => {
    // Even if caller requests 1000, it should cap at 500
    const responses: Array<PaginatedResponse<MockRecord>> = [];
    for (let i = 0; i < 21; i++) {
      responses.push({
        records: makeRecords(i * 25 + 1, 25),
        next_token: i < 20 ? `token_${i + 2}` : undefined,
      });
    }
    const { client } = createMockClient(responses);

    const result = await fetchAllPages<MockRecord>(client, "/v2/recovery", {
      maxRecords: 1000,
      interPageDelayMs: 0,
    });

    expect(result.records.length).toBeLessThanOrEqual(500);
    expect(result.truncated).toBe(true);
  });

  // -------------------------------------------------------------------------
  // maxPages cap
  // -------------------------------------------------------------------------

  it("stops after maxPages and returns truncated=true", async () => {
    const responses: Array<PaginatedResponse<MockRecord>> = [];
    for (let i = 0; i < 5; i++) {
      responses.push({
        records: makeRecords(i * 5 + 1, 5),
        next_token: `token_${i + 2}`,
      });
    }
    const { client, getMock } = createMockClient(responses);

    const result = await fetchAllPages<MockRecord>(client, "/v2/recovery", {
      maxPages: 3,
      maxRecords: 500,
      interPageDelayMs: 0,
    });

    expect(getMock).toHaveBeenCalledTimes(3);
    expect(result.records).toHaveLength(15);
    expect(result.truncated).toBe(true);
  });

  it("defaults maxPages to 20", async () => {
    const responses: Array<PaginatedResponse<MockRecord>> = [];
    for (let i = 0; i < 25; i++) {
      responses.push({
        records: makeRecords(i * 3 + 1, 3),
        next_token: `token_${i + 2}`,
      });
    }
    const { client, getMock } = createMockClient(responses);

    const result = await fetchAllPages<MockRecord>(client, "/v2/recovery", {
      maxRecords: 500,
      interPageDelayMs: 0,
    });

    expect(getMock).toHaveBeenCalledTimes(20);
    expect(result.truncated).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Inter-page delay
  // -------------------------------------------------------------------------

  it("inserts inter-page delay between fetches", async () => {
    const { client, getMock } = createMockClient([
      { records: makeRecords(1, 5), next_token: "token_2" },
      { records: makeRecords(6, 5) },
    ]);

    const promise = fetchAllPages<MockRecord>(client, "/v2/recovery", {
      interPageDelayMs: 200,
    });

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(getMock).toHaveBeenCalledTimes(1);

    // After the delay, second call happens
    await vi.advanceTimersByTimeAsync(200);
    expect(getMock).toHaveBeenCalledTimes(2);

    const result = await promise;
    expect(result.records).toHaveLength(10);
  });

  it("defaults interPageDelayMs to 200", async () => {
    const { client, getMock } = createMockClient([
      { records: makeRecords(1, 5), next_token: "token_2" },
      { records: makeRecords(6, 5) },
    ]);

    const promise = fetchAllPages<MockRecord>(client, "/v2/recovery");

    await vi.advanceTimersByTimeAsync(0);
    expect(getMock).toHaveBeenCalledTimes(1);

    // Default 200ms delay
    await vi.advanceTimersByTimeAsync(199);
    expect(getMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(getMock).toHaveBeenCalledTimes(2);

    await promise;
  });

  // -------------------------------------------------------------------------
  // AbortSignal support
  // -------------------------------------------------------------------------

  it("stops mid-pagination when AbortSignal is aborted", async () => {
    const controller = new AbortController();
    const getMock = vi.fn()
      .mockImplementationOnce(async () => {
        // Abort after first page resolves
        controller.abort();
        return { records: makeRecords(1, 5), next_token: "token_2" };
      })
      .mockResolvedValueOnce({ records: makeRecords(6, 5), next_token: "token_3" })
      .mockResolvedValueOnce({ records: makeRecords(11, 5) });
    const client = { get: getMock } as unknown as WhoopClient;

    const result = await fetchAllPages<MockRecord>(client, "/v2/recovery", {
      signal: controller.signal,
      interPageDelayMs: 0,
    });

    expect(result.records).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("returns truncated=true when aborted before all pages fetched", async () => {
    const controller = new AbortController();
    controller.abort(); // Pre-abort

    const { client, getMock } = createMockClient([
      { records: makeRecords(1, 5), next_token: "token_2" },
    ]);

    const result = await fetchAllPages<MockRecord>(client, "/v2/recovery", {
      signal: controller.signal,
      interPageDelayMs: 0,
    });

    // Pre-aborted: first page still fetched (signal checked between pages), but stops before page 2
    expect(result.records).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  it("propagates WhoopApiError from client", async () => {
    const { WhoopApiError } = await import("../../src/api/client.js");
    const getMock = vi.fn().mockRejectedValue(new WhoopApiError(500, "Internal Server Error", {}));
    const client = { get: getMock } as unknown as WhoopClient;

    await expect(fetchAllPages<MockRecord>(client, "/v2/recovery")).rejects.toThrow(WhoopApiError);
  });

  it("propagates errors from mid-pagination failures", async () => {
    const { WhoopApiError } = await import("../../src/api/client.js");
    const getMock = vi
      .fn()
      .mockResolvedValueOnce({ records: makeRecords(1, 5), next_token: "token_2" })
      .mockRejectedValueOnce(new WhoopApiError(500, "Internal Server Error", {}));
    const client = { get: getMock } as unknown as WhoopClient;

    await expect(
      fetchAllPages<MockRecord>(client, "/v2/recovery", { interPageDelayMs: 0 })
    ).rejects.toThrow(WhoopApiError);
  });

  // -------------------------------------------------------------------------
  // Works with all collection endpoints
  // -------------------------------------------------------------------------

  it("works with sleep endpoint path", async () => {
    const { client, getMock } = createMockClient([{ records: makeRecords(1, 3) }]);

    await fetchAllPages<MockRecord>(client, "/v2/activity/sleep");

    expect(getMock).toHaveBeenCalledWith("/v2/activity/sleep");
  });

  it("works with workout endpoint path", async () => {
    const { client, getMock } = createMockClient([{ records: makeRecords(1, 3) }]);

    await fetchAllPages<MockRecord>(client, "/v2/activity/workout");

    expect(getMock).toHaveBeenCalledWith("/v2/activity/workout");
  });

  it("works with cycle endpoint path", async () => {
    const { client, getMock } = createMockClient([{ records: makeRecords(1, 3) }]);

    await fetchAllPages<MockRecord>(client, "/v2/cycle");

    expect(getMock).toHaveBeenCalledWith("/v2/cycle");
  });
});
