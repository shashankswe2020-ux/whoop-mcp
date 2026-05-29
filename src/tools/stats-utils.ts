/**
 * Pure statistical utility functions for analytical tools.
 *
 * All functions operate on number arrays. Empty arrays throw.
 * No NaN propagation — edge cases return defined values.
 * No runtime dependencies.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function assertNonEmpty(values: number[], name: string): void {
  if (values.length === 0) {
    throw new Error(`${name}: cannot operate on an empty array`);
  }
}

// ---------------------------------------------------------------------------
// Basic statistics
// ---------------------------------------------------------------------------

/**
 * Arithmetic mean.
 * @throws Error if values is empty
 */
export function mean(values: number[]): number {
  assertNonEmpty(values, "mean");
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

/**
 * Median — middle value (average of two middle for even-length).
 * Does not mutate the input array.
 * @throws Error if values is empty
 */
export function median(values: number[]): number {
  assertNonEmpty(values, "median");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/**
 * Population standard deviation.
 * Returns 0 for a single value or constant array.
 * @throws Error if values is empty
 */
export function standardDeviation(values: number[]): number {
  assertNonEmpty(values, "standardDeviation");
  if (values.length === 1) {
    return 0;
  }
  const avg = mean(values);
  let sumSquaredDiffs = 0;
  for (const v of values) {
    const diff = v - avg;
    sumSquaredDiffs += diff * diff;
  }
  return Math.sqrt(sumSquaredDiffs / values.length);
}

// ---------------------------------------------------------------------------
// Linear regression
// ---------------------------------------------------------------------------

/** Result of linear regression */
export interface LinearRegressionResult {
  /** Slope per unit index */
  slope: number;
  /** R² goodness of fit (0–1) */
  r2: number;
}

/**
 * Simple linear regression on values indexed 0, 1, 2, ...
 *
 * Returns slope (change per index) and R² (coefficient of determination).
 * Single value or constant values return { slope: 0, r2: 0 }.
 *
 * @throws Error if values is empty
 */
export function linearRegression(values: number[]): LinearRegressionResult {
  assertNonEmpty(values, "linearRegression");
  const n = values.length;

  if (n === 1) {
    return { slope: 0, r2: 0 };
  }

  // x = 0, 1, 2, ..., n-1
  // Sum of x = n*(n-1)/2
  // Sum of x² = n*(n-1)*(2n-1)/6
  const sumX = (n * (n - 1)) / 2;
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;

  let sumY = 0;
  let sumXY = 0;
  for (let i = 0; i < n; i++) {
    sumY += values[i]!;
    sumXY += i * values[i]!;
  }

  const denominator = n * sumX2 - sumX * sumX;

  // denominator is 0 only if all x values are identical (impossible with 0..n-1 and n>1)
  // but guard anyway for NaN safety
  if (denominator === 0) {
    return { slope: 0, r2: 0 };
  }

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  // Compute R²
  const yMean = sumY / n;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const diff = values[i]! - yMean;
    ssTot += diff * diff;
    const predicted = intercept + slope * i;
    const residual = values[i]! - predicted;
    ssRes += residual * residual;
  }

  // If ssTot is 0 (constant values), R² is undefined — return 0
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { slope, r2 };
}

// ---------------------------------------------------------------------------
// Anomaly detection
// ---------------------------------------------------------------------------

/** A detected anomaly */
export interface Anomaly {
  /** Index in the input array */
  index: number;
  /** The anomalous value */
  value: number;
  /** Number of standard deviations from the mean */
  deviation: number;
}

/**
 * Detect values more than `threshold` standard deviations from the mean.
 *
 * Returns empty array for constant values or single value (stddev=0).
 *
 * @param values - Data points
 * @param threshold - Number of σ for anomaly detection (default: 2)
 * @throws Error if values is empty
 */
export function detectAnomalies(values: number[], threshold: number = 2): Anomaly[] {
  assertNonEmpty(values, "detectAnomalies");

  const avg = mean(values);
  const stdDev = standardDeviation(values);

  // No anomalies possible when stddev is 0 (constant or single value)
  if (stdDev === 0) {
    return [];
  }

  const anomalies: Anomaly[] = [];
  for (let i = 0; i < values.length; i++) {
    const deviation = Math.abs(values[i]! - avg) / stdDev;
    if (deviation > threshold) {
      anomalies.push({ index: i, value: values[i]!, deviation });
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Trend direction
// ---------------------------------------------------------------------------

/** Trend direction classification */
export type TrendDirectionResult = "improving" | "declining" | "stable";

/**
 * Classify a trend based on slope and R².
 *
 * R² thresholds:
 * - ≤ 0.4: low confidence → always "stable"
 * - > 0.4: sufficient confidence → use slope sign
 *
 * Near-zero slopes (|slope| < 0.001) are always "stable".
 */
export function trendDirection(slope: number, r2: number): TrendDirectionResult {
  // Low confidence — no meaningful trend
  if (r2 <= 0.4) {
    return "stable";
  }

  // Near-zero slope — stable regardless of R²
  if (Math.abs(slope) < 0.001) {
    return "stable";
  }

  return slope > 0 ? "improving" : "declining";
}
