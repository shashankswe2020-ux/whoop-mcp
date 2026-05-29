# Task 11: V2 Feature Enhancements — Implementation Plan

> **Spec:** `docs/specs/v2-feature-enhancements.md`
> **Depends on:** Tasks 1–10 complete (212 tests passing, v0.2.1 shipped)
> **Created:** 2026-05-29
> **Reviews:** code-review-checkpoint-4, security-audit-4 feedback incorporated

---

## Overview

Implement 6 features that expand the WHOOP MCP server from 6 tools to 12 tools, add 4 MCP Resources, and add 5 MCP Prompts. The features are: auto-pagination utility, enhanced date handling, individual record lookup tools, statistical utilities, MCP Resources, analytical tools, and MCP Prompts.

## Architecture Decisions

1. **Auto-pagination is an internal utility, not an exposed tool** — `fetchAllPages` lives in `src/api/pagination.ts` and is consumed by analytical tools only. Existing collection tools retain single-page behavior (no breaking change).

2. **Date parsing is a pure utility applied at the tool layer** — `src/tools/date-utils.ts` exports a `resolveDateExpression()` function. Tool handlers call it before passing params to the API client. The API client remains unaware of relative dates.

3. **Resources use a simple in-memory cache with TTL** — No external cache (Redis, file-based). A `Map<string, { data, expiry }>` with deduplication of in-flight requests. Cache invalidates after TTL (5 min for dynamic, 1 hr for profile). Cache invalidated on token refresh.

4. **Analytical tools serialize multi-endpoint pagination** — `get_weekly_summary` calls recovery → sleep → workout → cycle sequentially (not concurrently) to respect rate limits. Each endpoint uses `fetchAllPages` with the global budget.

5. **Statistical calculations are pure TypeScript** — Linear regression, mean, median, std deviation implemented in a `src/tools/stats-utils.ts` utility. No runtime dependencies.

6. **MCP Prompts are static message templates** — No dynamic data fetching in prompt generation. Prompts return structured messages that reference tools/resources for the AI client to resolve.

7. **New endpoints added to `src/api/endpoints.ts`** — Individual record lookup endpoints (`/v2/activity/sleep/{id}`, etc.) follow existing pattern.

8. **Rate limit safety hardcoded** — `ABSOLUTE_MAX_RECORDS = 500` constant prevents caller override. Inter-page delay (200ms) and max-pages (20) cap are additional guards.

---

## Dependency Graph

```
  ┌────────────────┐  ┌────────────────┐  ┌────────────┐  ┌───────────────┐  ┌────────────────┐
  │ 11a. Auto-     │  │ 11b. Date      │  │ 11c. ID    │  │ 11d. Stats    │  │ 11e. MCP       │
  │  Pagination    │  │  Utils         │  │  Lookup    │  │  Utils        │  │  Resources     │
  └───────┬────────┘  └───────┬────────┘  └────────────┘  └───────┬───────┘  └────────────────┘
          │                   │                                    │
          │                   │  ALL PHASE 1 TASKS INDEPENDENT     │
          │                   │                                    │
          └─────────┬─────────┴────────────────────────────────────┘
                    │
     ┌──────────────▼───────────────────┐
     │ 11f-i. get_weekly_summary        │  (first analytical tool — establishes pattern)
     └──────────────┬───────────────────┘
                    │
     ┌──────────────▼───────────────────┐   ┌───────────────────────────────┐
     │ 11f-ii. compare_periods          │   │ 11f-iii. get_trend            │
     └──────────────┬───────────────────┘   └───────────────┬───────────────┘
                    │         (11f-ii and 11f-iii can be parallel)           │
                    └──────────────┬────────────────────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────┐
                    │ 11g. MCP Prompts                 │ (depends on 11e + 11f tools)
                    └──────────────┬───────────────────┘
                                   │
                    ┌──────────────▼───────────────────┐
                    │ 11h. Integration & Verification  │ (final wiring)
                    └──────────────────────────────────┘
```

**Key insight:** Tasks 11a, 11b, 11c, 11d, and 11e are ALL independent — they can be executed in any order or in parallel. Resources (11e) is P0 priority with no dependencies.

---

## Task List

### Phase 1: Foundation (all independent — can be fully parallel)

---

### Task 11a: Auto-Pagination Utility

**Description:** Implement `fetchAllPages<T>()` — a generic paginated fetcher that follows `next_token` across multiple API pages with rate-limit safety guards.

**Acceptance Criteria:**
- [ ] `fetchAllPages` returns `{ records: T[]; truncated: boolean }`
- [ ] Follows `next_token` until exhausted or safety cap hit
- [ ] `ABSOLUTE_MAX_RECORDS = 500` hard ceiling — `Math.min(callerMax, 500)` prevents override
- [ ] Stops after `maxRecords` (default: 100) total records
- [ ] Stops after `maxPages` (default: 20) pages regardless of `next_token`
- [ ] Inserts `interPageDelayMs` (default: 200ms) delay between page fetches
- [ ] Supports `AbortSignal` for cancellation (stops mid-stream)
- [ ] On 429 mid-pagination: retries that specific page (not from page 1), uses existing client retry logic
- [ ] On 401 mid-pagination: existing client token refresh handles it transparently
- [ ] Returns `truncated: true` when hitting any safety cap
- [ ] Works with all 4 collection endpoints
- [ ] Empty first page → returns `{ records: [], truncated: false }`

**Verification:**
```bash
npm test -- tests/api/pagination.test.ts
npm run typecheck && npm run build && npm run lint
```

**Dependencies:** None (builds on existing `WhoopClient.get`)

**Files to create:**
- `src/api/pagination.ts`
- `tests/api/pagination.test.ts`
- `tests/helpers/mock-paginated-response.ts`

**Estimated scope:** Medium (~15 tests)

---

### Task 11b: Enhanced Date Handling

**Description:** Implement `resolveDateExpression()` — a pure utility that converts relative date expressions to ISO 8601 start/end pairs. Strict regex allowlist; rejects anything not explicitly supported.

**Acceptance Criteria:**
- [ ] `resolveDateExpression("today")` → correct UTC start/end for current day
- [ ] `resolveDateExpression("yesterday")` → full previous day (00:00:00Z to 23:59:59.999Z)
- [ ] `resolveDateExpression("last N days")` → correct range for N=1..365
- [ ] `resolveDateExpression("this week")` → Monday 00:00 UTC to now
- [ ] `resolveDateExpression("last week")` → previous Monday to Sunday, UTC
- [ ] `resolveDateExpression("this month")` → 1st of month 00:00 UTC to now
- [ ] `resolveDateExpression("last month")` → full previous month, UTC
- [ ] ISO 8601 strings pass through unchanged (detected by regex)
- [ ] N > 365 → throws `InvalidDateExpression` with descriptive message
- [ ] Future-resolving dates → throws `InvalidDateExpression`
- [ ] Unrecognized expressions → throws `InvalidDateExpression` (not generic Zod error)
- [ ] Case-insensitive matching ("Last 7 Days" = "last 7 days")
- [ ] `InvalidDateExpression` is a typed error class exported from the module
- [ ] `validateDateRange(start, end, maxDays = 365)` validates resolved range ≤ maxDays (covers ISO pass-through too)
- [ ] Leap year: "last 365 days" starting from Feb 29 handled correctly

**Verification:**
```bash
npm test -- tests/tools/date-utils.test.ts
npm run typecheck && npm run build && npm run lint
```

**Dependencies:** None (pure utility)

**Files to create:**
- `src/tools/date-utils.ts`
- `tests/tools/date-utils.test.ts`
- `tests/fixtures/date-expressions.ts`

**Estimated scope:** Medium (~22 tests including property-based)

---

### Task 11c: Individual Record Lookup Tools

**Description:** Add 3 new tools (`get_sleep_by_id`, `get_workout_by_id`, `get_cycle_by_id`) that fetch a single record by ID with secure input validation.

**Acceptance Criteria:**
- [ ] `ENDPOINT_SLEEP_BY_ID`, `ENDPOINT_WORKOUT_BY_ID`, `ENDPOINT_CYCLE_BY_ID` constants added
- [ ] Each tool handler accepts a validated ID and calls `client.get<T>(path)`
- [ ] String IDs validated with Zod `.regex(/^[a-zA-Z0-9_-]+$/)`
- [ ] Numeric IDs validated with Zod `.int().positive()`
- [ ] `encodeURIComponent()` used in URL path construction
- [ ] URL prefix assertion after construction (`url.pathname.startsWith(expectedBase)`)
- [ ] Tools registered in `server.ts` with proper descriptions and schemas
- [ ] Returns full record matching existing types (`Sleep`, `Workout`, `Cycle`)
- [ ] Path traversal attempts (e.g., `"../../admin"`) rejected at Zod layer
- [ ] Non-existent IDs surface WHOOP 404 as clear MCP error message
- [ ] Existing `safeTool` wrapper handles errors consistently

**Verification:**
```bash
npm test -- tests/tools/get-sleep-by-id.test.ts tests/tools/get-workout-by-id.test.ts tests/tools/get-cycle-by-id.test.ts
npm test -- tests/server.test.ts
npm run typecheck && npm run build && npm run lint
```

**Dependencies:** None (uses existing `WhoopClient`, `safeTool`)

**Files to create:**
- `src/tools/get-sleep-by-id.ts`
- `src/tools/get-workout-by-id.ts`
- `src/tools/get-cycle-by-id.ts`
- `tests/tools/get-sleep-by-id.test.ts`
- `tests/tools/get-workout-by-id.test.ts`
- `tests/tools/get-cycle-by-id.test.ts`

**Files to modify:**
- `src/api/endpoints.ts` (add 3 endpoint constants)
- `src/server.ts` (register 3 new tools)
- `tests/server.test.ts` (verify 3 new tools listed)

**Estimated scope:** Medium (~18 tests)

---

### Task 11d: Statistics Utility

**Description:** Implement pure TypeScript statistical functions: mean, median, standard deviation, linear regression (slope + R²), and anomaly detection.

**Acceptance Criteria:**
- [ ] `mean(values: number[]): number` — arithmetic mean
- [ ] `median(values: number[]): number` — middle value (average of two middle for even-length)
- [ ] `standardDeviation(values: number[]): number` — population std dev
- [ ] `linearRegression(values: number[]): { slope: number; r2: number }` — slope per unit index, R² goodness of fit
- [ ] `detectAnomalies(values: number[], threshold?: number): Array<{ index: number; value: number; deviation: number }>` — values > threshold σ from mean (default: 2)
- [ ] `trendDirection(slope: number, r2: number): "improving" | "declining" | "stable"` — R² thresholds: high > 0.7, medium > 0.4, low ≤ 0.4
- [ ] All functions handle edge cases: empty array → error, single value → defined behavior
- [ ] All functions return `NaN`-safe results (no `NaN` propagation)
- [ ] Property-based tests: monotonic input → positive slope, constant → zero slope/std_dev

**Verification:**
```bash
npm test -- tests/tools/stats-utils.test.ts
npm run typecheck && npm run build && npm run lint
```

**Dependencies:** None (pure utility)

**Files to create:**
- `src/tools/stats-utils.ts`
- `tests/tools/stats-utils.test.ts`

**Estimated scope:** Small (~18 tests including property-based)

---

### Task 11e: MCP Resources

**Description:** Add 4 MCP Resources exposing ambient health context with in-memory cache, TTL, and in-flight deduplication. P0 priority feature.

**Acceptance Criteria:**
- [ ] `resources/list` returns 4 resources with correct URIs and descriptions
- [ ] `resources/read` for `whoop://v2/user/recovery/latest` → most recent recovery (limit=1)
- [ ] `resources/read` for `whoop://v2/user/sleep/latest` → most recent sleep (limit=1)
- [ ] `resources/read` for `whoop://v2/user/cycle/latest` → most recent cycle (limit=1)
- [ ] `resources/read` for `whoop://v2/user/profile` → user profile (cached 1hr)
- [ ] Cache hit (within TTL) returns data without API call
- [ ] Cache miss triggers exactly one API call
- [ ] Concurrent reads to same resource deduplicate in-flight requests (Promise sharing)
- [ ] "No data" returns structured empty response (not error)
- [ ] Invalid resource URI returns structured error
- [ ] Token refresh during resource read handled by existing client 401 logic
- [ ] Cache invalidated when `onTokenRefresh` fires (prevents stale data after re-auth)
- [ ] `WHOOP_MCP_DISABLE_RESOURCES=1` env var disables resource registration (opt-out)
- [ ] Resource reads log to `stderr` for observability (not stdout — that's MCP protocol)
- [ ] Resources registered in `createWhoopServer` alongside existing tools
- [ ] Cache is scoped to the server instance (not global)

**Verification:**
```bash
npm test -- tests/resources/
npm test -- tests/server.test.ts
npm run typecheck && npm run build && npm run lint
```

**Dependencies:** None (resources fetch single record — no pagination needed)

**Files to create:**
- `src/resources/index.ts` (resource registration + cache logic)
- `src/resources/recovery-latest.ts`
- `src/resources/sleep-latest.ts`
- `src/resources/cycle-latest.ts`
- `src/resources/profile.ts`
- `tests/resources/recovery-latest.test.ts`
- `tests/resources/sleep-latest.test.ts`
- `tests/resources/cycle-latest.test.ts`
- `tests/resources/profile.test.ts`

**Files to modify:**
- `src/server.ts` (register resources)
- `tests/server.test.ts` (verify resources listed)

**Estimated scope:** Large (~20 tests)

---

### Checkpoint: Phase 1 Complete

- [ ] `npm test` — full suite passes (existing 212 + all new)
- [ ] `npm run typecheck && npm run build && npm run lint` — all clean
- [ ] No changes to existing tool behavior (non-breaking)
- [ ] All Phase 1 deliverables independently usable
- [ ] Tool count: 9 (6 original + 3 ID lookup)
- [ ] Resource count: 4
- [ ] No `any` types introduced

---

### Phase 2: Analytical Tools (depends on 11a + 11b + 11d)

---

### Task 11f-i: `get_weekly_summary`

**Description:** First analytical tool — fetches recovery, sleep, workout, cycle data for a 7-day period and returns computed aggregates. Establishes the multi-endpoint-fetch + aggregate pattern used by subsequent analytical tools.

**Acceptance Criteria:**
- [ ] Fetches recovery, sleep, workout, cycle for 7-day period (Monday–Sunday UTC)
- [ ] Defaults to current week when `week_start` omitted
- [ ] Accepts enhanced date expressions for `week_start`
- [ ] Computes: avg/min/max recovery, avg HRV, avg RHR, avg sleep duration/performance/efficiency, workout count + sport breakdown, avg/max strain
- [ ] Determines recovery trend (improving/declining/stable) via linear regression on 7 daily scores
- [ ] Returns partial results + `warnings[]` if 1-3 endpoint calls fail
- [ ] Returns error only if ALL 4 endpoints fail
- [ ] Uses `fetchAllPages` with serialized endpoints (no parallel pagination)
- [ ] Respects per-tool API call budget (max 20 calls total across all endpoints)
- [ ] Skips records with `score_state !== "SCORED"`

**Verification:**
```bash
npm test -- tests/tools/get-weekly-summary.test.ts
npm test -- tests/server.test.ts
npm run typecheck && npm run build && npm run lint
```

**Dependencies:** Tasks 11a (pagination), 11b (date utils), 11d (stats utils)

**Files to create:**
- `src/tools/get-weekly-summary.ts`
- `tests/tools/get-weekly-summary.test.ts`
- `tests/fixtures/whoop-weekly-data.ts`

**Files to modify:**
- `src/server.ts` (register tool with Zod schema)
- `tests/server.test.ts` (verify tool listed)

**Estimated scope:** Medium (~14 tests)

---

### Task 11f-ii: `compare_periods`

**Description:** Compares health metrics between two user-specified time periods. Reuses pattern from 11f-i.

**Acceptance Criteria:**
- [ ] Accepts two time periods (period_a and period_b)
- [ ] Periods capped at 90 days each (Zod `.refine()` validation)
- [ ] Overlapping periods rejected with descriptive error
- [ ] Uses `validateDateRange` to verify resolved range ≤ 90 days
- [ ] Fetches recovery, sleep, cycle for both periods (serialized pagination)
- [ ] Normalizes metrics per-day when periods have different lengths
- [ ] Computes `change_pct` and `direction` for recovery, sleep, strain
- [ ] `direction` uses ±5% threshold for "unchanged" determination
- [ ] Handles period with zero records gracefully (returns N/A or warning)

**Verification:**
```bash
npm test -- tests/tools/compare-periods.test.ts
npm test -- tests/server.test.ts
npm run typecheck && npm run build && npm run lint
```

**Dependencies:** Tasks 11a, 11b, 11d, 11f-i (pattern established)

**Files to create:**
- `src/tools/compare-periods.ts`
- `tests/tools/compare-periods.test.ts`

**Files to modify:**
- `src/server.ts` (register tool)
- `tests/server.test.ts` (verify tool listed)

**Estimated scope:** Medium (~12 tests)

---

### Task 11f-iii: `get_trend`

**Description:** Analyzes a single health metric over time using linear regression, anomaly detection, and statistical summary. Can be implemented in parallel with 11f-ii.

**Acceptance Criteria:**
- [ ] Accepts `metric` enum + `days` (7–90, default 30)
- [ ] Maps metric names to correct endpoint + field extraction:
  - `recovery` → `/v2/recovery` → `score.recovery_score`
  - `hrv` → `/v2/recovery` → `score.hrv_rmssd_milli`
  - `rhr` → `/v2/recovery` → `score.resting_heart_rate`
  - `sleep_duration` → `/v2/activity/sleep` → computed from `start`/`end`
  - `sleep_performance` → `/v2/activity/sleep` → `score.sleep_performance_percentage`
  - `strain` → `/v2/cycle` → `score.strain`
- [ ] Returns statistics (mean, median, std_dev, min, max)
- [ ] Returns trend direction + slope + confidence (R² thresholds: high>0.7, medium>0.4, low≤0.4)
- [ ] Returns anomalies (>2σ from mean) with dates and deviation
- [ ] Error for < 2 data points with descriptive message
- [ ] "Stable" when all values identical (zero variance)
- [ ] Skips records with `score_state !== "SCORED"` (filters PENDING/UNSCORABLE)

**Verification:**
```bash
npm test -- tests/tools/get-trend.test.ts
npm test -- tests/server.test.ts
npm run typecheck && npm run build && npm run lint
```

**Dependencies:** Tasks 11a (pagination), 11b (date utils), 11d (stats utils)

**Files to create:**
- `src/tools/get-trend.ts`
- `tests/tools/get-trend.test.ts`

**Files to modify:**
- `src/server.ts` (register tool)
- `tests/server.test.ts` (verify tool listed)

**Estimated scope:** Medium (~14 tests)

---

### Checkpoint: Phase 2 Complete

- [ ] `npm test` — all tests pass
- [ ] `npm run typecheck && npm run build && npm run lint` — all clean
- [ ] Tool count: 12 (6 original + 3 ID lookup + 3 analytical)
- [ ] Resource count: 4
- [ ] Analytical tools return correct results verified against hand-calculated fixtures
- [ ] Rate limit budget enforced (max 20 API calls per tool invocation)
- [ ] Property-based tests verify statistical correctness

---

### Phase 3: Polish + Final Integration

---

### Task 11g: MCP Prompts

**Description:** Add 5 MCP Prompts — pre-built conversation starters that guide users toward valuable health queries.

**Acceptance Criteria:**
- [ ] `prompts/list` returns 5 prompts with names, descriptions, and argument schemas
- [ ] `prompts/get` for `weekly_health_review` returns messages referencing recovery/sleep/workout tools
- [ ] `prompts/get` for `sleep_analysis` returns messages focused on sleep patterns
- [ ] `prompts/get` for `recovery_trend` returns messages about recovery trajectory
- [ ] `prompts/get` for `workout_recap` returns messages about workout/strain data
- [ ] `prompts/get` for `health_check` returns messages referencing resources for quick status
- [ ] `weekly_health_review` accepts optional `days` argument (default: 7)
- [ ] Prompts include system-level context about available tools and data meaning
- [ ] Prompt messages are well-structured for Claude to act on
- [ ] Prompts registered in `createWhoopServer`

**Verification:**
```bash
npm test -- tests/prompts/prompts.test.ts
npm test -- tests/server.test.ts
npm run typecheck && npm run build && npm run lint
```

**Dependencies:** Tasks 11e (resources to reference), 11f (analytical tools to reference)

**Files to create:**
- `src/prompts/index.ts`
- `src/prompts/weekly-health-review.ts`
- `src/prompts/sleep-analysis.ts`
- `src/prompts/recovery-trend.ts`
- `src/prompts/workout-recap.ts`
- `src/prompts/health-check.ts`
- `tests/prompts/prompts.test.ts`

**Files to modify:**
- `src/server.ts` (register prompts)
- `tests/server.test.ts` (verify prompts listed)

**Estimated scope:** Medium (~12 tests)

---

### Task 11h: Integration, Wiring, and Final Verification

**Description:** Wire enhanced date handling into all collection + analytical tool schemas. Update documentation. Final full-stack verification.

**Acceptance Criteria:**
- [ ] All collection tool schemas accept enhanced date expressions in `start`/`end`
- [ ] All analytical tool schemas accept enhanced date expressions where applicable
- [ ] Tool descriptions updated to mention relative date support
- [ ] `package.json` version bumped to `0.3.0`
- [ ] README updated with new tools, resources, prompts sections
- [ ] README documents Resources privacy model (what data is exposed as ambient context)
- [ ] CHANGELOG updated with V2 release notes
- [ ] All 212+ existing tests still pass (no regressions)
- [ ] All new tests pass
- [ ] TypeScript compiles clean
- [ ] Build succeeds
- [ ] Lint clean
- [ ] No `any` types introduced

**Verification:**
```bash
npm test
npm run typecheck
npm run build
npm run lint
```

**Dependencies:** All previous tasks (11a–11g)

**Files to modify:**
- `src/server.ts` (update collection tool schemas + descriptions)
- `src/tools/get-recovery.ts` (apply date resolution before API call)
- `src/tools/get-sleep.ts` (apply date resolution)
- `src/tools/get-workout.ts` (apply date resolution)
- `src/tools/get-cycle.ts` (apply date resolution)
- `package.json` (version bump)
- `README.md` (documentation)
- `CHANGELOG.md` (release notes)

**Estimated scope:** Medium (0 new files, 8 modified)

---

### Checkpoint: V2 Complete

- [ ] `npm test` — all ~360 tests pass
- [ ] `npm run typecheck && npm run build && npm run lint` — all clean
- [ ] Tool count: 12
- [ ] Resource count: 4
- [ ] Prompt count: 5
- [ ] MCP Inspector: all features verified manually
- [ ] Claude Desktop: connect, auth, query "How is my recovery trending?" → single tool call
- [ ] No regressions in existing V1 functionality
- [ ] Ready for `npm publish` as `0.3.0`

---

## Implementation Order Summary

```
Phase 1: Foundation (ALL independent — can be fully parallel)
├── 11a: Auto-pagination utility
├── 11b: Date handling utility
├── 11c: Individual record lookup (3 tools)
├── 11d: Statistics utility
└── 11e: MCP Resources (4 resources)  ← P0, no deps

Phase 2: Analytical Tools (sequential start, then parallel)
├── 11f-i:   get_weekly_summary        ← establishes pattern (depends on 11a+11b+11d)
├── 11f-ii:  compare_periods           ← can ‖ 11f-iii
└── 11f-iii: get_trend                 ← can ‖ 11f-ii

Phase 3: Polish (depends on Phases 1+2)
├── 11g: MCP Prompts (depends on 11e + 11f)
└── 11h: Integration wiring + final verification (depends on all)
```

### Parallelization Map

| Can Run in Parallel | Must Be Sequential |
|---------------------|-------------------|
| 11a ‖ 11b ‖ 11c ‖ 11d ‖ 11e | 11f-i must complete before 11f-ii/iii |
| 11f-ii ‖ 11f-iii | 11g depends on 11e + 11f |
| — | 11h depends on everything |

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| `@modelcontextprotocol/sdk` Resource/Prompt API different than expected | 🟡 Medium | Verify SDK API in Task 11e before implementing. Read SDK source/docs first. |
| WHOOP rate limits hit during analytical tool testing | 🟢 Low | All tests mock API. Manual testing uses conservative defaults (200ms delay). |
| Linear regression accuracy edge cases | 🟢 Low | Property-based tests with `fast-check` catch numerical edge cases. |
| Enhanced date handling breaks existing users | 🟡 Medium | ISO 8601 pass-through ensures backward compatibility. Only new expressions activate new logic. |
| Auto-pagination infinite loop | 🟡 Medium | Hard `maxPages` cap (20) + `ABSOLUTE_MAX_RECORDS` (500) prevent runaway. Tested with mock that returns `next_token` forever. |
| Resource cache memory growth | 🟢 Low | Only 4 resources × 1 cached value each. TTL expires stale data. Cache invalidated on re-auth. |

---

## Dev Dependency Additions

Before starting implementation:

```bash
npm install -D fast-check @vitest/coverage-v8
```

- `fast-check` — property-based testing for date parser and statistics
- `@vitest/coverage-v8` — code coverage reporting

---

## Estimated Test Count by Task

| Task | New Tests | Cumulative |
|------|-----------|-----------|
| 11a: Auto-pagination | ~15 | 227 |
| 11b: Date utils | ~22 | 249 |
| 11c: ID lookup tools | ~18 | 267 |
| 11d: Stats utils | ~18 | 285 |
| 11e: MCP Resources | ~20 | 305 |
| 11f-i: get_weekly_summary | ~14 | 319 |
| 11f-ii: compare_periods | ~12 | 331 |
| 11f-iii: get_trend | ~14 | 345 |
| 11g: MCP Prompts | ~12 | 357 |
| 11h: Integration | ~5 | 362 |
| **Total new** | **~150** | **~362** |
