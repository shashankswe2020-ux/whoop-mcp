# Spec: WHOOP MCP Server — V2 Feature Enhancements

> **Status:** Draft (reviewed by code-reviewer, security-auditor, test-engineer)
> **Date:** 2026-05-29
> **Baseline:** V1 shipped (0.2.1) — 6 tools, OAuth, 212 tests, MCP Registry published
> **Reviews:** [code-review-checkpoint-3](../reviews/code-review-checkpoint-3.md), [security-audit-4](../security-audits/security-audit-4.md)

---

## Market Research Summary

### Competitive Landscape (MCP Health Servers, May 2026)

| Server | Tools | MCP Features Used | Differentiators |
|--------|-------|-------------------|-----------------|
| **whoop-ai-mcp (this)** | 6 | Tools only | OAuth, retry, secure tokens, MCP Registry |
| whoop-mcp-server | ~6 | Tools only | Basic WHOOP coverage |
| oura-mcp (community) | 8 | Tools + Resources | Readiness score as Resource, daily summaries |
| apple-health-mcp | 12 | Tools + Prompts | HealthKit integration, pre-built health prompts |
| fitbit-mcp | 7 | Tools only | Activity zones, intraday data |

### Key Gaps Identified

1. **No analytical tools** — AI must compute trends/averages from raw data every time (expensive, inconsistent)
2. **No MCP Resources** — AI has no ambient health context without explicit tool calls
3. **No MCP Prompts** — Users must craft their own queries; no guided health conversations
4. **No individual record lookup** — Can't fetch a specific sleep/workout by ID
5. **No natural language date support** — Users must know ISO 8601; Claude often hallucinates dates
6. **No auto-pagination** — Limited to 25 records per call; multi-week analysis requires manual chaining
7. **No data correlation** — Sleep↔recovery↔strain relationships require user to call 3 tools and reason across them

### User Value Ranking (from developer feedback patterns)

| Priority | Feature | User Signal |
|----------|---------|-------------|
| P0 | MCP Resources (today's health snapshot) | #1 request in MCP community — ambient context |
| P0 | Weekly/monthly summary tool | Most common natural language query type |
| P1 | MCP Prompts (guided health conversations) | Reduces friction for new users |
| P1 | Trend detection tool | "Is my recovery improving?" requires 7+ records + analysis |
| P1 | Auto-pagination for large date ranges | Blocks multi-week analysis |
| P2 | Individual record lookup (by ID) | Needed for drill-down after collection queries |
| P2 | Sleep↔Recovery correlation tool | Most-asked health insight |
| P2 | Natural language date parsing | Reduces Claude hallucination on dates |
| P3 | Streamable HTTP transport | Cloud deployment use case |
| P3 | OS keychain token storage | Enterprise security requirement |

---

## Proposed V2 Scope

### Feature 1: MCP Resources — Ambient Health Context

**Objective:** Expose the user's current health state as MCP Resources so AI assistants have context without explicit tool calls. This is the #1 most impactful MCP feature not yet used.

**Resources to expose:**

| Resource URI | Description | WHOOP Endpoint | Refresh | Cache TTL |
|--------------|-------------|----------------|---------|----------|
| `whoop://v2/user/recovery/latest` | Most recent recovery score, HRV, RHR, SpO2 | `/v2/recovery` (limit=1) | On read (cache miss) | 5 min |
| `whoop://v2/user/sleep/latest` | Most recent sleep record (duration, stages, performance) | `/v2/activity/sleep` (limit=1) | On read (cache miss) | 5 min |
| `whoop://v2/user/cycle/latest` | Current physiological cycle (strain, HR) | `/v2/cycle` (limit=1) | On read (cache miss) | 5 min |
| `whoop://v2/user/profile` | User profile (static, cached) | `/v2/user/profile/basic` | On read (cache miss) | 1 hr |

> **URI Design Decisions:** Hierarchical `whoop://v2/user/{domain}/{qualifier}` scheme chosen for versioning, future multi-user support, and semantic stability. `latest` preferred over `today` to avoid temporal URI identity conflicts.

**MCP Resource Protocol:**
- Resources are read-only, fetched on demand by the AI client
- Each resource returns structured JSON matching existing API types
- Resource list exposed via `resources/list` MCP method
- Individual resource fetched via `resources/read` MCP method

**Acceptance Criteria:**
- [ ] `resources/list` returns all 4 resources with URIs and descriptions
- [ ] `resources/read` for `whoop://v2/user/recovery/latest` returns most recent recovery
- [ ] `resources/read` for `whoop://v2/user/sleep/latest` returns most recent sleep record
- [ ] `resources/read` for `whoop://v2/user/cycle/latest` returns current/most recent cycle
- [ ] `resources/read` for `whoop://v2/user/profile` returns cached profile data
- [ ] Resources handle "no data" gracefully (new user, no sleep yet today)
- [ ] Resources authenticate using the same OAuth token as tools
- [ ] Cache hit returns data without API call (verifiable via fetch mock call count)
- [ ] Cache miss triggers exactly one API call
- [ ] Concurrent reads to same resource don't duplicate API calls (dedup in-flight)
- [ ] Invalid resource URI returns structured error, not 500
- [ ] Token refresh during resource read is handled (401 → refresh → retry)
- [ ] Unit tests mock API responses for all 4 resources
- [ ] Integration test verifies resource registration on MCP server

---

### Feature 2: MCP Prompts — Guided Health Conversations

**Objective:** Provide pre-built conversation starters that guide users into the most valuable health queries. Reduces friction for new users and demonstrates capabilities.

**Prompts to expose:**

| Prompt Name | Description | Tools Used |
|-------------|-------------|------------|
| `weekly_health_review` | "Review my health metrics from the past week" | `get_recovery_collection`, `get_sleep_collection`, `get_workout_collection` |
| `sleep_analysis` | "Analyze my recent sleep patterns and quality" | `get_sleep_collection` |
| `recovery_trend` | "How is my recovery trending?" | `get_recovery_collection` |
| `workout_recap` | "Summarize my recent workouts and strain" | `get_workout_collection`, `get_cycle_collection` |
| `health_check` | "Quick health status check" | Resources: `whoop://recovery/today`, `whoop://sleep/last` |

**Prompt Schema (MCP Protocol):**
```typescript
{
  name: "weekly_health_review",
  description: "Comprehensive review of recovery, sleep, and workouts from the past 7 days",
  arguments: [
    {
      name: "days",
      description: "Number of days to review (default: 7)",
      required: false
    }
  ]
}
```

**Acceptance Criteria:**
- [ ] `prompts/list` returns all 5 prompts with names, descriptions, and argument schemas
- [ ] `prompts/get` for each prompt returns a well-structured message array
- [ ] Prompts reference tools and resources by name (AI client resolves them)
- [ ] Prompts include helpful context about what data will be fetched
- [ ] Unit tests verify prompt registration and message generation
- [ ] Manual test: Claude Desktop shows prompts in UI and they produce useful conversations

---

### Feature 3: Analytical Tools — Summaries and Trends

**Objective:** Pre-compute common analytical queries so the AI gets structured insights rather than raw data requiring re-analysis on every conversation.

#### Tool: `get_weekly_summary`

| Field | Value |
|-------|-------|
| **MCP Name** | `get_weekly_summary` |
| **Description** | Get a summarized health report for a given week — avg recovery, total sleep, workout count, strain trend |
| **WHOOP Endpoints** | `/v2/recovery`, `/v2/activity/sleep`, `/v2/activity/workout`, `/v2/cycle` |
| **Scope** | Existing scopes (no new permissions) |

**Input Schema:**
```typescript
z.object({
  week_start: z.string().optional().describe("ISO 8601 start of week. Defaults to most recent Monday."),
})
```

**Output Shape:**
```typescript
interface WeeklySummary {
  week_start: string;
  week_end: string;
  recovery: {
    average_score: number;
    min_score: number;
    max_score: number;
    average_hrv: number;
    average_rhr: number;
    trend: "improving" | "declining" | "stable";
  };
  sleep: {
    average_duration_hours: number;
    average_performance_pct: number;
    average_efficiency_pct: number;
    total_sleep_debt_hours: number;
  };
  workouts: {
    count: number;
    total_strain: number;
    total_calories_kj: number;
    sport_breakdown: Record<string, number>; // sport_name → count
  };
  strain: {
    average_daily_strain: number;
    max_daily_strain: number;
  };
}
```

#### Tool: `compare_periods`

| Field | Value |
|-------|-------|
| **MCP Name** | `compare_periods` |
| **Description** | Compare health metrics between two time periods — shows improvement or regression |
| **WHOOP Endpoints** | `/v2/recovery`, `/v2/activity/sleep`, `/v2/cycle` |

**Input Schema:**
```typescript
z.object({
  period_a_start: z.string().describe("ISO 8601 start of first period"),
  period_a_end: z.string().describe("ISO 8601 end of first period"),
  period_b_start: z.string().describe("ISO 8601 start of second period"),
  period_b_end: z.string().describe("ISO 8601 end of second period"),
})
```

**Output Shape:**
```typescript
interface PeriodComparison {
  period_a: { start: string; end: string; days: number };
  period_b: { start: string; end: string; days: number };
  recovery: {
    period_a_avg: number;
    period_b_avg: number;
    change_pct: number;
    direction: "improved" | "declined" | "unchanged";
  };
  sleep: {
    period_a_avg_hours: number;
    period_b_avg_hours: number;
    change_pct: number;
    direction: "improved" | "declined" | "unchanged";
  };
  strain: {
    period_a_avg: number;
    period_b_avg: number;
    change_pct: number;
    direction: "increased" | "decreased" | "unchanged";
  };
}
```

#### Tool: `get_trend`

| Field | Value |
|-------|-------|
| **MCP Name** | `get_trend` |
| **Description** | Analyze a health metric trend over time — detects direction, variability, and anomalies |

**Input Schema:**
```typescript
z.object({
  metric: z.enum(["recovery", "hrv", "rhr", "sleep_duration", "sleep_performance", "strain"]),
  days: z.number().int().min(7).max(90).optional().describe("Number of days to analyze. Default: 30."),
})
```

**Output Shape:**
```typescript
interface TrendAnalysis {
  metric: string;
  period: { start: string; end: string; days: number };
  values: number[]; // chronological daily values
  statistics: {
    mean: number;
    median: number;
    std_dev: number;
    min: number;
    max: number;
  };
  trend: {
    direction: "improving" | "declining" | "stable";
    slope: number; // per-day change
    confidence: "high" | "medium" | "low"; // based on R²
  };
  anomalies: Array<{
    date: string;
    value: number;
    deviation_from_mean: number;
  }>;
}
```

**Acceptance Criteria (all analytical tools):**
- [ ] `get_weekly_summary` returns correct averages matching manual calculation from raw data
- [ ] `get_weekly_summary` defaults to current week (Monday start, UTC) when no `week_start` provided
- [ ] `get_weekly_summary` returns partial results + `warnings` array if 1-3 endpoint calls fail
- [ ] `get_weekly_summary` returns error only if ALL 4 endpoint calls fail
- [ ] `get_weekly_summary` respects per-tool API call budget (max 20 calls total)
- [ ] `compare_periods` correctly computes percentage changes and direction
- [ ] `compare_periods` handles periods of different lengths (normalizes per-day)
- [ ] `compare_periods` rejects periods longer than 90 days (Zod validation)
- [ ] `compare_periods` rejects overlapping periods (validation error)
- [ ] `get_trend` correctly identifies improving/declining/stable using linear regression slope
- [ ] `get_trend` identifies anomalies as values >2 standard deviations from mean
- [ ] `get_trend` returns "stable" when variance is below threshold (all values identical)
- [ ] `get_trend` returns meaningful error for < 2 data points
- [ ] All tools handle insufficient data gracefully (< 3 data points → error message)
- [ ] All tools use auto-pagination internally (fetch all records in date range)
- [ ] All tools serialize multi-endpoint pagination (not parallel) to respect rate limits
- [ ] Unit tests with fixture data verify statistical calculations
- [ ] Property-based tests verify: monotonic input → positive slope, constant input → zero slope
- [ ] No new runtime dependencies — statistics computed with pure TypeScript

---

### Feature 4: Auto-Pagination

**Objective:** Transparently fetch all records in a date range, not just the first 25. Required by analytical tools and improves collection tool UX.

**Implementation:**
```typescript
interface PaginatedFetchOptions {
  maxRecords?: number;        // safety cap, default: 100
  maxPages?: number;          // hard stop, default: 20
  interPageDelayMs?: number;  // rate limit protection, default: 200ms
  signal?: AbortSignal;       // cancellation support
  endpoint: string;
  params: CollectionParams;
}

async function fetchAllPages<T>(
  client: WhoopClient,
  options: PaginatedFetchOptions
): Promise<{ records: T[]; truncated: boolean }> {
  // Loop using nextToken until exhausted, maxRecords, or maxPages reached
  // Insert interPageDelayMs between page fetches
  // Respect AbortSignal for cancellation
  // If 429 during pagination: retry that page (not restart)
  // If 401 during pagination: refresh token and resume
}
```

**Rate Limit Safety:**
- Per-tool API call budget: max 20 fetch calls across all endpoints per invocation
- Response size cap: if aggregated JSON exceeds 100KB, truncate and include `truncated: true`
- Inter-page delay (200ms default) prevents burst requests
- Analytical tools that call multiple endpoints concurrently MUST serialize pagination (not parallel)

**Acceptance Criteria:**
- [ ] `fetchAllPages` follows `next_token` until no more pages
- [ ] Safety cap: stops after MAX_RECORDS (100) total records
- [ ] Safety cap: stops after MAX_PAGES (20) pages regardless of next_token
- [ ] Inter-page delay: ≥200ms between page fetches (verifiable via timing mock)
- [ ] AbortSignal: cancellation stops pagination mid-stream
- [ ] 429 mid-pagination: retries that specific page (not from page 1)
- [ ] 401 mid-pagination: refreshes token and resumes from current page
- [ ] Returns `{ records, truncated: true }` when hitting safety cap
- [ ] Works with all 4 collection endpoints (recovery, sleep, workout, cycle)
- [ ] Used internally by analytical tools (`get_weekly_summary`, `compare_periods`, `get_trend`)
- [ ] Existing collection tools still use single-page behavior (no breaking change)
- [ ] Unit test: 3 pages of mocked data → all records returned in order
- [ ] Unit test: safety cap triggers at configured limit
- [ ] Unit test: empty first page → returns empty array, no loop
- [ ] Unit test: inter-page delay is respected (timing assertion)

---

### Feature 5: Individual Record Lookup

**Objective:** Allow fetching a single sleep, workout, or cycle by ID for drill-down after a collection query.

**New Tools:**

| MCP Tool | WHOOP Endpoint | Method | Input |
|----------|---------------|--------|-------|
| `get_sleep_by_id` | `/v2/activity/sleep/{sleepId}` | GET | `sleepId: string` |
| `get_workout_by_id` | `/v2/activity/workout/{workoutId}` | GET | `workoutId: string` |
| `get_cycle_by_id` | `/v2/cycle/{cycleId}` | GET | `cycleId: number` |

**Input Schemas (with ID format validation):**
```typescript
// get_sleep_by_id — IDs validated against safe pattern
z.object({ sleep_id: z.string().regex(/^[a-zA-Z0-9_-]+$/).describe("Sleep record ID from a collection response") })

// get_workout_by_id
z.object({ workout_id: z.string().regex(/^[a-zA-Z0-9_-]+$/).describe("Workout record ID from a collection response") })

// get_cycle_by_id
z.object({ cycle_id: z.number().int().positive().describe("Cycle ID from a collection response") })
```

> **Security note:** String IDs validated with `^[a-zA-Z0-9_-]+$` regex to prevent path traversal. Additionally, `encodeURIComponent()` used in endpoint path construction as defense-in-depth.

**Acceptance Criteria:**
- [ ] Each tool returns the full record matching the existing type (Sleep, Workout, Cycle)
- [ ] Invalid IDs (malformed format) rejected at Zod validation layer
- [ ] Non-existent IDs return structured error from WHOOP API (404 → clear message)
- [ ] Path traversal attempts (e.g., `"../../admin"`) rejected by regex validation
- [ ] `encodeURIComponent` used in URL path construction
- [ ] Unit tests verify correct endpoint construction and response mapping
- [ ] No new OAuth scopes required (uses existing read:* scopes)

---

### Feature 6: Enhanced Date Handling

**Objective:** Accept relative date expressions alongside ISO 8601, reducing user friction and Claude hallucination on date formatting.

**Supported Expressions (strict allowlist):**
- `"today"`, `"yesterday"`
- `"last N days"` where N is 1–365
- `"this week"`, `"last week"` (ISO week — starts Monday)
- `"this month"`, `"last month"`
- ISO 8601 (pass-through, existing behavior)

**Rejected Inputs:**
- N > 365 in `"last N days"` → `InvalidDateExpression` error
- Any expression resolving to a future date → `InvalidDateExpression` error
- Unrecognized expressions → `InvalidDateExpression` error (not generic Zod error)
- Arbitrary natural language ("next Tuesday", "2 weeks ago") → rejected (strict regex allowlist)

**Implementation:**
- Pure TypeScript date resolution utility — no runtime dependency (no `date-fns`, no `moment`)
- **Strict regex allowlist** — only documented expressions pass; everything else is rejected
- Resolves relative expressions to ISO 8601 `start`/`end` pair
- Uses **UTC consistently** for all resolution (avoids ambiguity in non-local deployments)
- Parser is case-insensitive (`"Last 7 Days"` = `"last 7 days"`)
- Applied at the tool layer before passing to API client

**Input Schema Change (all collection + analytical tools):**
```typescript
start: z.string().optional().describe(
  "Start time — ISO 8601 (e.g. 2026-05-01T00:00:00.000Z) or relative (e.g. 'last 7 days', 'this week', 'yesterday')"
),
end: z.string().optional().describe(
  "End time — ISO 8601 or relative expression. Defaults to now."
),
```

**Acceptance Criteria:**
- [ ] `"last 7 days"` resolves to correct ISO 8601 start/end pair (UTC)
- [ ] `"this week"` starts on Monday 00:00 UTC (ISO week)
- [ ] `"yesterday"` resolves to full day (00:00:00Z to 23:59:59.999Z)
- [ ] ISO 8601 strings pass through unchanged
- [ ] Expressions where N > 365 return `InvalidDateExpression` error
- [ ] Expressions resolving to future dates return `InvalidDateExpression` error
- [ ] Unrecognized expressions return `InvalidDateExpression` error (not generic Zod error)
- [ ] Parser is case-insensitive
- [ ] Leap year handling: "last 365 days" starting from Feb 29
- [ ] Unit tests cover all supported expressions with `vi.useFakeTimers()` for determinism
- [ ] Property-based tests (with `fast-check`) verify parser never throws unhandled exception
- [ ] No new runtime dependencies

---

## Non-Goals for V2

| Feature | Reason to Defer |
|---------|-----------------|
| Multi-user / coach support | Fundamentally different auth model (V3) |
| Webhook + local cache | Requires persistent storage infra (V3) |
| HTTP/SSE transport | Cloud deployment — different target audience (V3) |
| OS keychain integration | Platform-specific complexity, dotfile is sufficient for now |
| Write operations (log workout) | WHOOP API write access has separate approval process |
| Real-time streaming | WHOOP has no WebSocket/streaming API |

---

## Implementation Strategy

### New Files (V2)

```
src/
├── resources/
│   ├── index.ts                  # Resource registration
│   ├── recovery-latest.ts        # whoop://v2/user/recovery/latest
│   ├── sleep-latest.ts           # whoop://v2/user/sleep/latest
│   ├── cycle-latest.ts           # whoop://v2/user/cycle/latest
│   └── profile.ts                # whoop://v2/user/profile
├── prompts/
│   ├── index.ts                  # Prompt registration
│   ├── weekly-health-review.ts   # Prompt: weekly_health_review
│   ├── sleep-analysis.ts         # Prompt: sleep_analysis
│   ├── recovery-trend.ts         # Prompt: recovery_trend
│   ├── workout-recap.ts          # Prompt: workout_recap
│   └── health-check.ts           # Prompt: health_check
├── tools/
│   ├── get-weekly-summary.ts     # Tool: get_weekly_summary
│   ├── compare-periods.ts        # Tool: compare_periods
│   ├── get-trend.ts              # Tool: get_trend
│   ├── get-sleep-by-id.ts        # Tool: get_sleep_by_id
│   ├── get-workout-by-id.ts      # Tool: get_workout_by_id
│   ├── get-cycle-by-id.ts        # Tool: get_cycle_by_id
│   └── date-utils.ts             # Relative date resolution
├── api/
│   └── pagination.ts             # Auto-pagination utility
tests/
├── resources/
│   ├── recovery-latest.test.ts
│   ├── sleep-latest.test.ts
│   ├── cycle-latest.test.ts
│   └── profile.test.ts
├── prompts/
│   └── prompts.test.ts
├── tools/
│   ├── get-weekly-summary.test.ts
│   ├── compare-periods.test.ts
│   ├── get-trend.test.ts
│   ├── get-sleep-by-id.test.ts
│   ├── get-workout-by-id.test.ts
│   ├── get-cycle-by-id.test.ts
│   ├── date-utils.test.ts
│   └── pagination.test.ts
```

### Implementation Order

| # | Feature | Dependencies | Est. Complexity |
|---|---------|--------------|-----------------|
| 1 | Auto-pagination utility | API client | Low |
| 2 | Enhanced date handling | None | Medium |
| 3 | Individual record lookup (3 tools) | API client, endpoints | Low |
| 4 | Analytical tools (3 tools) | Auto-pagination, date handling | High |
| 5 | MCP Resources (4 resources) | API client, server.ts | Medium |
| 6 | MCP Prompts (5 prompts) | Resources, tools | Low |

### Testing Strategy

- **Same approach as V1:** Mock WHOOP API, never hit real endpoints in tests
- **Statistical calculations:** Verified with hand-calculated fixture data
- **Date parsing:** Edge cases at timezone boundaries (DST transitions)
- **Resources:** Test registration + response shape
- **Prompts:** Test list/get protocol compliance
- **Coverage target:** Maintain >70% overall, >80% on new analytical code

### No New Runtime Dependencies

All features implementable with:
- `@modelcontextprotocol/sdk` (already has Resource + Prompt protocol support)
- `zod` (schema validation)
- Native `Date` / `Intl.DateTimeFormat` (date handling)
- Pure TypeScript math (mean, median, linear regression)

### New Dev Dependencies

- `fast-check` — property-based testing for date parser and statistical calculations
- `@vitest/coverage-v8` — code coverage (was missing from V1, noted in checkpoint-1 review)

---

## Success Metrics

| Metric | Target |
|--------|--------|
| MCP tool count | 6 → 12 (+6 new tools) |
| MCP resources | 0 → 4 |
| MCP prompts | 0 → 5 |
| Test count | 212 → ~340 (est. +125 new tests, incl. property-based) |
| npm weekly downloads | Track post-release |
| GitHub stars | Track post-release |
| User query: "How is my recovery trending?" | Answered by single `get_trend` call (vs. 3+ calls + reasoning today) |
| Rate limit incidents | 0 (verified by inter-page delay + budget cap) |

---

## Open Questions

1. Does `@modelcontextprotocol/sdk` current version support Resources and Prompts in stdio transport? (Verify before starting Feature 5/6)
2. ~~Should `get_weekly_summary` fetch 7 days or align to Monday–Sunday?~~ **Resolved: align to Monday (ISO week, UTC)**
3. ~~Should `get_trend` use simple linear regression or exponential moving average?~~ **Resolved: linear regression for V2, EMA as V3 option**
4. What's the maximum safe `maxRecords` for auto-pagination before WHOOP rate limits trigger? (Need to test: propose 100 records + 200ms delay as conservative default)
5. ~~Should relative date expressions be locale-aware (week starts Sunday in US)?~~ **Resolved: UTC, ISO week (Monday start)**
6. Should `fast-check` be the only property-based testing library or should we evaluate alternatives? (Propose: `fast-check` — most mature, TypeScript-native)
7. What R² threshold should `get_trend` use for confidence levels? (Propose: high > 0.7, medium > 0.4, low ≤ 0.4)

---

---

## Test Infrastructure Additions

### New Test Helpers Required

| Helper | Location | Purpose |
|--------|----------|--------|
| `mock-paginated-response.ts` | `tests/helpers/` | Generate multi-page API responses with configurable page count and `next_token` values |
| `mock-clock.ts` | `tests/helpers/` | `vi.useFakeTimers()` patterns for date parser and resource cache TTL tests |
| `whoop-weekly-data.ts` | `tests/fixtures/` | Realistic 7-day dataset (recovery, sleep, workout, cycle) for analytical tool tests |
| `whoop-multi-page.ts` | `tests/fixtures/` | 3-5 pages of collection data with realistic `next_token` values |
| `date-expressions.ts` | `tests/fixtures/` | Canonical list of valid/invalid date expressions with expected outputs |

### Test Hierarchy Per Feature

| Feature | Unit % | Integration % | Rationale |
|---------|--------|---------------|----------|
| Date parser | 100% | 0% | Pure function, no I/O |
| `fetchAllPages` | 70% | 30% | Logic is pure but needs fetch mock orchestration |
| MCP Resources | 20% | 80% | Tests SDK resource registration + handler behavior |
| MCP Prompts | 20% | 80% | Tests SDK prompt registration + template rendering |
| `get_weekly_summary` | 40% | 60% | Multi-endpoint coordination needs integration |
| `compare_periods` | 60% | 40% | Math is unit-testable, API wiring is integration |
| `get_trend` | 80% | 20% | Mostly computation (regression, statistics) |

---

## Revision History

| Date | Change |
|------|--------|
| 2026-05-29 | Initial V2 feature enhancement spec drafted |
| 2026-05-29 | Incorporated code-reviewer, security-auditor, and test-engineer feedback |
