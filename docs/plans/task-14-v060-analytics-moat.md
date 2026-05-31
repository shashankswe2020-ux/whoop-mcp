# Task 14: v0.6.0 — Analytics Moat (Correlations + Webhooks)

> **Spec:** `docs/specs/v3-platform-enhancements.md` (Features 7–8)
> **Depends on:** Task 13 complete (v0.5.0 shipped, HTTP transport working)
> **Created:** 2026-05-31

---

## Overview

Two features that create differentiation: statistical correlations between health metrics (the unique analytical moat — competitors with more raw data don't compute this) and webhook management for push-based notifications. The correlation tool is the more complex piece; webhook management is gated on WHOOP API availability.

## Architecture Decisions

1. **Pearson correlation is pure TypeScript** — No statistical library. The formula is simple; a lookup table handles p-significance. All functions live in `src/tools/stats-utils.ts` (extending existing module).

2. **`sleep_consistency_vs_hrv` uses rolling 7-day windowed computation** — The X variable is the standard deviation of bedtimes within a rolling 7-day window. This requires 21 days minimum (7-day warmup + 14 paired observations). Enforced at the Zod schema level.

3. **Webhook management is gated** — A pre-implementation check verifies `/v2/webhook` endpoints exist in WHOOP's public API. If not available, the feature is deferred entirely (no stub registered).

4. **SSRF prevention uses DNS resolution** — String-level URL checks (no IP literals, HTTPS-only, port 443) PLUS actual DNS resolution to reject private/reserved IPs. This blocks DNS rebinding attacks.

5. **Inbound webhook signature verification uses HMAC-SHA256** — Gated on WHOOP's actual signing mechanism. If WHOOP doesn't provide signatures, this sub-task is skipped.

6. **`disclaimer` field always present** — Every correlation result includes "Statistical observation from your data, not medical advice." This is non-negotiable for health data.

---

## Dependency Graph

```
┌──────────────────────────────┐
│ 14a. Pearson r + p_significant│  ← Pure math utilities (no deps)
│      + stats-utils extension │
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│ 14b. get_correlations tool   │  ← Depends on stats functions
│      (all 5 correlation types)│
└──────────────┬───────────────┘
               │
               │     ┌──────────────────────────────┐
               │     │ 14c. Webhook types + SSRF    │  ← Independent of correlations
               │     │      validation              │
               │     └──────────────┬───────────────┘
               │                    │
               │     ┌──────────────▼───────────────┐
               │     │ 14d. manage_webhooks tool    │
               │     │      + signature verification│
               │     └──────────────┬───────────────┘
               │                    │
               └────────┬───────────┘
                        │
             ┌──────────▼──────────────┐
             │ 14e. Server integration │
             │      + verification     │
             └─────────────────────────┘
```

**Parallelism:** Tasks 14a–14b (correlations) and 14c–14d (webhooks) are independent tracks and can proceed in parallel.

---

## Task List

### Task 14a: Statistical Functions (Pearson r + Significance Table)

**Description:** Extend `src/tools/stats-utils.ts` with Pearson correlation coefficient, critical r-value lookup table, significance test, and correlation strength classification.

**Acceptance criteria:**
- [ ] `pearsonR(x, y)` returns correct coefficient (verified against hand-computed fixtures)
- [ ] `pearsonR` returns 0 when denominator is 0 (constant input)
- [ ] `R_CRITICAL_TABLE` covers n = 7 through n = 90
- [ ] `isSignificant(r, n)` uses floor-to-nearest-key lookup (conservative)
- [ ] `isSignificant` always returns `false` when n < 7
- [ ] `correlationStrength(r)` maps: |r| ≥ 0.7 strong, ≥ 0.4 moderate, ≥ 0.2 weak, else none
- [ ] `correlationDirection(r)` maps: r > 0 positive, r < 0 negative, r === 0 none
- [ ] Property test: perfectly correlated input (y = 2x + 3) → r = 1.0
- [ ] Property test: perfectly anti-correlated (y = -x) → r = -1.0
- [ ] Property test: random uncorrelated input (large n) → |r| < 0.3 (probabilistic)

**Verification:** `npm test -- tests/tools/stats-utils.test.ts`

**Dependencies:** None (extends existing stats-utils)

**Files:**
- `src/tools/stats-utils.ts` (modify — add correlation functions)
- `tests/tools/stats-utils.test.ts` (modify — add correlation tests)

**Estimated scope:** Small (2 files modified)

---

### Task 14b: `get_correlations` Tool

**Description:** New tool implementing all 5 correlation types with data fetching, alignment, windowed computation, insight generation, and disclaimer.

> **Note from review:** This is a large task (5 correlation types, each with different alignment logic). If it blocks, split into: (i) simple correlations (`sleep_duration_vs_recovery`, `hrv_vs_sleep_performance`) and (ii) offset/windowed types. Validate architecture on the simpler ones first.

**Acceptance criteria:**
- [ ] All 5 correlation types produce correct Pearson r values
- [ ] `sleep_duration_vs_recovery`: night N sleep → day N+1 recovery
- [ ] `strain_vs_next_day_recovery`: day N strain → day N+1 recovery (1-day offset)
- [ ] `hrv_vs_sleep_performance`: day N HRV → night N sleep performance
- [ ] `workout_strain_vs_recovery_drop`: workout strain → recovery delta (before vs after)
- [ ] `sleep_consistency_vs_hrv`: rolling 7-day std dev of bedtimes → next-day HRV
- [ ] Minimum 14 days enforced via Zod; 21 days for `sleep_consistency_vs_hrv`
- [ ] At least 7 valid paired data points required — fewer → "Insufficient paired data" error
- [ ] Zero-variance dataset (all identical values) returns r=0, strength="none" (no NaN/throw)
- [ ] Missing data points (days without score) excluded from correlation
- [ ] Exactly (min_days - 1) data points → clear Zod validation error
- [ ] `p_significant` uses R_CRITICAL_TABLE lookup
- [ ] `insight` string is grammatically correct with specific numbers
- [ ] `recommendation` is actionable, health-appropriate
- [ ] `disclaimer` always: "Statistical observation from your data, not medical advice."
- [ ] `data_points` array includes all paired values used in computation

**Verification:** `npm test -- tests/tools/get-correlations.test.ts`

**Dependencies:** Task 14a (statistical functions)

**Files:**
- `src/tools/get-correlations.ts` (create)
- `tests/tools/get-correlations.test.ts` (create)

**Estimated scope:** Large (complex alignment logic, 5 correlation types, insight generation)

---

### Task 14c: Webhook Types + SSRF Validation

**Description:** Define webhook API types and implement URL validation with DNS resolution for SSRF prevention.

**Acceptance criteria:**
- [ ] ⚠️ **PRE-CONDITION:** Verify WHOOP `/v2/webhook` endpoints exist (check developer.whoop.com)
- [ ] `WebhookListResult`, `WebhookCreateResult`, `WebhookDeleteResult` types defined
- [ ] `validateWebhookUrl()` rejects HTTP (requires HTTPS)
- [ ] `validateWebhookUrl()` rejects IP literals in hostname
- [ ] `validateWebhookUrl()` rejects non-443 ports
- [ ] `validateWebhookUrl()` rejects `file://`, `gopher://`, and credential-bearing URLs
- [ ] `validateWebhookUrl()` resolves DNS and rejects private IPv4 ranges
- [ ] `validateWebhookUrl()` rejects private IPv6 prefixes (::1, fe80:, fd, fc)
- [ ] All validation uses real `dns.lookup` (mocked in tests)

**Verification:** `npm test -- tests/tools/manage-webhooks.test.ts`

**Dependencies:** None (independent track)

**Files:**
- `src/api/webhook-types.ts` (create)
- `src/tools/manage-webhooks.ts` (create — validation only, partial implementation)
- `tests/tools/manage-webhooks.test.ts` (create — SSRF tests with mocked DNS)

**Estimated scope:** Medium (3 new files)

---

### Task 14d: `manage_webhooks` Tool + Inbound Signature Verification

**Description:** Complete the webhook management tool (list/create/delete actions) and add inbound signature verification for received webhook events.

**Acceptance criteria:**
- [ ] `action: "list"` returns all registered webhooks
- [ ] `action: "create"` with valid HTTPS URL registers webhook, returns created object
- [ ] `action: "create"` runs full SSRF validation before API call
- [ ] `action: "delete"` removes webhook by ID
- [ ] `action: "delete"` with invalid ID returns clear error
- [ ] Missing required fields per action → Zod validation error
- [ ] `verifyWebhookSignature()` validates HMAC-SHA256 (timing-safe)
- [ ] Missing signature header → 401
- [ ] Invalid signature → 401
- [ ] `WHOOP_WEBHOOK_SECRET` missing → webhook receiver disabled (not fatal)
- [ ] Replay protection: reject events > 5 min old (if timestamp header present)

**Verification:** `npm test -- tests/tools/manage-webhooks.test.ts`

**Dependencies:** Task 14c (types + SSRF validation)

**Files:**
- `src/tools/manage-webhooks.ts` (modify — complete implementation)
- `tests/tools/manage-webhooks.test.ts` (modify — add API mock tests + signature tests)

**Estimated scope:** Medium (1 file completed, tests expanded)

---

### Task 14e: Server Integration + Verification

**Description:** Register new tools, run full verification suite, ensure no regressions.

**Acceptance criteria:**
- [ ] `get_correlations` appears in tool listing
- [ ] `manage_webhooks` appears in tool listing (if WHOOP API verified)
- [ ] Both tools callable through MCP server
- [ ] All existing tests pass (no regression)
- [ ] TypeScript compiles cleanly
- [ ] Build succeeds
- [ ] Lint clean
- [ ] HTTP transport still works with new tools
- [ ] If webhook gate fails: skip 14c/14d, register only `get_correlations`, ship as v0.6.0 "Analytics"

**Verification:** `npm test && npm run typecheck && npm run build && npm run lint`

**Dependencies:** Tasks 14b, 14d

**Files:**
- `src/server.ts` (modify — register new tools)
- `tests/server.test.ts` (modify — integration tests)

**Estimated scope:** Small (2 files modified)

---

## Checkpoint: After Task 14e

- [ ] All tests pass
- [ ] `get_correlations` returns correct r values for all 5 types
- [ ] `p_significant` correctly uses lookup table
- [ ] `sleep_consistency_vs_hrv` enforces 21-day minimum
- [ ] `disclaimer` present on every correlation result
- [ ] Webhook SSRF validation blocks private IPs, IP literals, non-443 ports
- [ ] Webhook signature verification is timing-safe
- [ ] Tool count: 16 (14 + 2 new)
- [ ] Coverage: ≥ 90% on new files
- [ ] No regression in HTTP transport or existing tools

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| WHOOP webhook API doesn't exist on public API | Medium | Feature 8 is gated — skip entirely if unverified, ship correlations alone |
| WHOOP doesn't provide webhook signing secret | Low | Inbound verification sub-task deferred; log warning at startup |
| Pearson r fixture data mismatch | Low | Hand-compute 3 fixture datasets; cross-validate with known calculator |
| `sleep_consistency_vs_hrv` bedtime edge cases (pre-midnight vs post-midnight) | Medium | Normalize to minutes-from-midnight; wraparound at 4 AM (sleep after midnight is "late night") |
| Insufficient user data for correlations (< 14 days) | Low | Clear error message; Zod validation rejects at input |
| DNS resolution in webhook validation adds latency | Low | Acceptable for create operations (not on hot path); timeout at 5s |

---

## Files Delivered

| File | Action | Description |
|------|--------|-------------|
| `src/tools/stats-utils.ts` | Modify | Add pearsonR, isSignificant, R_CRITICAL_TABLE |
| `src/tools/get-correlations.ts` | Create | 5 correlation types + insight generation |
| `src/api/webhook-types.ts` | Create | Webhook API response types |
| `src/tools/manage-webhooks.ts` | Create | CRUD + SSRF validation + signature verification |
| `src/server.ts` | Modify | Register 2 new tools |
| `tests/tools/stats-utils.test.ts` | Modify | Correlation function tests |
| `tests/tools/get-correlations.test.ts` | Create | All 5 types + edge cases |
| `tests/tools/manage-webhooks.test.ts` | Create | SSRF + signature + API mocks |
| `tests/server.test.ts` | Modify | Integration tests |
