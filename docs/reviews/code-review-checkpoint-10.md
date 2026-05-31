# Code Review Checkpoint 10: V3 Platform Enhancements Spec — Architectural Review

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-05-31
> **Scope:** `docs/specs/v3-platform-enhancements.md` — full spec review for architectural completeness
> **Test suite:** 433 tests passing (25 files), typecheck clean, build clean, lint clean
> **Baseline:** v0.3.1 shipped — 12 tools, 4 resources, 5 prompts

---

## Verdict: ❌ REQUEST CHANGES — 3 Critical, 7 Important, 6 Suggestions

**Overview:** A well-structured, ambitious spec with clear objectives and good competitive awareness. The release phasing is sound and the feature designs are mostly solid. However, there are three critical issues: (1) the "no new runtime dependencies" assumption is contradicted by SDK reality (the SDK already bundles Express, which changes the architectural decision space), (2) the OAuth connector spec hand-rolls JWT signing using `MCP_AUTH_TOKEN` as a secret, which is a weak key material strategy, and (3) the webhook management tool is a write operation that contradicts Assumption #4 ("we stay read-only"). Several important issues around caching conflicts with existing ResourceCache, missing multi-session auth model for HTTP transport, and incomplete acceptance criteria also need resolution before implementation.

---

## Critical Issues

### 1. Assumption #5 contradicted by SDK reality — Express/Jose already available

- **File:** `docs/specs/v3-platform-enhancements.md:41`
- **Problem:** Assumption #5 states "No new runtime dependencies beyond SDK + Zod." However, `@modelcontextprotocol/sdk@^1.12.1` already depends on `express@^5.2.1`, `jose@^6.1.3`, `pkce-challenge@^5.0.0`, `express-rate-limit@^8.2.1`, and `hono@^4.11.4`. These are transitive runtime dependencies already in the tree. The spec's Feature 4 (OAuth connector) proposes hand-rolling JWT signing and PKCE validation when the SDK provides `OAuthServerProvider` interface, auth router, and handlers (`/server/auth/router.ts`) that do this correctly.

  **Implication:**
  - The spec should use the SDK's built-in OAuth server infrastructure rather than hand-rolling an OAuth 2.1 AS.
  - The "no express" constraint is already violated at the SDK level — using it directly is free.
  - Hand-rolling auth when battle-tested SDK primitives exist is a security anti-pattern.

- **Fix:** Rewrite Assumption #5 to:
  ```
  5. No new DIRECT runtime dependencies — leverage SDK's transitive deps
     (express, jose, pkce-challenge) for HTTP transport and OAuth connector.
  ```
  Rewrite Feature 4/5 OAuth connector section to use `OAuthServerProvider` interface from `@modelcontextprotocol/sdk/server/auth/provider.js` and `mcpAuthRouter()` from `@modelcontextprotocol/sdk/server/auth/router.js`. This gives you metadata endpoints, PKCE validation, token exchange, and client registration for free.

### 2. Webhook management contradicts "read-only" assumption

- **File:** `docs/specs/v3-platform-enhancements.md:39` (Assumption #4) vs Feature 8 (line ~552)
- **Problem:** Assumption #4 explicitly states "We stay read-only — no write tools — because the public API is read-only." But Feature 8 (`manage_webhooks`) performs `POST /v2/webhook` (create) and `DELETE /v2/webhook/:id` (delete). These are write operations to the WHOOP API. The spec even acknowledges this: "This is a **write operation** on WHOOP's side."

  This creates an internal contradiction that could confuse implementers and may require verifying:
  1. Whether the public developer API actually exposes webhook management endpoints (Open Question #2 is unresolved)
  2. Whether the existing OAuth scopes cover webhook operations

- **Fix:** Either:
  - (A) Remove Assumption #4 and replace with "Read-only for health data; webhooks are infrastructure-level writes" — clearly differentiating health data writes (not available) from subscription management writes (potentially available).
  - (B) Move webhook management to a separate "verified" section gated on confirming the API exists.
  - (C) Add explicit verification step: "Before implementing Feature 8, confirm at developer.whoop.com that `/v2/webhook` endpoints exist and are accessible with current scopes."

### 3. `MCP_AUTH_TOKEN` reused as JWT signing secret — weak key material

- **File:** `docs/specs/v3-platform-enhancements.md:305`
- **Problem:** The spec states "`MCP_AUTH_TOKEN` used as JWT signing secret." This single value serves dual purposes: (1) bearer token for direct MCP client auth, and (2) HMAC key for signing JWTs in the OAuth connector. Problems:
  - A 32-byte hex string (`openssl rand -hex 32`) is technically sufficient key material, but coupling the bearer token identity with the JWT signing key means a leak of either compromises both.
  - If the bearer token is accidentally logged (auth headers in debug logs), the JWT signing key is also compromised.
  - The SDK's `jose` library supports proper asymmetric key generation — using it costs nothing.

- **Fix:** Separate the concerns:
  ```
  MCP_AUTH_TOKEN — Bearer token for authenticating MCP clients (direct HTTP)
  MCP_JWT_SECRET — Separate secret for signing OAuth connector JWTs (or use RS256 with auto-generated keypair)
  ```
  Better: Generate an ephemeral Ed25519 keypair at startup for JWT signing (in-memory, no config needed). Bearer token remains the only user-provided secret.

---

## Important Issues

### 1. Feature 9 (In-Memory Cache) duplicates existing ResourceCache

- **File:** `docs/specs/v3-platform-enhancements.md:653-702`
- **Problem:** V2 already implements `ResourceCache` in `src/resources/index.ts` with TTL, in-flight deduplication, and generation-based invalidation. Feature 9 specifies a new `src/cache/memory-cache.ts` with LRU eviction but doesn't mention integrating with or replacing the existing cache. This risks:
  - Two competing cache layers with different invalidation semantics
  - ResourceCache ignoring the new LRU cache (or vice versa)
  - Duplicate data in memory

- **Fix:** Feature 9 should explicitly state:
  - "Replace `ResourceCache` in `src/resources/index.ts` with the new `MemoryCache` from `src/cache/memory-cache.ts`"
  - "Resources and tools share the same cache instance"
  - "Generation-based invalidation from V2's ResourceCache is preserved in the new implementation"
  - Add acceptance criterion: "Existing resource cache behavior preserved (TTL, invalidation on token refresh)"

### 2. HTTP transport missing multi-session/multi-user architecture

- **File:** `docs/specs/v3-platform-enhancements.md:240-330`
- **Problem:** The current architecture (V2) is single-user: one OAuth token, one WhoopClient, one process. HTTP transport enables concurrent connections from multiple MCP clients. But the spec doesn't address:
  - Session management: Does each HTTP connection get its own `WhoopClient`? Or do all connections share one WHOOP user's token?
  - If shared (single WHOOP user, multiple MCP clients): cache invalidation needs no change, but rate limiting against WHOOP API needs coordination across sessions.
  - If multi-user (each MCP client authenticates as a different WHOOP user): the entire `createWhoopServer()` architecture needs to be session-scoped, not process-scoped.

  The Non-Goals section says "Multi-user support" is deferred, but the OAuth connector section implies claude.ai users authenticate through it — unclear if this is the same WHOOP user (server owner) or different users.

- **Fix:** Add explicit "Session Model" section to Feature 4:
  ```
  Session Model: Single WHOOP user, multiple MCP clients.
  All MCP clients (stdio + HTTP) access the same WHOOP account.
  The OAuth connector authenticates the MCP CLIENT (is this client authorized
  to use my WHOOP server?), not the WHOOP USER.
  WHOOP OAuth tokens remain server-side (token-store.ts), not per-session.
  ```

### 3. `get_calendar` day alignment is under-specified for sleep records

- **File:** `docs/specs/v3-platform-enhancements.md:154`
- **Problem:** Acceptance criterion says "Correctly aligns records to calendar days (sleep assigned to night before)" but doesn't define the assignment rule. WHOOP's sleep records have `start` and `end` timestamps that can span midnight. Questions:
  - Does a sleep starting at 11 PM on Jan 1 and ending 7 AM on Jan 2 belong to Jan 1 or Jan 2?
  - What about naps (short sleeps within a single day)?
  - The WHOOP API returns a `created_at` and `start`/`end` — which determines the calendar day?

- **Fix:** Add explicit rule: "Sleep is assigned to the calendar day containing the `end` timestamp (the day you woke up). This matches WHOOP's own UI which assigns last night's sleep to today's recovery." Add acceptance criterion for edge case: "Sleep spanning midnight correctly assigned to wake-up day."

### 4. `get_calendar` serialization constraint contradicts performance goal

- **File:** `docs/specs/v3-platform-enhancements.md:164`
- **Problem:** Acceptance criteria state "Serialized endpoint pagination (recovery → sleep → cycle, not parallel)" but don't explain why. For a 90-day request, this means:
  - Recovery: 4 pages × 200ms delay = ~800ms + RTT
  - Sleep: 4 pages × 200ms = ~800ms + RTT
  - Cycle: 4 pages × 200ms = ~800ms + RTT
  - Total: ~2.4s minimum for pagination alone (plus API latency)

  Parallelizing the three endpoint streams (while keeping pagination within each stream serial) would cut total time by ~3x with no rate-limit risk (they're independent endpoints).

- **Fix:** Change to: "Pagination within each endpoint is serial (next_token chaining). The three endpoint streams (recovery, sleep, cycle) MAY run in parallel since they're independent API endpoints." Add acceptance criterion: "90-day request completes in < 5s under normal API latency."

### 5. Correlations — `sleep_consistency_vs_hrv` requires windowed computation not specified

- **File:** `docs/specs/v3-platform-enhancements.md:497`
- **Problem:** The correlation `sleep_consistency_vs_hrv` correlates "sleep time variability (std dev of bedtimes)" with "average HRV." But Pearson r requires paired (x, y) observations per day. Standard deviation of bedtimes is a windowed aggregate (you need N days of bedtimes to compute one std-dev value). The spec doesn't define:
  - What window size for computing std-dev? (7 days? The full range?)
  - If it's the full range, you get exactly one x-value and one y-value — correlation is undefined.
  - If windowed (rolling 7-day), you need at least 14 + 7 = 21 days of data minimum.

- **Fix:** Define the computation explicitly:
  ```
  sleep_consistency_vs_hrv:
  - Window: rolling 7-day standard deviation of bedtime (time component only)
  - X: std-dev of bedtimes in 7-day window ending on day N
  - Y: HRV on day N+1
  - Minimum data: 21 days (7-day window + 14 paired observations)
  - Update minimum days in Zod schema for this correlation type: .min(21)
  ```

### 6. CLI setup writes to Claude Desktop config without backup

- **File:** `docs/specs/v3-platform-enhancements.md:399`
- **Problem:** "Claude Desktop config file merged (not overwritten) — preserves other MCPs" is good, but there's no mention of creating a backup before modification. If the merge logic has a bug, the user loses their entire MCP configuration.

- **Fix:** Add acceptance criterion: "Creates backup of existing config before modification (`claude_desktop_config.json.bak`)" and "If merge fails, original config is restored from backup."

### 7. Missing `MCP_TRANSPORT=http` + stdio simultaneous support

- **File:** `docs/specs/v3-platform-enhancements.md:241-243`
- **Problem:** The diagram shows stdio AND HTTP as separate modes selected by `MCP_TRANSPORT`. But a common deployment is Claude Desktop (local, stdio) + claude.ai web (remote, HTTP) accessing the SAME server. The spec doesn't support `MCP_TRANSPORT=both` or running both transports simultaneously.

  This matters because a user running locally with Claude Desktop might also want web access — but currently they'd need two separate server processes.

- **Fix:** Consider adding `MCP_TRANSPORT=both` (or make HTTP transport additive — always support stdio alongside HTTP). The SDK's `McpServer` already supports `.connect()` with multiple transports. Document the single-user constraint: "Both transports share the same WHOOP account."

---

## Suggestions

### 1. Feature 3 (Natural Language Dates) — consider `"last year"` and `"YYYY-MM"` month syntax

- **File:** `docs/specs/v3-platform-enhancements.md:192-228`
- Users naturally say "last year" and "January 2026" — these are low-cost additions to the regex allowlist.

### 2. `get_today` — include `last_workout` summary for completeness

- **File:** `docs/specs/v3-platform-enhancements.md:62`
- Open Question #5 asks about this. Recommendation: include last workout's `sport_name` and `strain` (no extra API call — it's in the cycle data). This makes "how am I doing?" much richer.

### 3. Docker HEALTHCHECK should use `curl` not `wget`

- **File:** `docs/specs/v3-platform-enhancements.md:345`
- `node:20-slim` doesn't include `wget` or `curl` by default. The healthcheck will fail silently. Use a Node.js script instead:
  ```dockerfile
  HEALTHCHECK CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
  ```

### 4. Write-safety pattern (Feature 10) — consider `idempotencyKey` in the interface

- **File:** `docs/specs/v3-platform-enhancements.md:715`
- For future write operations, idempotency keys prevent duplicate mutations on retry. Adding `idempotencyKey?: string` to `WritePreview<T>` now means the pattern is ready for production writes without another breaking change.

### 5. Rate limiting strategy for parallel API calls in `get_today` and `get_calendar`

- The existing API client has 429 retry with backoff, but `get_today` issues 3 parallel requests and `get_calendar` could issue 12+ total. Consider documenting the expected WHOOP rate limit (requests/minute) and adding a note that the parallel strategy stays within it.

### 6. OAuth connector — consider SDK's `ProxyOAuthServerProvider` for simplicity

- **File:** `docs/specs/v3-platform-enhancements.md:280-310`
- The SDK exports a `ProxyOAuthServerProvider` at `server/auth/providers/proxyProvider.js` that proxies OAuth to an upstream server. Since the MCP server already authenticates against WHOOP's OAuth, the connector could proxy through to WHOOP rather than issuing its own JWTs. This eliminates the need for a custom JWT layer entirely.

---

## What's Done Well

- **Release phasing is excellent** — v0.4.0 ships immediate user-visible value (composite tools) before tackling infrastructure (v0.5.0). This de-risks the schedule.
- **`get_correlations` is a genuine differentiator** — computing analytics over raw data provides unique value that "more tools" can't replicate. The Pearson r implementation is correctly specified with no-dependency pure math.
- **Security considerations table** is comprehensive and covers the right threats for each feature.
- **Assumption block with "correct these now" instruction** is an excellent practice for spec-driven development — it forces verification before implementation.
- **Non-Goals section** is honest and well-reasoned — explicitly declining private API access and multi-user support shows disciplined scope management.
- **Acceptance criteria are specific and testable** for most features — including edge cases like "brand new user with 0 days of data."

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Spec internal consistency | ❌ | Assumption #4 (read-only) contradicts Feature 8 (webhooks) |
| SDK capability verification | ⚠️ | HTTP transport ✅ confirmed. OAuth server ✅ confirmed (with Express). Assumption #5 needs update. |
| Architecture continuity | ⚠️ | Feature 9 cache conflicts with existing ResourceCache; HTTP session model unclear |
| Security model | ❌ | JWT signing key reuse, missing key separation |
| Feasibility | ✅ | All features implementable with current SDK + verified transitive deps |
| Acceptance criteria coverage | ⚠️ | 5 of 11 features have incomplete edge case coverage (see Important issues) |
| Test suite (current) | ✅ | 433 tests passing, typecheck clean, build clean, lint clean |

---

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Critical | Update Assumption #5 — acknowledge SDK transitive deps; rewrite OAuth connector to use SDK's `OAuthServerProvider` | Before implementation starts |
| 2 | Critical | Resolve Assumption #4 vs Feature 8 contradiction (webhooks are writes) | Before v0.6.0 planning |
| 3 | Critical | Separate `MCP_AUTH_TOKEN` from JWT signing key; use ephemeral keypair or separate secret | Before Feature 4 implementation |
| 4 | Important | Define relationship between Feature 9 cache and existing ResourceCache — replace or layer? | Before v0.7.0 planning |
| 5 | Important | Add session model section to Feature 4 (single-user, multi-client) | Before Feature 4 implementation |
| 6 | Important | Specify sleep day-alignment rule for `get_calendar` | Before Feature 2 implementation |
| 7 | Important | Allow parallel endpoint streams in `get_calendar` (pagination stays serial) | Before Feature 2 implementation |
| 8 | Important | Define windowed computation for `sleep_consistency_vs_hrv` correlation | Before Feature 7 implementation |
| 9 | Important | Add config backup requirement to CLI setup | Before Feature 6 implementation |
| 10 | Important | Consider `MCP_TRANSPORT=both` for simultaneous stdio + HTTP | Before Feature 4 implementation |
| 11 | Suggestion | Add "last year" and "YYYY-MM" to date expressions | v0.4.0 |
| 12 | Suggestion | Fix Docker HEALTHCHECK to use Node.js fetch (not wget) | v0.5.0 |
| 13 | Suggestion | Add `idempotencyKey` to write-safety pattern | v0.7.0 |
| 14 | Suggestion | Include last workout in `get_today` output | v0.4.0 |
| 15 | Suggestion | Document WHOOP rate limit assumptions for parallel requests | v0.4.0 |
| 16 | Suggestion | Evaluate SDK's `ProxyOAuthServerProvider` as simpler OAuth connector approach | v0.5.0 |

---

## Open Questions Resolved by This Review

| # | Question from Spec | Resolution |
|---|-------------------|------------|
| 1 | Does SDK support Streamable HTTP? | **Yes** — `StreamableHTTPServerTransport` in `server/streamableHttp.js`. No external framework needed (SDK bundles Express 5). |
| 3 | Reuse callback-server or separate? | **Separate** — SDK provides `OAuthServerProvider` interface + auth router. Implement that interface; don't reuse `callback-server.ts` (different lifecycle). |
| 6 | Hand-roll rate limiting or use library? | **SDK includes `express-rate-limit@^8.2.1`** — use it. No hand-rolling needed. |
