# Code Review Checkpoint 6: Task 11b — Enhanced Date Handling

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-05-29
> **Scope:** Task 11b — `src/tools/date-utils.ts` + `tests/tools/date-utils.test.ts`
> **Test suite:** 273 tests passing (16 files), typecheck clean, build clean, lint clean

---

## Verdict: ✅ APPROVE — 0 Critical, 1 Important, 3 Suggestions

**Overview:** A clean, well-structured pure utility with a correct strict-allowlist architecture. The core `resolveDateExpression` is solid — all supported expressions produce correct UTC date ranges, the regex patterns are safe from ReDoS, and the allowlist rejects anything not explicitly supported. One important gap in `validateDateRange`: it silently accepts `NaN` when given invalid date strings.

---

## Critical Issues

None.

---

## Important Issues

### 1. `validateDateRange` silently accepts invalid (NaN) date strings

- **File:** `src/tools/date-utils.ts:199-212`
- **Problem:** When `start` or `end` is not a parseable date, `new Date("garbage").getTime()` returns `NaN`. Both guards fail silently:
  - `NaN < NaN` → `false` (end-before-start check passes)
  - `NaN > 365` → `false` (max-days check passes)

  This means `validateDateRange("not-a-date", "also-not-a-date")` returns without throwing, defeating the function's purpose. While `resolveDateExpression` only produces valid dates, `validateDateRange` is an exported public API that may be called independently with ISO pass-through values (e.g., a user-supplied ISO string like `"2026-13-45"` that passes the format regex but produces `Invalid Date`).

- **Fix:**
  ```typescript
  export function validateDateRange(start: string, end: string, maxDays: number = 365): void {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();

    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      throw new InvalidDateExpression(
        `Invalid date string: start="${start}", end="${end}"`
      );
    }

    // ... existing checks
  }
  ```
  Add a test:
  ```typescript
  it("throws for unparseable date strings", () => {
    expect(() => validateDateRange("not-a-date", "2026-03-15T00:00:00.000Z")).toThrow(InvalidDateExpression);
    expect(() => validateDateRange("2026-03-01T00:00:00.000Z", "garbage")).toThrow(InvalidDateExpression);
  });
  ```

---

## Suggestions

### 1. Add test for singular "last 1 day" grammar

- **File:** `tests/tools/date-utils.test.ts`
- The regex `LAST_N_DAYS_REGEX` uses `days?` to accept both "days" and "day", but only `"last 1 days"` (plural) is tested. Adding a test for `"last 1 day"` would verify the singular path and document the supported grammar:
  ```typescript
  it('resolves "last 1 day" (singular)', () => {
    const result = resolveDateExpression("last 1 day");
    expect(result.start).toBe("2026-03-14T00:00:00.000Z");
  });
  ```

### 2. ISO 8601 regex accepts structurally valid but semantically invalid dates

- **File:** `src/tools/date-utils.ts:43-44`
- `ISO_8601_REGEX` matches format only — `"2026-13-45"` passes the regex (4 digits, dash, 2 digits, etc.) but is not a real date. Since these are pass-through values sent to the WHOOP API which will reject them, this is acceptable. However, combined with Important #1 above (NaN in `validateDateRange`), a caller doing `resolveDateExpression("2026-13-45")` → `validateDateRange(result.start, result.end)` would silently pass both checks. If Important #1 is fixed, this becomes moot — the NaN guard catches it downstream.

### 3. Spec lists `tests/fixtures/date-expressions.ts` as a file to create — not present

- **File:** `docs/plans/task-11-v2-feature-enhancements.md:140`
- The task spec lists `tests/fixtures/date-expressions.ts` in "Files to create" but it was not created. The tests work fine without it (test data is inline), but this is a deviation from the plan. Consider either creating the fixture file or updating the plan to reflect the decision to inline test data.

---

## What's Done Well

- **Strict allowlist architecture is exactly right.** No pattern matching on arbitrary input — every supported expression has its own explicit branch with a constrained regex or exact-string match. This eliminates injection vectors by design, not by sanitization.
- **UTC consistency is airtight.** Every date operation uses `Date.UTC`, `getUTCFullYear`, `getUTCMonth`, `getUTCDate`, `getUTCDay`. No path leaks local timezone. The helpers `startOfDayUTC` and `endOfDayUTC` centralize boundary construction, preventing inconsistency.
- **`getMondayUTC` handles the Sunday edge case correctly.** The `day === 0 ? 6 : day - 1` formula with the explanatory comment is clear and correct.
- **Leap year coverage is strong.** Two tests: "last month" from March 2024 (verifying Feb 29) and "last 365 days" from Feb 29 itself (verifying the year-spanning arithmetic). The `lastDayOfMonthUTC` helper using `Date.UTC(year, month + 1, 0)` handles leap years implicitly via the JavaScript Date engine.
- **Error messages are excellent.** The final fallthrough error lists all supported expressions, giving the AI model clear guidance on what to try instead. The `InvalidDateExpression` typed error class enables downstream handlers to distinguish parsing errors from network/API errors.
- **Tests use `vi.useFakeTimers` + `vi.setSystemTime` consistently.** All relative-date tests are deterministic. The fixed time (2026-03-15, a Sunday) was well-chosen — it exercises the Sunday edge case for `getMondayUTC` and February boundary for "last month".
- **Clean organization.** Both source and test files use section headers that mirror each other, making it easy to cross-reference. The module has zero dependencies beyond `Date` — a true pure utility.

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 34 tests covering all expressions, boundary cases, leap years, and error paths |
| Build verified | ✅ | `tsc` clean, `tsc --noEmit` clean |
| Security checked | ✅ | Strict regex allowlist, no ReDoS risk, no injection vectors |
| Coverage | ✅ | All code paths exercised; only gap is NaN path in `validateDateRange` |
| Lint | ✅ | No lint warnings |
| Acceptance criteria | ⚠️ | 14 of 15 criteria met; "future-resolving dates" met implicitly via allowlist (no expression can resolve to the future), but no explicit "tomorrow" test |

---

## Acceptance Criteria Checklist

| Criterion | Status | Notes |
|-----------|--------|-------|
| `resolveDateExpression("today")` → correct UTC start/end | ✅ | Tested with fixed time |
| `resolveDateExpression("yesterday")` → full previous day | ✅ | |
| `resolveDateExpression("last N days")` → correct range N=1..365 | ✅ | N=1, 7, 30, 365 tested |
| `resolveDateExpression("this week")` → Monday to today | ✅ | Sunday + Monday edge cases |
| `resolveDateExpression("last week")` → previous Mon–Sun | ✅ | |
| `resolveDateExpression("this month")` → 1st to today | ✅ | |
| `resolveDateExpression("last month")` → full previous month | ✅ | + January wrap + leap year |
| ISO 8601 pass-through | ✅ | date-only, date-time, offset |
| N > 365 → throws `InvalidDateExpression` | ✅ | N=366 tested |
| Future-resolving dates → throws | ✅ | Implicit — allowlist rejects "next week" (tested) |
| Unrecognized → throws `InvalidDateExpression` | ✅ | 4 cases tested |
| Case-insensitive matching | ✅ | "Today", "Last 30 Days" tested |
| `InvalidDateExpression` typed error exported | ✅ | 3 dedicated tests |
| `validateDateRange` validates range ≤ maxDays | ✅ | 7 tests |
| Leap year: "last 365 days" from Feb 29 | ✅ | Explicit test |

---

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Important | Add NaN guard to `validateDateRange` for invalid date strings | Fix before merge |
| 2 | Suggestion | Add test for singular "last 1 day" grammar | Backlog |
| 3 | Suggestion | Create fixture file or update plan to reflect inline test data decision | Backlog |
