/**
 * Tests for date-utils.ts — resolveDateExpression and validateDateRange.
 *
 * Covers: relative date expressions (today, yesterday, last N days,
 * this/last week, this/last month), ISO 8601 pass-through, error cases
 * (future dates, invalid expressions, N > 365), and validateDateRange.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveDateExpression,
  validateDateRange,
  InvalidDateExpression,
} from "../../src/tools/date-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fix "now" to a known date for deterministic tests.
 * All tests use 2026-03-15T12:00:00.000Z (a Sunday) unless noted otherwise.
 */
const FIXED_NOW = new Date("2026-03-15T12:00:00.000Z");

describe("InvalidDateExpression", () => {
  it("extends Error", () => {
    const error = new InvalidDateExpression("bad input");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(InvalidDateExpression);
  });

  it("has name 'InvalidDateExpression'", () => {
    const error = new InvalidDateExpression("bad");
    expect(error.name).toBe("InvalidDateExpression");
  });

  it("carries a descriptive message", () => {
    const error = new InvalidDateExpression("unrecognized: foo bar");
    expect(error.message).toBe("unrecognized: foo bar");
  });
});

describe("resolveDateExpression", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // ISO 8601 pass-through
  // -------------------------------------------------------------------------

  it("passes through ISO 8601 date-time strings unchanged", () => {
    const iso = "2026-01-15T00:00:00.000Z";
    const result = resolveDateExpression(iso);
    expect(result).toEqual({ start: iso, end: iso });
  });

  it("passes through ISO 8601 date-only strings unchanged", () => {
    const iso = "2026-01-15";
    const result = resolveDateExpression(iso);
    expect(result).toEqual({ start: iso, end: iso });
  });

  it("passes through ISO 8601 with timezone offset", () => {
    const iso = "2026-01-15T08:30:00+05:30";
    const result = resolveDateExpression(iso);
    expect(result).toEqual({ start: iso, end: iso });
  });

  // -------------------------------------------------------------------------
  // "today"
  // -------------------------------------------------------------------------

  it('resolves "today" to current day UTC boundaries', () => {
    const result = resolveDateExpression("today");
    expect(result.start).toBe("2026-03-15T00:00:00.000Z");
    expect(result.end).toBe("2026-03-15T23:59:59.999Z");
  });

  it('resolves "Today" (case-insensitive)', () => {
    const result = resolveDateExpression("Today");
    expect(result.start).toBe("2026-03-15T00:00:00.000Z");
    expect(result.end).toBe("2026-03-15T23:59:59.999Z");
  });

  // -------------------------------------------------------------------------
  // "yesterday"
  // -------------------------------------------------------------------------

  it('resolves "yesterday" to previous day UTC boundaries', () => {
    const result = resolveDateExpression("yesterday");
    expect(result.start).toBe("2026-03-14T00:00:00.000Z");
    expect(result.end).toBe("2026-03-14T23:59:59.999Z");
  });

  // -------------------------------------------------------------------------
  // "last N days"
  // -------------------------------------------------------------------------

  it('resolves "last 7 days" to 7-day range ending now', () => {
    const result = resolveDateExpression("last 7 days");
    expect(result.start).toBe("2026-03-08T00:00:00.000Z");
    expect(result.end).toBe("2026-03-15T23:59:59.999Z");
  });

  it('resolves "last 1 days" to single day range', () => {
    const result = resolveDateExpression("last 1 days");
    expect(result.start).toBe("2026-03-14T00:00:00.000Z");
    expect(result.end).toBe("2026-03-15T23:59:59.999Z");
  });

  it('resolves "last 1 day" (singular) to single day range', () => {
    const result = resolveDateExpression("last 1 day");
    expect(result.start).toBe("2026-03-14T00:00:00.000Z");
    expect(result.end).toBe("2026-03-15T23:59:59.999Z");
  });

  it('resolves "Last 30 Days" (case-insensitive)', () => {
    const result = resolveDateExpression("Last 30 Days");
    expect(result.start).toBe("2026-02-13T00:00:00.000Z");
    expect(result.end).toBe("2026-03-15T23:59:59.999Z");
  });

  it('resolves "last 365 days" (maximum allowed)', () => {
    const result = resolveDateExpression("last 365 days");
    expect(result.start).toBe("2025-03-15T00:00:00.000Z");
    expect(result.end).toBe("2026-03-15T23:59:59.999Z");
  });

  it('throws for "last 366 days" (exceeds 365 limit)', () => {
    expect(() => resolveDateExpression("last 366 days")).toThrow(InvalidDateExpression);
    expect(() => resolveDateExpression("last 366 days")).toThrow(/exceeds maximum/i);
  });

  it('throws for "last 0 days"', () => {
    expect(() => resolveDateExpression("last 0 days")).toThrow(InvalidDateExpression);
  });

  it('throws for "last -5 days"', () => {
    expect(() => resolveDateExpression("last -5 days")).toThrow(InvalidDateExpression);
  });

  // -------------------------------------------------------------------------
  // "this week"
  // -------------------------------------------------------------------------

  it('resolves "this week" to Monday 00:00 UTC to now', () => {
    // 2026-03-15 is a Sunday, so Monday of this week is 2026-03-09
    const result = resolveDateExpression("this week");
    expect(result.start).toBe("2026-03-09T00:00:00.000Z");
    expect(result.end).toBe("2026-03-15T23:59:59.999Z");
  });

  it('resolves "this week" when today is Monday', () => {
    // 2026-03-09 is a Monday
    vi.setSystemTime(new Date("2026-03-09T10:00:00.000Z"));
    const result = resolveDateExpression("this week");
    expect(result.start).toBe("2026-03-09T00:00:00.000Z");
    expect(result.end).toBe("2026-03-09T23:59:59.999Z");
  });

  // -------------------------------------------------------------------------
  // "last week"
  // -------------------------------------------------------------------------

  it('resolves "last week" to previous Monday–Sunday', () => {
    // 2026-03-15 is Sunday. Last week: Mon 2026-03-02 to Sun 2026-03-08
    const result = resolveDateExpression("last week");
    expect(result.start).toBe("2026-03-02T00:00:00.000Z");
    expect(result.end).toBe("2026-03-08T23:59:59.999Z");
  });

  // -------------------------------------------------------------------------
  // "this month"
  // -------------------------------------------------------------------------

  it('resolves "this month" to 1st of month to today end-of-day', () => {
    const result = resolveDateExpression("this month");
    expect(result.start).toBe("2026-03-01T00:00:00.000Z");
    expect(result.end).toBe("2026-03-15T23:59:59.999Z");
  });

  // -------------------------------------------------------------------------
  // "last month"
  // -------------------------------------------------------------------------

  it('resolves "last month" to full previous month', () => {
    // Current: March 2026 → Last month: Feb 2026 (28 days, non-leap)
    const result = resolveDateExpression("last month");
    expect(result.start).toBe("2026-02-01T00:00:00.000Z");
    expect(result.end).toBe("2026-02-28T23:59:59.999Z");
  });

  it('resolves "last month" correctly for January (wraps to December)', () => {
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    const result = resolveDateExpression("last month");
    expect(result.start).toBe("2025-12-01T00:00:00.000Z");
    expect(result.end).toBe("2025-12-31T23:59:59.999Z");
  });

  // -------------------------------------------------------------------------
  // Leap year handling
  // -------------------------------------------------------------------------

  it("handles leap year February correctly", () => {
    // March 2024 → last month is Feb 2024 (leap year = 29 days)
    vi.setSystemTime(new Date("2024-03-15T12:00:00.000Z"));
    const result = resolveDateExpression("last month");
    expect(result.start).toBe("2024-02-01T00:00:00.000Z");
    expect(result.end).toBe("2024-02-29T23:59:59.999Z");
  });

  it('"last 365 days" starting from Feb 29 leap year works', () => {
    vi.setSystemTime(new Date("2024-02-29T12:00:00.000Z"));
    const result = resolveDateExpression("last 365 days");
    // 365 days before 2024-02-29 is 2023-03-01
    expect(result.start).toBe("2023-03-01T00:00:00.000Z");
    expect(result.end).toBe("2024-02-29T23:59:59.999Z");
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  it("throws InvalidDateExpression for unrecognized expressions", () => {
    expect(() => resolveDateExpression("next week")).toThrow(InvalidDateExpression);
    expect(() => resolveDateExpression("2 weeks ago")).toThrow(InvalidDateExpression);
    expect(() => resolveDateExpression("foo bar")).toThrow(InvalidDateExpression);
    expect(() => resolveDateExpression("")).toThrow(InvalidDateExpression);
  });

  it("throws InvalidDateExpression with descriptive message for unknown input", () => {
    expect(() => resolveDateExpression("random text")).toThrow(
      /unrecognized date expression/i
    );
  });

  it("throws for whitespace-only input", () => {
    expect(() => resolveDateExpression("   ")).toThrow(InvalidDateExpression);
  });
});

// ---------------------------------------------------------------------------
// validateDateRange
// ---------------------------------------------------------------------------

describe("validateDateRange", () => {
  it("does not throw for a valid range within maxDays", () => {
    expect(() =>
      validateDateRange("2026-03-01T00:00:00.000Z", "2026-03-10T23:59:59.999Z")
    ).not.toThrow();
  });

  it("does not throw for exactly maxDays", () => {
    expect(() =>
      validateDateRange("2025-03-15T00:00:00.000Z", "2026-03-15T00:00:00.000Z", 365)
    ).not.toThrow();
  });

  it("throws InvalidDateExpression when range exceeds maxDays", () => {
    expect(() =>
      validateDateRange("2025-01-01T00:00:00.000Z", "2026-03-15T00:00:00.000Z", 365)
    ).toThrow(InvalidDateExpression);
    expect(() =>
      validateDateRange("2025-01-01T00:00:00.000Z", "2026-03-15T00:00:00.000Z", 365)
    ).toThrow(/exceeds maximum/i);
  });

  it("defaults maxDays to 365", () => {
    // 400-day range should fail with default
    expect(() =>
      validateDateRange("2025-01-01T00:00:00.000Z", "2026-02-05T00:00:00.000Z")
    ).toThrow(InvalidDateExpression);
  });

  it("accepts custom maxDays", () => {
    expect(() =>
      validateDateRange("2026-03-01T00:00:00.000Z", "2026-03-15T00:00:00.000Z", 90)
    ).not.toThrow();
  });

  it("throws for custom maxDays exceeded", () => {
    expect(() =>
      validateDateRange("2026-01-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z", 90)
    ).toThrow(InvalidDateExpression);
  });

  it("throws for end before start", () => {
    expect(() =>
      validateDateRange("2026-03-15T00:00:00.000Z", "2026-03-01T00:00:00.000Z")
    ).toThrow(InvalidDateExpression);
    expect(() =>
      validateDateRange("2026-03-15T00:00:00.000Z", "2026-03-01T00:00:00.000Z")
    ).toThrow(/end.*before.*start/i);
  });

  it("throws for unparseable date strings (NaN guard)", () => {
    expect(() => validateDateRange("not-a-date", "2026-03-15T00:00:00.000Z")).toThrow(
      InvalidDateExpression
    );
    expect(() => validateDateRange("2026-03-01T00:00:00.000Z", "garbage")).toThrow(
      InvalidDateExpression
    );
    expect(() => validateDateRange("nope", "nope")).toThrow(/invalid date string/i);
  });
});
