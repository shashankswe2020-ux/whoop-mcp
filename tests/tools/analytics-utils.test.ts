import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { percentile, circularStats } from "../../src/tools/stats-utils.js";
import { localDay, localTime, loadAnalyticsSource } from "../../src/tools/analytics-utils.js";
import type { WhoopClient } from "../../src/api/client.js";

describe("analytics primitives", () => {
  it("interpolates percentiles without mutating values", () => {
    const values = [30, 0, 10, 20];
    expect(percentile(values, 25)).toBe(7.5);
    expect(percentile(values, 0)).toBe(0);
    expect(percentile(values, 100)).toBe(30);
    expect(values).toEqual([30, 0, 10, 20]);
    expect(() => percentile([], 50)).toThrow();
    expect(() => percentile([1], 101)).toThrow();
    expect(() => percentile([NaN], 50)).toThrow();
  });
  it("handles midnight and undefined antipodal means", () => {
    const result = circularStats([1430, 10]);
    expect(Math.min(result.mean!, 1440 - result.mean!)).toBeCloseTo(0);
    expect(result.sd).toBeCloseTo(10, 0);
    expect(circularStats([0, 720])).toEqual({ mean: null, sd: null });
    expect(circularStats([])).toEqual({ mean: null, sd: null });
  });
  it("uses the recorded offset rather than the host timezone", () => {
    expect(localDay("2026-09-10T01:00:00Z", "-05:00")).toBe("2026-09-09");
    expect(localDay("2026-03-08T06:30:00Z", "-05:00")).toBe("2026-03-08");
    expect(localDay("2026-11-01T06:30:00Z", "-04:00")).toBe("2026-11-01");
  });
  it("treats a Z offset as UTC", () => {
    expect(localTime("2026-10-05T23:30:00.000Z", "Z")).toEqual(
      localTime("2026-10-05T23:30:00.000Z", "+00:00")
    );
    expect(localDay("2026-10-05T23:30:00.000Z", "Z")).toBe("2026-10-05");
    expect(() => localTime("2026-10-05T23:30:00.000Z", "UTC")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadAnalyticsSource's internal `pageSchema` is a THIRD, independent
// declaration of the same next_token schema that output-contracts.ts's
// `collection()` has (and record-schemas.ts's optional score fields have) —
// this is what get_today, get_baselines, get_trend, get_weekly_summary,
// compare_periods, and get_sleep_debt all fetch through. Before this fix,
// any of those tools would throw on a request whose data fit on one page,
// since WHOOP returns `next_token: null` rather than omitting the key.
// ---------------------------------------------------------------------------

describe("loadAnalyticsSource", () => {
  const recordSchema = z.object({ id: z.number() });

  function mockClient(response: unknown): WhoopClient {
    return { get: vi.fn().mockResolvedValue(response) } as unknown as WhoopClient;
  }

  it("succeeds when the API returns next_token: null (single/last page)", async () => {
    const client = mockClient({ records: [{ id: 1 }, { id: 2 }], next_token: null });
    const result = await loadAnalyticsSource(
      client,
      "/v2/recovery",
      { start: "2026-09-25T00:00:00.000Z", end: "2026-09-28T00:00:00.000Z" },
      recordSchema
    );
    expect(result.quality.status).not.toBe("invalid");
    expect(result.records).toHaveLength(2);
  });

  it("succeeds when next_token is omitted entirely", async () => {
    const client = mockClient({ records: [{ id: 1 }] });
    const result = await loadAnalyticsSource(
      client,
      "/v2/recovery",
      { start: "2026-09-25T00:00:00.000Z", end: "2026-09-28T00:00:00.000Z" },
      recordSchema
    );
    expect(result.quality.status).not.toBe("invalid");
    expect(result.records).toHaveLength(1);
  });
});
