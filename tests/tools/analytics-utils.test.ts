import { describe, it, expect } from "vitest";
import { percentile, circularStats } from "../../src/tools/stats-utils.js";
import { localDay } from "../../src/tools/analytics-utils.js";

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
});
