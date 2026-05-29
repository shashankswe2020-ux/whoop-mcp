/**
 * Tests for stats-utils.ts — statistical functions for analytical tools.
 *
 * Covers: mean, median, standardDeviation, linearRegression,
 * detectAnomalies, trendDirection. Edge cases: empty arrays,
 * single values, constant data, monotonic sequences.
 */

import { describe, it, expect } from "vitest";
import {
  mean,
  median,
  standardDeviation,
  linearRegression,
  detectAnomalies,
  trendDirection,
} from "../../src/tools/stats-utils.js";

// ---------------------------------------------------------------------------
// mean
// ---------------------------------------------------------------------------

describe("mean", () => {
  it("computes the arithmetic mean", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });

  it("handles a single value", () => {
    expect(mean([42])).toBe(42);
  });

  it("handles negative values", () => {
    expect(mean([-10, 10])).toBe(0);
  });

  it("handles decimal values", () => {
    expect(mean([1.5, 2.5, 3.0])).toBeCloseTo(2.333, 2);
  });

  it("throws for empty array", () => {
    expect(() => mean([])).toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// median
// ---------------------------------------------------------------------------

describe("median", () => {
  it("returns middle value for odd-length arrays", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("returns average of two middle values for even-length arrays", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("handles a single value", () => {
    expect(median([7])).toBe(7);
  });

  it("handles unsorted input", () => {
    expect(median([5, 1, 3, 2, 4])).toBe(3);
  });

  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it("throws for empty array", () => {
    expect(() => median([])).toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// standardDeviation
// ---------------------------------------------------------------------------

describe("standardDeviation", () => {
  it("computes population standard deviation", () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] → mean=5, pop stddev=2
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });

  it("returns 0 for constant values", () => {
    expect(standardDeviation([5, 5, 5, 5])).toBe(0);
  });

  it("returns 0 for a single value", () => {
    expect(standardDeviation([42])).toBe(0);
  });

  it("handles two values", () => {
    // [0, 10] → mean=5, variance=25, stddev=5
    expect(standardDeviation([0, 10])).toBe(5);
  });

  it("throws for empty array", () => {
    expect(() => standardDeviation([])).toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// linearRegression
// ---------------------------------------------------------------------------

describe("linearRegression", () => {
  it("returns positive slope for monotonically increasing values", () => {
    const result = linearRegression([1, 2, 3, 4, 5]);
    expect(result.slope).toBe(1);
    expect(result.r2).toBeCloseTo(1.0, 5);
  });

  it("returns negative slope for monotonically decreasing values", () => {
    const result = linearRegression([5, 4, 3, 2, 1]);
    expect(result.slope).toBe(-1);
    expect(result.r2).toBeCloseTo(1.0, 5);
  });

  it("returns zero slope for constant values", () => {
    const result = linearRegression([3, 3, 3, 3]);
    expect(result.slope).toBe(0);
    expect(result.r2).toBe(0);
  });

  it("returns slope and R² for noisy data", () => {
    // Slight upward trend with noise
    const result = linearRegression([1, 3, 2, 4, 3, 5]);
    expect(result.slope).toBeGreaterThan(0);
    expect(result.r2).toBeGreaterThan(0);
    expect(result.r2).toBeLessThanOrEqual(1);
  });

  it("handles two values", () => {
    const result = linearRegression([10, 20]);
    expect(result.slope).toBe(10);
    expect(result.r2).toBeCloseTo(1.0, 5);
  });

  it("returns zero slope and zero R² for single value", () => {
    const result = linearRegression([42]);
    expect(result.slope).toBe(0);
    expect(result.r2).toBe(0);
  });

  it("throws for empty array", () => {
    expect(() => linearRegression([])).toThrow(/empty/i);
  });

  it("returns NaN-safe results (no NaN in output)", () => {
    const result = linearRegression([5, 5, 5]);
    expect(Number.isNaN(result.slope)).toBe(false);
    expect(Number.isNaN(result.r2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectAnomalies
// ---------------------------------------------------------------------------

describe("detectAnomalies", () => {
  it("detects values more than 2σ from the mean by default", () => {
    // Mean=5, stddev=~1.58. Value 10 is >2σ away
    const values = [5, 5, 5, 5, 5, 10];
    const anomalies = detectAnomalies(values);

    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    expect(anomalies.some((a) => a.value === 10)).toBe(true);
  });

  it("returns empty array when no anomalies exist", () => {
    const anomalies = detectAnomalies([5, 5, 5, 5]);
    expect(anomalies).toEqual([]);
  });

  it("uses custom threshold", () => {
    // With threshold=1, more values become anomalies
    const values = [1, 2, 3, 4, 100];
    const anomalies1 = detectAnomalies(values, 1);
    const anomalies2 = detectAnomalies(values, 2);

    expect(anomalies1.length).toBeGreaterThanOrEqual(anomalies2.length);
  });

  it("returns correct index, value, and deviation", () => {
    // Mean=2, stddev=4, value 100 is clearly >2σ
    const values = [0, 0, 0, 0, 0, 100];
    const anomalies = detectAnomalies(values);

    const anomaly = anomalies.find((a) => a.value === 100);
    expect(anomaly).toBeDefined();
    expect(anomaly!.index).toBe(5);
    expect(anomaly!.deviation).toBeGreaterThan(0);
  });

  it("returns empty array for single value", () => {
    const anomalies = detectAnomalies([42]);
    expect(anomalies).toEqual([]);
  });

  it("returns empty array for constant values", () => {
    const anomalies = detectAnomalies([5, 5, 5, 5, 5]);
    expect(anomalies).toEqual([]);
  });

  it("throws for empty array", () => {
    expect(() => detectAnomalies([])).toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// trendDirection
// ---------------------------------------------------------------------------

describe("trendDirection", () => {
  it('returns "improving" for positive slope with high R²', () => {
    expect(trendDirection(0.5, 0.8)).toBe("improving");
  });

  it('returns "declining" for negative slope with high R²', () => {
    expect(trendDirection(-0.5, 0.8)).toBe("declining");
  });

  it('returns "stable" for zero slope', () => {
    expect(trendDirection(0, 0.9)).toBe("stable");
  });

  it('returns "stable" for low R² regardless of slope', () => {
    expect(trendDirection(5.0, 0.3)).toBe("stable");
    expect(trendDirection(-5.0, 0.1)).toBe("stable");
  });

  it('returns "stable" for medium R² with near-zero slope', () => {
    // R² between 0.4 and 0.7 — "medium confidence"
    // Near-zero slope (below 0.001 threshold) should be stable
    const result = trendDirection(0.0005, 0.5);
    expect(result).toBe("stable");
  });

  it("uses R² threshold boundaries correctly", () => {
    // R² = 0.4 exactly → low confidence → stable
    expect(trendDirection(10, 0.4)).toBe("stable");
    // R² = 0.41 → medium confidence → with significant slope, should give direction
    expect(trendDirection(10, 0.41)).toBe("improving");
    // R² = 0.7 exactly → medium → improving
    expect(trendDirection(10, 0.7)).toBe("improving");
  });
});
