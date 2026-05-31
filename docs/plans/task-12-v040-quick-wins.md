# Task 12: v0.4.0 — Quick Wins (get_today, get_calendar, Extended Dates)

> **Spec:** `docs/specs/v3-platform-enhancements.md` (Features 1–3)
> **Depends on:** V2 complete (v0.3.1 shipped, 433 tests, 98.55% coverage)
> **Created:** 2026-05-31

---

## Overview

Three new capabilities that dramatically improve the demo experience and daily-use UX: a composite "today" snapshot, a multi-day calendar grid, and extended natural language date parsing. All three are low-risk additions that build on existing infrastructure (pagination, date-utils, stats-utils) without touching auth, transport, or server shell.

## Architecture Decisions

1. **`get_today` uses `Promise.allSettled` for parallel-with-partial-failure** — Three independent API calls execute concurrently. If one fails, the others still return. Only if ALL fail does the tool throw.

2. **`get_calendar` reuses `fetchAllPages` for each endpoint stream** — The three endpoint streams (recovery, sleep, cycle) paginate in parallel using `Promise.all([fetchAllPages(...), ...])`. Pagination within each stream is serial (next_token chaining).

3. **Date-utils extension is purely additive** — New regex patterns added to the existing allowlist. No modifications to existing patterns or the `resolveDateExpression()` API. Fully backward-compatible.

4. **Sleep day alignment rule** — Sleep assigned to the calendar day of the `end` timestamp (wake-up day). This matches WHOOP's own UI behavior.

5. **`last_workout` extracted from cycle data, not a separate API call** — The cycle endpoint returns workout metadata within the cycle record. No additional fetch needed.

---

## Dependency Graph

```
┌────────────────────────┐
│ 12a. Extended dates    │  ← Foundation (no deps)
└───────────┬────────────┘
            │
┌───────────▼────────────┐    ┌────────────────────────┐
│ 12b. get_today         │    │ 12c. get_calendar      │
│  (uses date-utils for  │    │  (uses date-utils +    │
│   summary only)        │    │   fetchAllPages)       │
└────────────────────────┘    └────────────────────────┘
            │                             │
            └──────────┬──────────────────┘
                       │
            ┌──────────▼──────────────┐
            │ 12d. Server integration │
            │  + verification         │
            └─────────────────────────┘
```

**Parallelism:** Tasks 12b and 12c can be implemented in parallel after 12a completes.

---

## Task List

### Task 12a: Extended Natural Language Dates

**Description:** Add 6 new date expression patterns to `src/tools/date-utils.ts`: "last N weeks", "last N months", "this quarter", "last quarter", "last year", and "YYYY-MM" month literals.

**Acceptance criteria:**
- [ ] `"last 2 weeks"` → 14 days back from now (UTC)
- [ ] `"last 3 months"` → 3 calendar months back (handles variable month lengths)
- [ ] `"this quarter"` → correct Q start to now (Q1=Jan, Q2=Apr, Q3=Jul, Q4=Oct)
- [ ] `"last quarter"` → previous quarter full range
- [ ] `"last year"` → Jan 1 to Dec 31 of previous year
- [ ] `"2026-05"` → May 1 00:00Z to May 31 23:59:59.999Z
- [ ] N > 52 weeks rejected → `InvalidDateExpression`
- [ ] N > 12 months rejected → `InvalidDateExpression`
- [ ] Case-insensitive: `"Last 2 Weeks"` works
- [ ] All existing date expressions still work (no regression)
- [ ] Edge case: "last 1 month" on March 31 (February has fewer days)

**Verification:** `npm test -- tests/tools/date-utils.test.ts`

**Dependencies:** None

**Files:**
- `src/tools/date-utils.ts` (modify — add 6 regex patterns + handlers)
- `tests/tools/date-utils.test.ts` (modify — add tests with `vi.useFakeTimers()`)

**Estimated scope:** Small (2 files)

---

### Task 12b: `get_today` Composite Tool

**Description:** New tool that fetches today's recovery, last night's sleep, and current cycle strain in parallel, returning a unified snapshot with a human-readable summary.

**Acceptance criteria:**
- [ ] Returns combined data from 3 endpoints in a single response
- [ ] All 3 API calls made in parallel (`Promise.allSettled`)
- [ ] If one endpoint fails, others still return (partial result with null)
- [ ] If ALL endpoints fail, throws error (not partial empty object)
- [ ] `summary` string generated from available data (handles null gracefully)
- [ ] `last_workout` populated from cycle's most recent workout (no extra API call)
- [ ] Response includes `timestamp` (ISO 8601 when snapshot was taken)
- [ ] Zod schema: empty object input (no params)
- [ ] No new OAuth scopes required
- [ ] Handles user with no sleep data yet (null sleep, null recovery, cycle-only)

**Verification:** `npm test -- tests/tools/get-today.test.ts`

**Dependencies:** None (uses existing API client patterns)

**Files:**
- `src/tools/get-today.ts` (create)
- `tests/tools/get-today.test.ts` (create)

**Estimated scope:** Medium (2 new files + server registration)

---

### Task 12c: `get_calendar` Grid Tool

**Description:** New tool that returns a multi-day grid view with recovery scores, sleep hours, and strain per day. Uses auto-pagination for ranges > 25 records and resolves natural language date inputs.

**Acceptance criteria:**
- [ ] Default 7 days when no `days` param provided
- [ ] Uses `fetchAllPages` internally for ranges > 25 records
- [ ] Sleep assigned to calendar day of `end` timestamp (wake-up day)
- [ ] Sleep spanning midnight correctly assigned to wake-up day
- [ ] Days with no data get null values (not omitted from array)
- [ ] `recovery_zone` computed: green >= 67, yellow >= 34, red < 34
- [ ] `averages` computed from non-null values only
- [ ] Rejects `days` > 90 at Zod validation layer
- [ ] Supports natural language dates in `start` param
- [ ] Three endpoint streams paginated in parallel; pagination within each serial
- [ ] Edge case: brand new user with 0 days of data → empty `days` array

**Verification:** `npm test -- tests/tools/get-calendar.test.ts`

**Dependencies:** Task 12a (natural language dates for `start` param)

**Files:**
- `src/tools/get-calendar.ts` (create)
- `tests/tools/get-calendar.test.ts` (create)

**Estimated scope:** Medium (2 new files, moderate alignment logic)

---

### Task 12d: Server Integration + Verification

**Description:** Register both new tools on the MCP server, add integration tests verifying tool listing, and run full verification suite.

**Acceptance criteria:**
- [ ] `get_today` appears in tool listing
- [ ] `get_calendar` appears in tool listing
- [ ] Both tools callable through MCP server with mock client
- [ ] All existing tests pass (no regression)
- [ ] TypeScript compiles cleanly
- [ ] Build succeeds
- [ ] Lint clean

**Verification:** `npm test && npm run typecheck && npm run build && npm run lint`

**Dependencies:** Tasks 12a, 12b, 12c

**Files:**
- `src/server.ts` (modify — register new tools)
- `tests/server.test.ts` (modify — add integration tests)

**Estimated scope:** Small (2 files modified)

---

## Checkpoint: After Task 12d

- [ ] All tests pass (`npm test`)
- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] Build succeeds (`npm run build`)
- [ ] Lint clean (`npm run lint`)
- [ ] `get_today` returns parallel-fetched snapshot with summary
- [ ] `get_calendar` returns correct day grid with sleep alignment
- [ ] 6 new date expressions work, existing ones preserved
- [ ] Tool count: 14 (12 existing + 2 new)
- [ ] Coverage: ≥ 90% on new files

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| WHOOP cycle endpoint doesn't include workout details in response | Medium | Check actual response shape first; if missing, add optional `get_workout_collection(limit=1)` call |
| Sleep alignment edge cases (timezone, naps) | Low | Use UTC-only, assign by `end` timestamp, test with fixture data |
| `fetchAllPages` race condition with 3 parallel streams | Low | Each stream uses independent pagination state; tested in V2 |
| "last 1 month" from March 31 → Feb 28 or 31? | Low | Use `setMonth(m - N)` which handles overflow; add explicit test |

---

## Files Delivered

| File | Action | Description |
|------|--------|-------------|
| `src/tools/date-utils.ts` | Modify | Add 6 new regex patterns + handlers |
| `src/tools/get-today.ts` | Create | Composite tool with parallel fetches |
| `src/tools/get-calendar.ts` | Create | Grid tool with pagination + alignment |
| `src/server.ts` | Modify | Register 2 new tools |
| `tests/tools/date-utils.test.ts` | Modify | Tests for new patterns |
| `tests/tools/get-today.test.ts` | Create | Unit + partial failure tests |
| `tests/tools/get-calendar.test.ts` | Create | Unit + alignment + edge case tests |
| `tests/server.test.ts` | Modify | Integration tests for new tools |
