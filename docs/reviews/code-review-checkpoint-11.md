# Code Review Checkpoint 11: v0.4.0 Quick Wins (get_today, get_calendar, Extended Dates)

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-05-31
> **Scope:** Task 12a–d — Extended date-utils, `get_today` composite tool, `get_calendar` grid tool, server integration
> **Test suite:** 501 tests passing (27 files), typecheck clean, build clean, lint clean

---

## Verdict: ✅ APPROVE with 2 Important issues

**Overview:** High-quality implementation. Date math is correctly clamped for month-end edge cases, sleep alignment uses the wake-up day as designed, and `Promise.allSettled` properly separates partial from total failures. Two important issues around `get_calendar`'s `start` parameter semantics and `get_today`'s throw threshold need attention before production use at scale.

---

## Critical Issues

None.

---

## Important Issues

### 1. `get_calendar` `start` parameter doesn't control the display grid

- **File:** `src/tools/get-calendar.ts:103-114`
- **Problem:** When `start` is provided, it only changes the API query's date filter — but the grid always shows the last `numDays` from today backward. This causes two problems:
  1. If `start` resolves to a date WITHIN the last N days (e.g., 3 days ago with `days: 7`), the API under-fetches and the first few grid days show null despite data existing.
  2. If `start` resolves to a date BEFORE `today - numDays`, extra data is fetched from the API but never displayed.

  The `period.start` in the response is always computed from `endDate - numDays + 1`, not from the actual `startDate`. The Zod schema describes it as "Start date" which implies it controls where the grid begins.

- **Fix:** Either:
  - (A) When `start` is provided, compute `numDays` as `(today - startDate) + 1` and override the `days` param (making them mutually influential):
    ```typescript
    if (params.start) {
      const resolved = resolveDateExpression(params.start);
      startDate = new Date(resolved.start);
      // Override numDays to span from start to today
      const diffMs = endDate.getTime() - startDate.getTime();
      numDays = Math.min(Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1, 90);
    }
    ```
  - (B) Document that `start` only filters the API query and the grid is always the last N days. Update the Zod description to clarify.
  - (C) Use `start` to define the grid origin, iterating forward from `startDate` for `numDays`.

### 2. `get_today` returns empty snapshot when 3 primaries fail but workout succeeds

- **File:** `src/tools/get-today.ts:128-132`
- **Problem:** The throw condition requires BOTH all primaries AND workout to fail: `if (allPrimaryFailed && workoutFailed)`. If recovery+sleep+cycle all fail but workout succeeds, the function returns `{recovery: null, sleep: null, strain: null, summary: "No data available yet today"}`. This is a useless response because workout data is only surfaced INSIDE the `strain` block, which requires cycle to succeed. The user gets no error and no data.

  The spec says "If ALL endpoints fail, throws error (not partial empty object)" — the spirit of this requirement is violated since the snapshot is effectively empty.

- **Fix:** Change the throw condition to only check the 3 primary endpoints:
  ```typescript
  if (allPrimaryFailed) {
    throw new Error("All API calls failed. Unable to retrieve today's health snapshot.");
  }
  ```
  Add a test: "throws when all 3 primary endpoints fail (even if workout succeeds)".

---

## Suggestions

### 1. `workout_count` is always 0 — dead placeholder field

- **File:** `src/tools/get-calendar.ts:178`
- The `workout_count` field is hard-coded to 0 with a comment "Workout count not available from cycle endpoint directly." This returns misleading data to consumers. Either populate it (fetch workouts endpoint) or remove the field from `CalendarDay` until it can be implemented. Hard-coded zeros look like real data.

### 2. No test coverage for `get_calendar` with `start` parameter

- **File:** `tests/tools/get-calendar.test.ts`
- The test suite tests `days` and default behavior but never exercises the `start` parameter path. The semantic confusion in Issue #1 above would have been caught with a test like:
  ```typescript
  it("uses start parameter to determine grid origin", async () => {
    const result = await getCalendar(client, { start: "2026-03-10" });
    expect(result.days[result.days.length - 1].date).toBe("2026-03-10");
  });
  ```

### 3. `YYYY-MM` regex allows unbounded years

- **File:** `src/tools/date-utils.ts:69`
- The regex `^(\d{4})-(0[1-9]|1[0-2])$` accepts years like `0001-01` or `9999-12`. While technically valid, WHOOP data only exists from ~2015 onward. Consider adding a year-range validation (e.g., 2010–2099) to catch typos like `0226-05` that would return empty results.

---

## What's Done Well

- **Month-clamping logic is correct and well-tested.** The `last 1 month` on March 31 → Feb 28 edge case is properly handled using `Math.min(targetDay, lastDay)` with the `Date.UTC(year, month+1, 0)` trick. Tests explicitly verify this with frozen timers.
- **Sleep assignment by wake-up day is cleanly implemented.** Using `s.end` for the date key and filtering out naps creates the correct WHOOP-consistent behavior. The test for midnight-crossing sleep is particularly good.
- **`Promise.allSettled` pattern in `get_today` is exemplary.** Clean separation of concerns — the fetch layer handles concurrency, the parse layer handles null propagation, and the summary layer handles presentation.
- **Comprehensive test coverage** — 62 new tests across 3 test files with fake timers, partial failure scenarios, unscored records, and boundary conditions.
- **Consistent patterns** — Both new tools follow the existing architecture (typed params, typed return, separate from server registration), making the codebase cohesive.

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 62 new tests — strong coverage of edge cases, partial failures, date math |
| Build verified | ✅ | typecheck, lint, build all clean |
| Security checked | ✅ | No user input reaches shell; Zod bounds `days` to 1–90; no secrets exposed |
| Coverage | ✅ | 501 tests passing (up from ~433 in v0.3.1) |
| Date math verified | ✅ | Month clamping, quarter boundaries, year wrap all correct |
| Pagination safety | ✅ | `maxRecords: numDays * 2` well under ABSOLUTE_MAX_RECORDS (500) |

---

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Important | `get_calendar` start param doesn't control display grid | v0.4.1 |
| 2 | Important | `get_today` returns empty snapshot instead of throwing when primaries all fail | v0.4.1 |
| 3 | Suggestion | Remove or populate `workout_count` field (currently always 0) | backlog |
| 4 | Suggestion | Add test for `get_calendar` with `start` parameter | v0.4.1 |
| 5 | Suggestion | Validate year range in YYYY-MM regex | backlog |
