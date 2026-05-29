# Code Review Checkpoint 3: V2 Feature Enhancement Spec

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-05-29
> **Scope:** `docs/specs/v2-feature-enhancements.md` — architectural review of 6 proposed features
> **Test suite:** 219 tests passing (14 files), typecheck clean, build clean, lint clean

---

## Verdict: ⚠️ NEEDS CHANGES — 2 Critical design issues, 5 Important issues

**Overview:** The spec is well-researched with clear market justification and good feature prioritization. However, there are critical design gaps in the auto-pagination safety model (unbounded concurrent API calls can trigger WHOOP rate limits and OOM in constrained MCP processes) and the resource URI scheme conflicts with MCP protocol conventions. The analytical tools are well-scoped but the `compare_periods` tool may be over-engineered for the value it provides. The implementation order has a dependency inversion that should be corrected.

---

## Critical Issues

### 1. Auto-pagination safety cap of 100 records is insufficient protection — no per-minute rate limit guard

- **File:** `docs/specs/v2-feature-enhancements.md` (Feature 4: Auto-Pagination)
- **Problem:** The spec sets `maxRecords: 100` as the only safety mechanism. However, the WHOOP API has *rate limits per minute* (not documented publicly but observed at ~100 requests/minute). Fetching 100 records at 25/page = 4 sequential API calls. But `get_trend` with `days: 90` or `compare_periods` across 60 days could trigger 8+ paginated calls across multiple endpoints *simultaneously* (recovery + sleep + cycles). The `get_weekly_summary` alone calls 4 endpoints × ~1 page each = 4 calls. A `compare_periods` covering 30-day periods calls 3 endpoints × 2 periods × ~2 pages = 12 calls.

  Combined with `get_trend(days: 90)` being 90/25 = 4 pages, plus retry logic, a single user query like "compare last month vs this month" could generate 12-16 API calls within seconds. If the user follows up immediately with another query, rate limiting becomes likely.

  Additionally, in MCP stdio transport, the server runs inside the AI client's process. Buffering 100+ full recovery/sleep/workout records (each 1-3KB) in memory is safe, but there's no backpressure signal — if a user calls `compare_periods` with very long date ranges, the response JSON could exceed reasonable MCP message sizes.

- **Fix:**
  1. Add a **per-request rate limiter** (token bucket or simple delay between pages, e.g., 200ms) to `fetchAllPages`
  2. Specify a **total API calls budget** per tool invocation (e.g., max 8 fetch calls across all endpoints)
  3. Add a **response size cap** — if aggregated data exceeds 50KB of JSON, truncate and include a warning
  4. Document the rate limit assumption (test with real API) and make it configurable:
     ```typescript
     interface PaginatedFetchOptions {
       maxRecords?: number;        // default: 100
       maxPages?: number;          // default: 8 — hard stop
       interPageDelayMs?: number;  // default: 200 — rate limit protection
     }
     ```

### 2. Resource URI scheme `whoop://` conflicts with MCP protocol expectations

- **File:** `docs/specs/v2-feature-enhancements.md` (Feature 1: MCP Resources)
- **Problem:** The MCP specification and SDK examples use URIs that reflect the *resource location* semantics (e.g., `file:///path`, `https://example.com/data`, or custom schemes registered via templates). The proposed `whoop://recovery/today` scheme is fine syntactically but has issues:

  1. **No versioning** — if the resource shape changes in V3, there's no way to distinguish. Should be `whoop://v2/recovery/today` or `whoop://user/recovery/today`.
  2. **`whoop://recovery/today` is temporal** — "today" changes meaning over time, which conflicts with URI identity semantics. A resource URI should ideally identify a *thing*, not a temporal query. The MCP protocol expects resources to be somewhat stable references.
  3. **No user scoping** — if multi-user support is added in V3 (listed as non-goal but future), these URIs have no namespace for it.
  4. **The `whoop://profile` resource lacks the hierarchical pattern** — others are `whoop://domain/qualifier`, but this is just `whoop://profile`.

- **Fix:** Use a consistent hierarchical scheme:
  ```
  whoop://user/recovery/latest
  whoop://user/sleep/latest
  whoop://user/cycle/current
  whoop://user/profile
  ```
  This is more semantically correct (`latest` instead of `today` — the resource returns the most recent regardless of calendar date), extensible for multi-user, and consistent in hierarchy. Alternatively, document that "today" means "most recent scored record" rather than "today's calendar date" — this distinction matters when a user checks at 6am before today's recovery is scored.

---

## Important Issues

### 3. `get_weekly_summary` makes 4 concurrent endpoint calls with no coordination

- **File:** `docs/specs/v2-feature-enhancements.md` (Feature 3, Tool: `get_weekly_summary`)
- **Problem:** The tool calls `/v2/recovery`, `/v2/activity/sleep`, `/v2/activity/workout`, and `/v2/cycle` — likely via `Promise.all` for performance. But:
  - If one endpoint fails (e.g., 429), the entire tool fails — no partial results
  - All 4 use `fetchAllPages` internally, so worst case is 4 × 4 pages = 16 sequential API calls
  - No acceptance criterion specifies partial failure behavior

- **Fix:** Add acceptance criteria:
  - [ ] If one endpoint returns a 429 or transient error, retry that endpoint (existing backoff) without abandoning others
  - [ ] If one endpoint permanently fails, return partial data with a clear warning indicating which metric is missing
  - [ ] Specify concurrency limit (e.g., 2 concurrent endpoints, not 4) to reduce burst rate

### 4. Implementation order has a dependency inversion — Resources should come before Analytical Tools

- **File:** `docs/specs/v2-feature-enhancements.md` (Implementation Order table)
- **Problem:** The spec orders:
  - 4: Analytical tools (depends on auto-pagination + date handling) ✓
  - 5: MCP Resources
  - 6: MCP Prompts (depends on Resources + tools) ✓

  But the `health_check` prompt (Feature 2) references Resources (`whoop://recovery/today`, `whoop://sleep/last`). If Resources are built in step 5 and Prompts in step 6, this works. However, the analytical tools (step 4) are the *hardest* feature and would benefit from being validated against real resource data patterns first. More importantly:
  - Resources (step 5) are the **highest-priority user request (P0)** per the market research
  - Resources are simpler (Low-Medium complexity) than analytical tools (High complexity)
  - Shipping Resources first unblocks user value faster and validates the SDK resource API before building the harder features

- **Fix:** Reorder to:
  | # | Feature | Rationale |
  |---|---------|-----------|
  | 1 | Auto-pagination | Foundational utility |
  | 2 | Enhanced date handling | Foundational utility |
  | 3 | MCP Resources | P0, validates SDK API, low risk |
  | 4 | Individual record lookup | Low complexity, standalone |
  | 5 | Analytical tools | High complexity, depends on 1+2 |
  | 6 | MCP Prompts | Depends on all above |

### 5. `compare_periods` is over-scoped — periods of different lengths add normalization complexity

- **File:** `docs/specs/v2-feature-enhancements.md` (Feature 3, Tool: `compare_periods`)
- **Problem:** The acceptance criterion says "handles periods of different lengths (normalizes per-day)". This sounds simple but introduces edge cases:
  - Normalizing a 3-day period vs a 30-day period produces misleading statistics (small sample vs large sample)
  - Should it warn when periods differ by >2x in length?
  - "Unchanged" threshold is undefined — is ±1% unchanged? ±5%?
  - No minimum data points criterion (what if period_a has 0 scored recoveries?)

  Additionally, this tool requires 3 endpoints × 2 periods × paginated = potentially 12+ API calls for a single invocation. The use case is real ("am I improving?") but `get_trend` already covers this more elegantly — a 30-day trend with direction already answers "am I improving?" without needing explicit period boundaries.

- **Fix:** Either:
  - (a) Remove `compare_periods` from V2 scope and let `get_trend` serve this use case (simpler)
  - (b) Constrain it: require periods of equal length, set minimum 3 data points, define "unchanged" as ±3%, and add a max period length of 30 days

### 6. Enhanced date handling: "yesterday" resolution is ambiguous across timezones

- **File:** `docs/specs/v2-feature-enhancements.md` (Feature 6: Enhanced Date Handling)
- **Problem:** The spec says "Timezone-aware: uses system timezone for 'today'/'this week' resolution" but:
  - MCP servers run as background processes — `Intl.DateTimeFormat().resolvedOptions().timeZone` may not match the user's actual timezone
  - The WHOOP API itself uses UTC internally and the user's WHOOP-configured timezone for display
  - If the server runs in Docker or cloud (V3 goal), system timezone is UTC
  - The acceptance criterion `"yesterday" resolves to full day (00:00 to 23:59:59)` should actually be `00:00:00.000Z to 23:59:59.999Z` but *in what timezone?*

- **Fix:** 
  1. Add an optional `timezone` parameter to the date resolution utility (defaults to system timezone)
  2. Document the limitation: "Date resolution uses the server's system timezone. For cloud deployments, configure TZ environment variable."
  3. Consider using the user's WHOOP profile timezone (available via `/v2/user/profile/basic` — though it may not include timezone; verify)
  4. Add acceptance criterion: "When timezone cannot be determined, defaults to UTC with a warning"

### 7. Missing acceptance criteria across multiple features

- **File:** `docs/specs/v2-feature-enhancements.md` (multiple features)
- **Problem:** Several important behaviors lack explicit acceptance criteria:
  - **Resources:** No criterion for what happens when the OAuth token is expired and resource read triggers refresh — does it block? Error?
  - **Resources:** No cache invalidation strategy specified for `whoop://profile` (1hr cache) — what cache store? In-memory? Survives server restart?
  - **Analytical tools:** No criterion for how `get_weekly_summary.sport_breakdown` handles unknown sport IDs from WHOOP
  - **Auto-pagination:** No criterion for behavior when WHOOP API returns a `next_token` that loops infinitely (malformed pagination)
  - **Individual record lookup:** No criterion for what happens with `cycle_id: 0` or negative IDs
  - **Date handling:** No criterion for what `"last 0 days"` or `"last -1 days"` produces

- **Fix:** Add these acceptance criteria:
  - [ ] Resources: expired token triggers automatic refresh (same flow as tools); read blocks until refresh completes or fails
  - [ ] Resources: profile cache is in-memory Map with TTL; cleared on server restart (acceptable for stateless stdio process)
  - [ ] Auto-pagination: detect loop (same `next_token` returned twice) and abort with error
  - [ ] Date handling: non-positive day counts return validation error

---

## Suggestions

### 1. Consider resource subscriptions for real-time updates

- **File:** `docs/specs/v2-feature-enhancements.md` (Feature 1)
- The MCP SDK v1.29.0 supports `resources/subscribe` — when a client subscribes, the server can push notifications on change. Since recovery scores update ~once daily, this could eliminate redundant polling. Not critical for V2 but worth noting as a low-effort enhancement during implementation.

### 2. `get_trend` confidence thresholds should be documented

- **File:** `docs/specs/v2-feature-enhancements.md` (Feature 3, Tool: `get_trend`)
- The output has `confidence: "high" | "medium" | "low"` based on "R²" but no thresholds are specified. Engineers implementing this will need to decide: is R² > 0.7 "high"? > 0.4 "medium"? Define these in the spec to avoid implementation ambiguity.
- Suggested thresholds: high > 0.7, medium > 0.3, low ≤ 0.3

### 3. Prompts could include `completions` for dynamic argument suggestions

- **File:** `docs/specs/v2-feature-enhancements.md` (Feature 2)
- The MCP protocol supports argument `completions` — the server can suggest values for prompt arguments. For `weekly_health_review.days`, the server could suggest `[7, 14, 30]`. Minor UX improvement worth noting.

### 4. Consider a `get_recovery_by_id` tool alongside the other individual lookups

- **File:** `docs/specs/v2-feature-enhancements.md` (Feature 5)
- The spec adds `get_sleep_by_id`, `get_workout_by_id`, `get_cycle_by_id` but not `get_recovery_by_id`. WHOOP API likely supports `/v2/recovery/{cycleId}`. The asymmetry may confuse users who see recovery records in collections but can't drill into them.

### 5. The `date-utils.ts` placement in `src/tools/` may be wrong

- **File:** `docs/specs/v2-feature-enhancements.md` (Implementation Strategy, New Files)
- Date resolution is a shared utility used by both tools and potentially resources. Placing it in `src/tools/date-utils.ts` couples it to the tools layer. Consider `src/utils/date-utils.ts` or `src/api/date-utils.ts` since it transforms inputs before API calls.

### 6. Spec should reference the SDK version requirement

- The spec says "No New Runtime Dependencies" and notes the SDK already supports Resources + Prompts. But Open Question #1 asks "Does `@modelcontextprotocol/sdk` current version support Resources and Prompts in stdio transport?" — **Answer: Yes, confirmed. v1.29.0 (installed) has full `server.resource()` and `server.prompt()` APIs.** This open question can be closed.

---

## What's Done Well

- **Excellent market research section.** The competitive landscape table and user value ranking provide clear justification for each feature. This is a model for product-minded spec writing.
- **Output type definitions are precise.** The `WeeklySummary`, `PeriodComparison`, and `TrendAnalysis` interfaces are well-thought-out with appropriate discriminated unions for direction fields.
- **Non-Goals section is clear and well-reasoned.** Each deferral has a specific rationale, preventing scope creep.
- **"No new runtime dependencies" constraint is maintained.** Using native Date + pure TypeScript math for statistics is the right call for an MCP server that should stay lightweight.
- **File structure mirrors V1 conventions perfectly.** One file per resource/prompt/tool, test files mirror source.

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | 219 tests passing, all green |
| Build verified | ✅ | `tsc` clean |
| Typecheck verified | ✅ | `tsc --noEmit` clean |
| Lint verified | ✅ | ESLint clean |
| SDK compatibility | ✅ | v1.29.0 supports Resources + Prompts in stdio transport |
| Spec completeness | ⚠️ | Missing acceptance criteria identified (Issue #7) |
| Architecture | ⚠️ | URI scheme and rate limiting need redesign |

---

## Open Questions Resolved

| # | Question | Answer |
|---|----------|--------|
| 1 | Does SDK support Resources/Prompts in stdio? | **Yes** — confirmed v1.29.0 has `server.resource()` and `server.prompt()` with stdio transport |
| 5 | Locale-aware week start? | **ISO 8601 Monday start is correct** — matches WHOOP API behavior |

## Open Questions Remaining

| # | Question | Recommendation |
|---|----------|----------------|
| 2 | 7 days vs Monday-aligned? | Monday-aligned is correct for "weekly" semantics |
| 3 | Linear regression vs EMA? | Linear regression for V2; document slope units clearly |
| 4 | Max safe records before rate limit? | **Must test with real API before finalizing.** Propose conservative default of 75 records, 200ms inter-page delay |

---

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Critical | Auto-pagination has no rate limiting — can trigger 429s and memory issues | Spec revision required |
| 2 | Critical | Resource URI scheme lacks versioning and uses temporal `today` as identity | Spec revision required |
| 3 | Important | `get_weekly_summary` has no partial failure handling for multi-endpoint calls | Spec revision |
| 4 | Important | Implementation order should prioritize P0 Resources over High-complexity analytics | Spec revision |
| 5 | Important | `compare_periods` is over-scoped — consider removing or constraining | Spec revision |
| 6 | Important | Date handling timezone resolution is ambiguous for non-local deployments | Spec revision |
| 7 | Important | Missing acceptance criteria for edge cases across multiple features | Spec revision |
| 8 | Suggestion | Consider resource subscriptions | Backlog |
| 9 | Suggestion | Define R² confidence thresholds | Spec revision |
| 10 | Suggestion | Add `get_recovery_by_id` for symmetry | Spec revision |
| 11 | Suggestion | Move `date-utils.ts` to `src/utils/` | Implementation time |
| 12 | Suggestion | Close Open Question #1 (SDK confirmed) | Spec revision |
