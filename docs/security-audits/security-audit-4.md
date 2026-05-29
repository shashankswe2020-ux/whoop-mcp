# Security Audit Report #4

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-05-29
> **Scope:** Design-level security review of `docs/specs/v2-feature-enhancements.md` — MCP Resources, Prompts, analytical tools, auto-pagination, individual record lookup, enhanced date handling
> **Dependencies:** 7 known vulnerabilities (1 high, 6 moderate) — all in dev/transitive deps, fixable via `npm audit fix`

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 1 |
| Medium | 3 |
| Low | 2 |
| Info | 3 |

---

## Previous Audit Findings Status

Carried-over findings from Audit #3 (2026-04-13) and earlier:

| Finding | Status |
|---------|--------|
| Audit #3 MEDIUM-1: Empty-string refresh token bypasses shape validation | ⚠️ **OPEN** |
| Audit #2 LOW-1: Missing security response headers on callback server | ⚠️ **OPEN** |
| Audit #2 LOW-2: Windows `cmd /c start` lacks empty title guard | ⚠️ **OPEN** |
| Audit #2 LOW-3 / Audit #1 LOW-2: PKCE not implemented | ⚠️ **OPEN** |
| Audit #3 LOW-1: File path disclosure in diagnostic log messages | ⚠️ **OPEN** |

---

## Findings

### [HIGH-1] Auto-pagination without hard memory cap enables denial-of-service via memory exhaustion

- **Location:** Spec Feature 4 — `fetchAllPages()` utility
- **Description:** The spec defines `maxRecords` with a default of 100, but this is configurable and used internally by analytical tools for "all records in date range." A user querying `compare_periods` with two 90-day periods (spec allows up to 90 days in `get_trend`) would issue up to 180 days × multiple endpoints × up to 25 records/page, accumulating hundreds of records in memory arrays before processing.

  The WHOOP API paginates at 25 records per page. For a 90-day recovery query, that's ~90 records across 4 pages. But `compare_periods` fetches from 3 endpoints × 2 periods = 6 paginated fetches. All results are held in memory simultaneously.

  More critically, **the spec's `maxRecords` default is a developer knob, not a system boundary**. If analytical tools call `fetchAllPages` without passing `maxRecords` (relying on the default), a future refactor could raise the default or remove it.

  Additionally, malicious or confused AI clients could craft inputs that trigger excessive pagination:
  - `compare_periods` with `period_a` spanning years (no max duration validation in the Zod schema)
  - `get_trend` with `days: 90` across all 6 metric types in rapid succession

- **Impact:** Memory exhaustion on the MCP server process (typically running on the user's laptop). At ~2KB per recovery record × 1000 records, this is only ~2MB — so pure memory OOM is unlikely for a single query. **The real risk is WHOOP API rate limiting**: 90 days × 4 pages per endpoint × 3 endpoints = ~12 serial API calls per `compare_periods` invocation. An AI assistant in a loop could burn through rate limits in seconds.

- **Proof of concept:**
  ```
  User: "Compare my health data from Jan 1 2024 to Dec 31 2024 vs Jan 1 2025 to Dec 31 2025"
  → compare_periods fetches 365 days × 3 endpoints × 2 periods = ~6 paginated fetches with ~15 pages each = ~90 API calls
  → Likely triggers WHOOP 429 rate limits, blocking ALL user access
  ```

- **Recommendation:**
  1. **Hard cap on date range width** — enforce max 90 days per period in `compare_periods` Zod schema, and max 90 days in `get_trend` (already present). Add to `get_weekly_summary` as well.
  2. **Absolute maxRecords cap in `fetchAllPages`** — make `maxRecords` a hard ceiling (e.g., `const MAX_ABSOLUTE_RECORDS = 500`) that cannot be overridden by callers:
     ```typescript
     const ABSOLUTE_MAX_RECORDS = 500;
     const effectiveMax = Math.min(options.maxRecords ?? 100, ABSOLUTE_MAX_RECORDS);
     ```
  3. **Rate budget per tool invocation** — track API calls within `fetchAllPages` and abort if exceeding a budget (e.g., max 20 API calls per tool invocation).
  4. **Add `AbortSignal` support to `fetchAllPages`** — allow the MCP server to cancel long-running paginations if the client disconnects.

---

### [MEDIUM-1] Date parsing of natural language expressions is an injection surface for API parameter manipulation

- **Location:** Spec Feature 6 — Enhanced Date Handling (`date-utils.ts`)
- **Description:** The spec proposes accepting strings like `"last 7 days"`, `"this week"`, `"yesterday"` and resolving them to ISO 8601 start/end pairs. While the implementation is described as "pure TypeScript date resolution," the security concern is:

  1. **Regex/parsing escape**: If the date parser uses regex with complex alternation or string splitting, a carefully crafted input like `"last 99999 days"` could generate a start date far in the past, triggering excessive pagination when combined with auto-pagination.
  2. **No validation that resolved dates are sane**: The spec says ISO 8601 passes through unchanged. A malicious input like `"2000-01-01T00:00:00.000Z"` (26+ years of data) as a `start` parameter would bypass the relative-date parser but trigger massive pagination.
  3. **Locale-dependent parsing ambiguity**: The spec mentions timezone awareness using "system timezone." If the system timezone is incorrectly configured, `"today"` could resolve to a different calendar day than expected, causing data leakage across day boundaries.

- **Impact:** No code injection possible (this isn't `eval` — it's a date resolver). The risk is **parameter manipulation** that leads to excessive API calls (see HIGH-1) or slightly incorrect date boundaries that expose records from adjacent days.

- **Proof of concept:**
  ```
  Input: start = "last 99999 days"
  → Parser resolves to 2026-05-29 minus 99,999 days = ~1752-07-09
  → fetchAllPages attempts to fetch 274 years of data
  → Either hits maxRecords cap (safe) or overwhelms rate limits (if cap is too high)
  ```

- **Recommendation:**
  1. **Validate the `N` in `"last N days"` with Zod** — add `.refine()` or make it `z.number().max(365)` so the parser only accepts reasonable ranges:
     ```typescript
     // In date-utils.ts
     const MAX_RELATIVE_DAYS = 365;
     const daysMatch = input.match(/^last (\d+) days$/i);
     if (daysMatch) {
       const n = parseInt(daysMatch[1], 10);
       if (n > MAX_RELATIVE_DAYS) throw new Error(`Cannot query more than ${MAX_RELATIVE_DAYS} days`);
     }
     ```
  2. **Post-resolution date range validation**: After resolving any date expression (relative or ISO pass-through), validate that the range between `start` and `end` does not exceed a maximum (e.g., 365 days).
  3. **Explicit allowlist parsing** — only match the documented expressions. Any input not matching the allowlist AND not a valid ISO 8601 string should be rejected:
     ```typescript
     if (!isIso8601(input) && !matchesRelativeExpression(input)) {
       throw new ValidationError(`Unrecognized date expression: "${input}"`);
     }
     ```

---

### [MEDIUM-2] MCP Resources expose health data as ambient context without explicit user consent per-read

- **Location:** Spec Feature 1 — MCP Resources (`whoop://recovery/today`, `whoop://sleep/last`, etc.)
- **Description:** MCP Resources are designed to be read by the AI client **without the user explicitly invoking a tool**. Per the MCP protocol, a client can read any registered resource at any time during a conversation. This means:

  1. A connected MCP client (e.g., Claude Desktop, or a third-party MCP host) can silently read `whoop://recovery/today` and `whoop://sleep/last` without the user asking a health-related question.
  2. The resource data (HRV, sleep duration, recovery score) becomes part of the AI's context window, potentially included in model training data, error telemetry, or conversation logs depending on the client's privacy policy.
  3. There is no per-read consent mechanism in the MCP protocol — once a resource is registered, any connected client can read it.

  The spec says "Resources authenticate using the same OAuth token as tools" — this means the access control is binary: either the client has the OAuth token (and can read everything) or it doesn't.

- **Impact:** Privacy degradation. Users who grant OAuth access for explicit tool use may not expect their health data to be passively available as ambient context. A malicious or poorly-implemented MCP client could:
  - Log all resource values on every conversation turn
  - Include health metrics in error reports sent to third parties
  - Use health data for purposes beyond what the user intended

  This is not a vulnerability in the traditional sense (the user already granted OAuth access), but it represents a **consent model mismatch** — the user consented to tools (explicit invocation) not ambient data exposure.

- **Recommendation:**
  1. **Document the privacy implication** — add a section to README explaining that Resources expose data passively to connected AI clients.
  2. **Consider opt-in resource registration** — add a configuration flag (env var or CLI arg) to enable/disable Resources:
     ```typescript
     const ENABLE_RESOURCES = process.env.WHOOP_MCP_RESOURCES !== "false"; // opt-out
     ```
  3. **Add resource read logging** — log to stderr when a resource is read, so users can audit what the client is accessing:
     ```typescript
     console.error(`[MCP] Resource read: ${uri}`);
     ```
  4. **Consider MCP subscription/notification instead of polling** — use `resources/subscribe` so the server knows when a client starts reading. (Note: depends on MCP SDK support.)

---

### [MEDIUM-3] Individual record lookup tools accept user-controlled IDs without format validation

- **Location:** Spec Feature 5 — `get_sleep_by_id`, `get_workout_by_id`, `get_cycle_by_id`
- **Description:** The spec defines input schemas as:
  ```typescript
  z.object({ sleep_id: z.string() })  // No format constraint
  z.object({ workout_id: z.string() })
  z.object({ cycle_id: z.number() })
  ```

  The `sleep_id` and `workout_id` are used to construct API paths: `/v2/activity/sleep/{sleepId}`. If no format validation is applied, a crafted ID could contain path traversal characters:
  - `sleep_id: "../../../oauth/oauth2/token"` → URL becomes `/v2/activity/sleep/../../../oauth/oauth2/token`
  - After URL normalization by the HTTP stack, this could hit: `https://api.prod.whoop.com/oauth/oauth2/token`

  Whether this is exploitable depends on how the URL is constructed:
  - If using string concatenation: `${baseUrl}/v2/activity/sleep/${sleepId}` — the `../` would be resolved by the HTTP client or server, potentially reaching unintended endpoints.
  - If using `URL` constructor: path traversal is normalized, but may still reach unexpected endpoints within the same origin.

- **Impact:** Server-Side Request Forgery (SSRF) within the WHOOP API domain. An attacker controlling the MCP client could potentially:
  - Read data from non-v2 endpoints (if WHOOP has internal APIs on the same host)
  - Trigger unintended API operations (though the client only supports GET)
  - Bypass any endpoint-specific access controls

  Since the MCP client is controlled by the AI assistant (not an external attacker), exploitation requires a malicious MCP client or prompt injection convincing the AI to pass crafted IDs. The risk is limited but follows defense-in-depth principles.

- **Proof of concept:**
  ```typescript
  // Malicious tool call via prompt injection:
  get_sleep_by_id({ sleep_id: "../../oauth/oauth2/auth?client_id=evil&redirect_uri=http://attacker.com" })
  // URL becomes: https://api.prod.whoop.com/v2/activity/sleep/../../oauth/oauth2/auth?client_id=evil&...
  // After normalization: https://api.prod.whoop.com/oauth/oauth2/auth?client_id=evil&...
  // GET request with user's Bearer token sent to OAuth endpoint — token potentially reflected in response
  ```

- **Recommendation:**
  1. **Validate ID format** — WHOOP IDs appear to be numeric or alphanumeric. Add format validation:
     ```typescript
     z.object({ sleep_id: z.string().regex(/^[a-zA-Z0-9_-]+$/, "Invalid sleep ID format") })
     z.object({ workout_id: z.string().regex(/^[a-zA-Z0-9_-]+$/, "Invalid workout ID format") })
     z.object({ cycle_id: z.number().int().positive() })
     ```
  2. **Use URL-safe path construction** — encode the ID segment:
     ```typescript
     const path = `/v2/activity/sleep/${encodeURIComponent(sleepId)}`;
     ```
  3. **Validate constructed URL before sending** — verify the final URL starts with the expected base + expected path prefix:
     ```typescript
     const url = new URL(path, baseUrl);
     if (!url.pathname.startsWith("/v2/activity/sleep/")) {
       throw new Error("Invalid sleep ID — path traversal detected");
     }
     ```

---

### [LOW-1] Analytical tools aggregate data that amplifies temporal correlation attacks

- **Location:** Spec Feature 3 — `get_weekly_summary`, `get_trend`, `compare_periods`
- **Description:** Analytical tools return pre-computed statistical summaries (means, medians, trends, anomalies) that represent a concentrated view of the user's health over time. While each underlying data point is already accessible via collection tools, the aggregated view makes it easier to:
  - Identify health events (sudden HRV drops correlate with illness)
  - Track location patterns (workout times + strain patterns reveal daily routines)
  - Infer lifestyle changes (strain trend shifts after injury, etc.)

  The `anomalies` array in `get_trend` output explicitly flags unusual health days, which could correlate with sensitive life events.

- **Impact:** No new data exposure (the underlying records are already accessible), but the aggregation reduces the effort needed to profile a user from their health data. This matters in the context of MCP clients that may log tool responses or include them in training data.

- **Recommendation:**
  1. **Document in user-facing README** that analytical tools return concentrated health insights and which MCP clients are trusted.
  2. **Consider a `redact_anomalies` option** — allow users to opt out of anomaly detection if they find it overly revealing.
  3. **No code change required** — this is an informed-consent issue, not a vulnerability.

---

### [LOW-2] Profile resource cached for 1 hour creates stale-token-use window

- **Location:** Spec Feature 1 — `whoop://profile` resource with "1hr cache"
- **Description:** The spec proposes caching the profile resource for 1 hour. If the OAuth token is revoked or expires during that window, the cached data remains available without re-authentication. More importantly, if a user revokes access in their WHOOP app, the MCP server continues serving cached profile data for up to 1 hour after revocation.

  Additionally, the caching implementation needs to ensure the cache is per-token — if the server somehow switches tokens (e.g., after re-authentication), stale cached data from a previous session should not be served.

- **Impact:** Minimal — profile data is static (name, email). The window is bounded at 1 hour. However, the principle of "revocation should be immediate" is violated.

- **Recommendation:**
  1. **Invalidate cache on token refresh** — when `onTokenRefresh` fires, clear all resource caches.
  2. **Consider shorter cache** (5–15 minutes) or validate token is still active before serving cached data.
  3. **Per-token cache key** — include a hash of the access token in the cache key to prevent cross-session serving.

---

### [INFO-1] Token reuse across Resources and Tools is architecturally sound — no session fixation risk

- **Location:** Spec Feature 1 + all tools
- **Description:** The spec states "Resources authenticate using the same OAuth token as tools." This is the correct design — a single authenticated `WhoopClient` instance serves both resources and tools. There is no session fixation or token confusion risk because:
  - Only one user is authenticated per MCP server instance
  - The token is stored in a single `WhoopClient` instance (not per-resource or per-tool)
  - Token refresh updates the single source of truth
  - MCP servers run as single-user local processes (stdio transport)

- **Impact:** None. This is a positive observation confirming the token model is safe.

---

### [INFO-2] MCP Prompts are data-only templates — no execution risk

- **Location:** Spec Feature 2 — MCP Prompts
- **Description:** Prompts return message arrays that reference tools and resources by name. They do not execute tools, modify state, or handle user input. The AI client resolves the referenced tools/resources separately. No injection, no execution, no state modification.

- **Impact:** None. Prompts are static templates. The security boundary is maintained by the tool/resource handlers.

---

### [INFO-3] No new OAuth scopes required — attack surface unchanged

- **Location:** All V2 features
- **Description:** The spec explicitly states "No new OAuth scopes required." All V2 features use the same `read:*` scopes already granted. This means:
  - The token permission boundary is unchanged
  - No new write operations are possible
  - The blast radius of a stolen token is the same as V1
  - Users do not need to re-authorize

- **Impact:** Positive — the V2 features expand functionality without expanding the permission envelope.

---

## Positive Observations

1. **Safety cap on auto-pagination** — The spec includes a `maxRecords` default of 100, showing awareness of runaway pagination risk. With the hardening recommended in HIGH-1, this becomes a strong defense.
2. **No new runtime dependencies** — All analytical computation is pure TypeScript. This avoids supply chain risk from additional npm packages.
3. **Zod validation at every input boundary** — The spec consistently uses Zod schemas for all tool inputs, maintaining the V1 security posture.
4. **No write operations** — All V2 features are read-only, limiting the impact of any exploitation to data disclosure (not modification).
5. **Existing retry/backoff infrastructure** — The V1 API client already handles 429 and 401, which protects against cascading failures from auto-pagination.
6. **Token storage model unchanged** — `~/.whoop-mcp/tokens.json` with 0600 permissions remains the single credential store.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | High | Auto-pagination memory/rate-limit DoS | Hard cap on maxRecords (500 absolute), date range max (365 days), API call budget per invocation |
| 2 | Medium | Date parsing enables excessive pagination | Validate `N` in relative expressions (max 365), post-resolution range check |
| 3 | Medium | Resources expose data without per-read consent | Opt-in/opt-out config, read logging, document privacy model |
| 4 | Medium | ID parameters allow path traversal | Regex format validation, `encodeURIComponent`, URL prefix assertion |
| 5 | Low | Analytical aggregation amplifies profiling | Document in README, no code change needed |
| 6 | Low | Profile cache outlives token revocation | Invalidate cache on token refresh, per-token cache key |

---

## Unresolved Findings from Previous Audits

The following findings from Audits #1–#3 remain open and should be addressed alongside V2 work:

| Source | Severity | Finding |
|--------|----------|---------|
| Audit #3 | Medium | Empty-string refresh token bypasses shape validation |
| Audit #2 | Low | Missing security headers on callback server |
| Audit #2 | Low | Windows `cmd /c start` lacks title argument |
| Audit #2 | Low | PKCE not implemented in OAuth flow |
| Audit #3 | Low | File path disclosure in diagnostic logs |

---

## Recommendations for V2 Implementation

### Security Controls to Add Before V2 Ships

1. **`src/api/pagination.ts`** — Must include:
   - Absolute max records constant (non-overridable)
   - Per-invocation API call counter with budget
   - AbortSignal support for cancellation

2. **`src/tools/date-utils.ts`** — Must include:
   - Strict allowlist regex for relative expressions
   - Cap on relative day count (365)
   - Post-resolution range validation function
   - Rejection of any unrecognized input

3. **Individual record tools** — Must include:
   - Regex validation on string IDs (`/^[a-zA-Z0-9_-]+$/`)
   - `encodeURIComponent` on path parameters
   - URL prefix assertion after construction

4. **Resource registration** — Should include:
   - Opt-out environment variable (`WHOOP_MCP_RESOURCES=false`)
   - stderr logging on resource reads
   - Cache invalidation on token refresh

### Security Test Cases to Write

```typescript
// pagination.test.ts
it("should abort after reaching absolute max records");
it("should abort after exceeding API call budget");
it("should respect AbortSignal cancellation");

// date-utils.test.ts
it("should reject 'last 99999 days'");
it("should reject non-ISO non-relative strings");
it("should reject strings containing special characters");
it("should validate post-resolution range does not exceed max");

// get-sleep-by-id.test.ts
it("should reject sleep_id containing path traversal");
it("should reject sleep_id containing query parameters");
it("should encode special characters in ID");

// resources (integration)
it("should not register resources when WHOOP_MCP_RESOURCES=false");
it("should invalidate cache on token refresh");
```
