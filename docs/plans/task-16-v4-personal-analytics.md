# Task 16: V4 Personal Baseline Analytics

> **Next-release implementation (2026-09-10):** The user approved core reliability plus
> personal baselines and sleep debt. See the [0.7.0 release spec](../specs/v070-trustworthy-personal-analytics.md)
> and [execution checklist](task-17-v070-trustworthy-personal-analytics.md).
> The required subset of 16a/16b, plus 16d and 16e under the new contract, is implemented
> in the working tree. Remaining tasks stay in the backlog; the historical checklists
> below are not a claim that the entire foundation or ten-tool release is complete.
> The historical target/baseline below is not the current release commitment.
> Package metadata remains 0.6.1 until release verification. Standard mode now has
> 16 tools, four resources and five prompts; aggregate mode exposes five tools only.

> **Spec:** [`docs/specs/v4-personal-analytics.md`](../specs/v4-personal-analytics.md)
> **Historical target:** `0.6.0` (superseded as a next-release label). The backlog's `correlate_metrics` supersedes the never-built `get_correlations` from [task-14](task-14-v060-analytics-moat.md).
> **Historical baseline:** v0.5.2 — 14 tools, 4 resources, 5 prompts, 716 tests, lint/typecheck/build clean
> **Depends on (ready):** existing shipped utilities only — no dependency on task-14/15. Can start immediately.
> **Depends on:** existing `stats-utils.ts`, `api/types.ts`, `api/pagination.ts` (`fetchAllPages`), `date-utils.ts`, `get-calendar.ts`
> **Created:** 2026-06-11

---

## Overview

Add a personal-baseline analytics layer to the WHOOP MCP server: 10 new tools that interpret a
user's data against their own rolling baseline (illness early-warning, personal normals, sleep
debt, training load, weekday patterns, workout analytics, event readiness, travel impact, report
export, and arbitrary-pair lagged correlation). All computation is in-process pure TypeScript on
the existing read-only OAuth scopes — no new runtime dependencies, no new scopes, no external DB.

This plan covers **Tier 1 + Tier 2 + Tier 3** of the spec. **Tier 4** (`log_behavior` + CSV
import) is intentionally **out of scope here** — it introduces new persisted state and an
untrusted-input surface and is deferred to a separate gated plan pending a dedicated security
audit (spec D-5).

## Architecture Decisions

1. **Foundation-first, then vertical slices.** Shared math (`stats-utils.ts` extensions) and shared
   analytics conventions land first because every tool depends on them. After that, each tool is a
   self-contained vertical slice: handler + Zod schema (co-located) + tests + `server.ts`
   registration. This keeps each task to ~3 files and leaves the system green after every task.

2. **Shared conventions live in one module, not copy-pasted.** A new `src/tools/analytics-utils.ts`
   centralizes the cross-cutting rules the spec mandates: the canonical `DISCLAIMER` string, the
   SCORED-only + self-exclusion baseline filter, the cross-source wake-day key (reusing the
   `get-calendar` local-day logic), the `data_points` cap (security M-2), and the
   pagination-with-`truncated`-flag helper (`ABSOLUTE_MAX_RECORDS = 500`). Single source of truth =
   one place to test, no drift between tools.

3. **CSV writing (incl. formula-injection neutralizer) lives with its only current consumer,
   `generate_report`,** but is written as a standalone, exported, reuse-ready helper so the deferred
   Tier-4 import re-exports through the same code path (spec C-1). It is *not* hoisted into the
   foundation module because no other Tier 1–3 tool needs it.

4. **`correlate_metrics` supersedes the never-built `get_correlations`.** `get_correlations` was
   reserved on the roadmap but never implemented (confirmed: no `get-correlations.ts` in `src/tools`),
   so there is nothing to deprecate or alias — `correlate_metrics` ships clean (resolves D-4 with no
   migration work).

5. **Tools never modify each other.** Cross-tool reuse happens only through `analytics-utils.ts` and
   `stats-utils.ts`. No tool imports another tool.

6. **Each tool's acceptance criteria are defined in the spec.** This plan references the spec section
   per task rather than restating every bullet, and adds the verification command + dependency +
   file list. The spec is the contract; the plan is the execution order.

7. **The wake-day key is NET-NEW, not a reuse of `get-calendar`.** The shipped `get-calendar` (and
   `get-today`/`get-weekly-summary`) key days by **UTC** date (`iso.slice(0,10)`), NOT by
   `timezone_offset` local day. The spec's cross-source convention requires offset-based local-day
   keying, so 16b builds it from scratch and **documents the divergence** from the existing
   UTC-keyed tools (a follow-up may migrate those onto the shared key; out of scope here). Because
   `Recovery` carries no `start`/`timezone_offset` of its own (spec assumption #1), keying a recovery
   record to a local day requires joining it to its cycle via `cycle_id` — so the 16b helper takes
   cycle context, and every recovery-consuming tool (16c, 16g, 16l-a) must also fetch cycles.

8. **The `DISCLAIMER` convention is established here.** Confirmed: no existing tool emits a
   disclaimer, so there is no prior string to match and no competing convention to reconcile — 16b
   defines the single canonical string for all new interpretive tools.

---

## Dependency Graph

```
16a stats-utils extensions ──┐
                             ├──► 16c detect_anomalies ──┐
16b analytics-utils ─────────┤    16d get_baselines      │
  (DISCLAIMER, SCORED filter,│    16e get_sleep_debt     ├─► Checkpoint 1 (Tier 1)
   wake-day key, data_points │    16f get_training_load  │
   cap, truncated pagination)│    16g get_day_of_week     ┘
                             │
                             ├──► 16h get_workout_analytics ─┐
                             │    16i get_event_readiness    │
                             │    16j detect_travel_impact   ├─► Checkpoint 2 (Tier 2)
                             │    16k generate_report        │
                             │        (+ CSV neutralizer)    ┘
                             │
                             └──► 16l-a correlate_metrics core ──┐
                                  (pair engine + 3 scalar         ├─► Checkpoint 3 (Tier 3)
                                   presets + .refine)             │
                                  16l-b derived presets ──────────┘
                                  (sleep_consistency_vs_hrv,
                                   workout_strain_vs_recovery_drop)
                                            │
                                            ▼
                                  16m release wiring + cross-tool tests + verification
```

- **16a and 16b are independent of each other** and can be built in parallel (different files).
- **16c–16g tool LOGIC/tests are mutually independent**, but every tool task also edits `src/server.ts` (shared imports block + a `registerTool` block). The tool files + test files parallelize cleanly; the `server.ts` edits must be **serialized** (or batched into a single wiring step) to avoid merge churn.
- **16h–16k** follow the same pattern; `16k` (report) leans on 16b but not on stats.
- **16l-a/16l-b** depend on 16a (`pearsonR`/`isSignificant`) and 16b (wake-day key). Building them after 16g is a **recommended ordering** (16g exercises the wake-day key first) — not a hard import dependency.
- **16m** depends on everything.

---

## Task List

### Phase 0 — Foundation

#### Task 16a: `stats-utils.ts` extensions + property tests

**Description:** Add the pure statistical primitives the analytics tools need, alongside the
existing `mean`/`median`/`standardDeviation`/`linearRegression`/`detectAnomalies`/`trendDirection`.

**Acceptance criteria:**
- [ ] Exports `percentile(values, p)` — linear interpolation, `p ∈ [0,100]`, p0=min, p100=max, single-element returns that element, empty throws.
- [ ] Exports `zScore(value, mean, sd)` — returns `0` when `sd === 0` (no NaN).
- [ ] Exports `rollingWindow(values, size)` — full windows only; `n < size → []`; `size < 1` throws.
- [ ] Exports `pearsonR(x, y)` — bounded `[-1,1]`; zero-variance → `0`; length-mismatch throws.
- [ ] Exports `isSignificant(r, n)` via `R_CRITICAL_TABLE` floor-to-nearest-key; `n < 7 → false`.
- [ ] Exports `correlationStrength(r)` and `correlationDirection(r)`.
- [ ] Consistent with module behavior: empty array throws; `sd === 0` returns a defined value.

**Verification:** `npm test -- tests/tools/stats-utils.test.ts`

**Dependencies:** None

**Files:** `src/tools/stats-utils.ts` (modify), `tests/tools/stats-utils.test.ts` (modify)

**Estimated scope:** Medium (2 files, many property tests)

---

#### Task 16b: `analytics-utils.ts` shared conventions + tests

**Description:** Create the shared substrate every analytics tool reuses, so the spec's
cross-cutting rules are implemented and tested exactly once.

**Acceptance criteria:**
- [ ] Exports canonical `DISCLAIMER = "Statistical observation from your data, not medical advice."` (net-new convention — no existing tool emits a disclaimer; confirmed).
- [ ] Exports a SCORED-only filter and a baseline self-exclusion helper (excludes "current"/"latest" from the distribution it is compared against).
- [ ] Exports a cross-source **wake-day key** helper computing the local calendar day from `timezone_offset` (sleep → local `end`/wake day; cycle → local `start` day). **Built from scratch** — the shipped `get-calendar`/`get-today`/`get-weekly-summary` key by UTC `iso.slice(0,10)`, NOT offset-local; the helper's doc comment must state this divergence.
- [ ] Recovery has no `start`/`timezone_offset`: the helper accepts **cycle context** and keys a recovery record via its cycle (`cycle_id`). Documented so recovery-consuming tools know they must fetch cycles too.
- [ ] Exports a `capDataPoints` helper enforcing the documented default cap (security M-2); stats are computed on the full set, only the echoed array is capped.
- [ ] Exports a pagination helper that **imports/wraps** the existing `ABSOLUTE_MAX_RECORDS` and `fetchAllPages` (which already returns `truncated`) from `src/api/pagination.ts` — does NOT redefine them — sizing `maxRecords` to the window and surfacing `truncated` to the tool.
- [ ] No new runtime dependency; pure TS + existing utils only.

**Verification:** `npm test -- tests/tools/analytics-utils.test.ts`

**Dependencies:** None (independent of 16a)

**Files:** `src/tools/analytics-utils.ts` (new), `tests/tools/analytics-utils.test.ts` (new)

**Estimated scope:** Medium (2 files)

---

### Checkpoint: Foundation (after 16a, 16b)
- [ ] `npm test -- tests/tools/stats-utils.test.ts tests/tools/analytics-utils.test.ts` green
- [ ] `npm run typecheck && npm run lint` clean
- [ ] No NaN escapes any helper; all documented edge cases covered

---

### Phase 1 — Tier 1 Core Tools

> Each Tier 1 task = handler + co-located Zod schema + tests + `server.ts` registration. Acceptance
> criteria are the spec bullets for that tool (referenced); the checks below are the task-level
> "definition of done" plus its verification command.

#### Task 16c: `detect_anomalies`

**Description:** Illness/overtraining early-warning — compare today's HRV, RHR, and respiratory rate against the personal rolling baseline; flag |z| beyond threshold (default 2σ).

**Acceptance criteria:** Implements [spec §Tool 1.1](../specs/v4-personal-analytics.md) acceptance bullets, incl. today excluded from its own baseline, direction-aware notes, `sd===0 → z=0/normal`, missing-today → `current:null`, `< 7` points → insufficient-data, disclaimer present. (HRV/RHR come from recovery; respiratory rate from sleep — no wake-day join needed here since each metric uses its own latest SCORED record.)

**Verification:** `npm test -- tests/tools/detect-anomalies.test.ts`

**Dependencies:** 16a, 16b

**Files:** `src/tools/detect-anomalies.ts` (new), `tests/tools/detect-anomalies.test.ts` (new), `src/server.ts` (register)

**Estimated scope:** Medium (3 files)

---

#### Task 16d: `get_baselines`

**Description:** Personal normal ranges — mean/median/sd + p10/p25/p50/p75/p90 per metric, plus `latest` and `latest_percentile`.

**Acceptance criteria:** Implements [spec §Tool 1.2](../specs/v4-personal-analytics.md) bullets, incl. `latest_percentile` ranks `latest` **excluding `latest` itself**, `< 14` points per metric → `null` band, period reflects actual range, disclaimer present.

**Verification:** `npm test -- tests/tools/get-baselines.test.ts`

**Dependencies:** 16a, 16b

**Files:** `src/tools/get-baselines.ts` (new), `tests/tools/get-baselines.test.ts` (new), `src/server.ts` (register)

**Estimated scope:** Medium (3 files)

---

#### Task 16e: `get_sleep_debt`

**Description:** Cumulative sleep debt + bedtime/wake consistency + weekday-vs-weekend social jetlag.

**Acceptance criteria:** Implements [spec §Tool 1.3](../specs/v4-personal-analytics.md) bullets, incl. `needed_hours` = baseline+strain+nap (**excludes** `need_from_sleep_debt_milli`), `need_from_recent_nap_milli` summed as-is (negative preserved — proven by a nap fixture), `achieved` = light+SWS+REM, naps excluded from nightly debt, local-time consistency, `social_jetlag_minutes` null when one group, DST 23h/25h fixtures, `truncated` honored, the echoed `nights[]` array bounded by `capDataPoints` (M-2), disclaimer present.

**Verification:** `npm test -- tests/tools/get-sleep-debt.test.ts`

**Dependencies:** 16a, 16b

**Files:** `src/tools/get-sleep-debt.ts` (new), `tests/tools/get-sleep-debt.test.ts` (new), `src/server.ts` (register)

**Estimated scope:** Medium (3 files; most fixture-heavy of Tier 1)

---

#### Task 16f: `get_training_load`

**Description:** Coupled ACWR (7d vs 28d), monotony, and sustained high-strain + low-recovery streaks.

**Acceptance criteria:** Implements [spec §Tool 1.4](../specs/v4-personal-analytics.md) bullets, incl. **coupled** ACWR documented in `load_note`, `load_basis` enum (`strain` default / `kilojoule`), insufficient chronic (`<21/28` SCORED or `chronic_load===0`) → `acwr:null` + `acwr_zone:"insufficient_data"` + `provisional:true` (NOT undertraining), `monotony` null when `sd===0`, combined low-recovery-high-strain count, `truncated` honored, disclaimer present.

**Verification:** `npm test -- tests/tools/get-training-load.test.ts`

**Dependencies:** 16a, 16b

**Files:** `src/tools/get-training-load.ts` (new), `tests/tools/get-training-load.test.ts` (new), `src/server.ts` (register)

**Estimated scope:** Medium (3 files)

---

#### Task 16g: `get_day_of_week_patterns`

**Description:** Recovery/sleep/strain broken down by local weekday + weekday-vs-weekend deltas. **This is the first heavy consumer of the wake-day key helper — validates 16b before `correlate_metrics`.**

**Acceptance criteria:** Implements [spec §Tool 1.5](../specs/v4-personal-analytics.md) bullets, incl. local-weekday assignment via `timezone_offset` (recovery keyed through its cycle per 16b — this task fetches cycles + recovery + sleep), no-data days → `null` averages / `sample_size:0`, deltas from non-null aggregates only, highlights name lowest/highest recovery weekday, `<14` days → insufficient, disclaimer present.

**Verification:** `npm test -- tests/tools/get-day-of-week-patterns.test.ts`

**Dependencies:** 16a, 16b

**Files:** `src/tools/get-day-of-week-patterns.ts` (new), `tests/tools/get-day-of-week-patterns.test.ts` (new), `src/server.ts` (register)

**Estimated scope:** Medium (3 files)

---

### Checkpoint 1: Tier 1 Complete (after 16c–16g)
- [ ] `npm test` green (716 existing + Tier 1 new tests)
- [ ] `npm run lint && npm run typecheck && npm run build` clean
- [ ] All 5 Tier 1 tools registered with unique `snake_case` names and valid Zod schemas
- [ ] Every Tier 1 output carries the canonical disclaimer
- [ ] Review with human before proceeding to Tier 2

---

### Phase 2 — Tier 2 Nice-to-Have Tools

#### Task 16h: `get_workout_analytics`

**Description:** HR-zone distribution, strain-per-minute efficiency, per-sport rollups, time-of-day buckets.

**Acceptance criteria:** Implements [spec §Tool 2.1](../specs/v4-personal-analytics.md) bullets, incl. zone distribution ~100% (rounding documented), zero-duration guard, case-insensitive `sport` filter, local-time buckets, `<1` SCORED workout → insufficient, disclaimer present.

**Verification:** `npm test -- tests/tools/get-workout-analytics.test.ts`

**Dependencies:** 16a, 16b

**Files:** `src/tools/get-workout-analytics.ts` (new), `tests/tools/get-workout-analytics.test.ts` (new), `src/server.ts` (register)

**Estimated scope:** Medium (3 files)

---

#### Task 16i: `get_event_readiness`

**Description:** Project readiness toward a future event date from the recovery trend; suggest a taper window.

**Acceptance criteria:** Implements [spec §Tool 2.2](../specs/v4-personal-analytics.md) bullets, incl. `event_date` ISO-8601-only + today-or-future (relative expr rejected), correct `days_until_event`, reuse `linearRegression`/`trendDirection`, readiness **clamped [0,100]**, labeled heuristic, `<14` recovery points → insufficient, disclaimer present.

**Verification:** `npm test -- tests/tools/get-event-readiness.test.ts`

**Dependencies:** 16a, 16b

**Files:** `src/tools/get-event-readiness.ts` (new), `tests/tools/get-event-readiness.test.ts` (new), `src/server.ts` (register)

**Estimated scope:** Medium (3 files)

---

#### Task 16j: `detect_travel_impact`

**Description:** Detect timezone shifts from records and quantify recovery rebound days after travel.

**Acceptance criteria:** Implements [spec §Tool 2.3](../specs/v4-personal-analytics.md) bullets, incl. event on consecutive `timezone_offset` change ≥ threshold, `+HH:MM`/`-HH:MM` parsing, rebound = days to return within **±0.5σ** (`REBOUND_BAND_SD = 0.5`) of pre-travel recovery baseline mean (capped + flagged if never), no-travel → empty + message, `<14` days → insufficient, disclaimer present.

**Verification:** `npm test -- tests/tools/detect-travel-impact.test.ts`

**Dependencies:** 16a, 16b

**Files:** `src/tools/detect-travel-impact.ts` (new), `tests/tools/detect-travel-impact.test.ts` (new), `src/server.ts` (register)

**Estimated scope:** Medium (3 files)

---

#### Task 16k: `generate_report` (+ CSV formula-injection neutralizer)

**Description:** Export a date range as Markdown or CSV, returned **inline as a string** (no disk write by default, D-3). Includes the RFC-4180-safe CSV writer with formula-injection neutralization, written as a reusable exported helper (shared code path for future Tier-4 import per C-1).

**Acceptance criteria:** Implements [spec §Tool 2.4](../specs/v4-personal-analytics.md) bullets, incl. valid Markdown sections/tables, RFC-4180 CSV escaping, cells leading with `= + - @ \t \r` neutralized with `'` (fixture proving a legit `-5` is made inert, not corrupted), `sections` filter, inline-only (no implicit disk write), report body length bounded per `capDataPoints`/summary-first (M-2), empty range → "no data" notices not error, disclaimer in body.

**Verification:** `npm test -- tests/tools/generate-report.test.ts`

**Dependencies:** 16b (uses pagination/day-key + report assembly)

**Files:** `src/tools/generate-report.ts` (new), `tests/tools/generate-report.test.ts` (new), `src/server.ts` (register)

**Estimated scope:** Medium (3 files)

---

### Checkpoint 2: Tier 2 Complete (after 16h–16k)
- [ ] `npm test` green; `npm run lint && npm run typecheck && npm run build` clean
- [ ] All 4 Tier 2 tools registered; disclaimer present on each interpretive output
- [ ] CSV neutralizer fixtures pass (formula leads + negative-number non-corruption)
- [ ] No implicit disk writes from `generate_report`

---

### Phase 3 — Tier 3 Reconcile

> **Split rationale:** `correlate_metrics` is genuinely XL — the arbitrary-pair engine + 5-preset
> reproduction + `.refine()` is one shippable unit; the two **derived-series** presets
> (rolling-7-day bedtime-stddev series; workout-keyed recovery-delta) are each a distinct pipeline.
> They land as two tasks so each leaves the suite green. 16l-b extends the same tool file/schema
> registered in 16l-a (the preset enum is complete from the start; 16l-b fills in the two derived
> branches), so there is no second `server.ts` registration.

#### Task 16l-a: `correlate_metrics` — core (arbitrary pair + 3 scalar presets)

**Description:** The full tool surface: Zod schema with the complete `preset` enum + `x_metric`/`y_metric`/`lag_days` pair path, `.refine()` mutual-exclusion, wake-day alignment, the correlation engine, and the **3 scalar presets** expressible as plain metric pairs. The 2 derived presets are wired to return a clear "not yet implemented" guard until 16l-b (or are gated out of the enum until 16l-b — implementer's choice, documented).

**Acceptance criteria:** Implements the arbitrary-pair half of [spec §Tier 3](../specs/v4-personal-analytics.md), incl. `.refine()` mutual-exclusion (preset XOR x/y pair; lone `x_metric` rejected), shared wake-day alignment with `lag_days` (recovery keyed via cycle per 16b — fetches cycles), reuse `pearsonR`/`correlationStrength`/`correlationDirection`/`isSignificant`, self-correlation (`x===y && lag===0`) rejected, zero-variance → r=0/none, `<7` paired points → insufficient, `p_significant` via `R_CRITICAL_TABLE`, **3 scalar presets reproducible** via the pair path, `data_points` capped (M-2), disclaimer present.

**Verification:** `npm test -- tests/tools/correlate-metrics.test.ts`

**Dependencies:** 16a, 16b (recommended: after 16g)

**Files:** `src/tools/correlate-metrics.ts` (new), `tests/tools/correlate-metrics.test.ts` (new), `src/server.ts` (register)

**Estimated scope:** Medium (3 files)

---

#### Task 16l-b: `correlate_metrics` — derived-series presets

**Description:** Implement the two derived-series presets that cannot be expressed as a scalar pair: `sleep_consistency_vs_hrv` (X = rolling 7-day std-dev of bedtime) and `workout_strain_vs_recovery_drop` (Y = day-before → day-after recovery delta, keyed on workouts). Extends the 16l-a tool file; no new registration.

**Acceptance criteria:** Both derived presets reproduce the legacy `get_correlations` semantics (back-compat, no regression), `sleep_consistency_vs_hrv` enforces `days >= 21` (7-day warmup + 14 pairs), workout-keyed delta alignment correct, insufficient-data paths covered, `data_points` capped, disclaimer present. **All 5 presets now reproducible.**

**Verification:** `npm test -- tests/tools/correlate-metrics.test.ts`

**Dependencies:** 16l-a

**Files:** `src/tools/correlate-metrics.ts` (modify), `tests/tools/correlate-metrics.test.ts` (modify)

**Estimated scope:** Medium (2 files; fixture-heavy derived-series math)

---

### Checkpoint 3: Tier 3 Complete (after 16l-a, 16l-b)
- [ ] `npm test` green; all 5 presets reproduce expected results with annotated fixtures
- [ ] Mutual-exclusion + self-correlation rejections covered
- [ ] `npm run lint && npm run typecheck && npm run build` clean

---

### Phase 4 — Release Wiring

#### Task 16m: cross-tool tests, version bump, docs, full verification

**Description:** Wire up the release: shared cross-cutting tests, version/label, and docs. Reflects
the D-1 decision (default `0.6.0`).

**Acceptance criteria:**
- [ ] **GATE: D-1 is resolved by the human before any version/CHANGELOG/README edit.** This task hardcodes nothing until then; `0.6.0` is the default pending confirmation.
- [ ] **Shared disclaimer test** — one parametrized test asserts every new interpretive tool's output carries the exact canonical disclaimer string.
- [ ] **Server-registration integration test** — asserts all ~10 new tools are registered with unique `snake_case` names and valid Zod input schemas (catches an implemented-but-unwired tool).
- [ ] `package.json` version → `0.6.0` (or the human's D-1 choice); `CHANGELOG.md` entry added.
- [ ] `README.md` tool count and tool list updated (14 → 24).
- [ ] No new runtime dependencies in `package.json`; no new OAuth scopes in the auth request.
- [ ] Coverage thresholds met: `stats-utils.ts` and new analytics tools > 80%; overall > 70%.
- [ ] `CLAUDE.md` / `.github/copilot-instructions.md` implementation-status updated.

**Verification:** `npm test && npm run typecheck && npm run build && npm run lint` (+ `npm test -- --coverage`)

**Dependencies:** 16a–16l-b

**Files:** `tests/server.test.ts` (modify), `tests/tools/disclaimer.test.ts` (new), `package.json`, `CHANGELOG.md`, `README.md`, `CLAUDE.md`, `.github/copilot-instructions.md`

**Estimated scope:** Medium (docs + 2 test files)

---

### Checkpoint: Release Ready (after 16m)
- [ ] All acceptance criteria across 16a–16m met
- [ ] D-1 reflected in `package.json` + `CHANGELOG.md`
- [ ] Tool count updated everywhere (14 → 24)
- [ ] `npm test && npm run typecheck && npm run build && npm run lint` clean; coverage met
- [ ] Tier 4 confirmed out of scope (tracked separately, gated on security audit per D-5)
- [ ] Ready for human review / release

---

## Parallelization Opportunities

| Can run in parallel | Must be sequential |
|---------------------|--------------------|
| 16a ∥ 16b (different files) | 16a/16b before any tool |
| 16c–16g **tool files + test files** (logic is independent) | The `src/server.ts` registration edits for all tools (shared file) |
| 16h–16i–16j–16k **tool files + test files** | 16l-b after 16l-a (same file); 16m after all tools |

> **`server.ts` is a shared edit region.** Tool logic and tests parallelize, but every tool task
> also touches `src/server.ts` (imports + a `registerTool` block). Serialize those edits (or batch
> all registrations into one wiring step) to avoid merge churn. 16g before 16l-a is a **recommended**
> ordering (16g exercises the wake-day key first), not a hard import dependency.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Time-dependent tests flaky ("today"/relative ranges) | 🟡 Medium | `vi.useFakeTimers()` with a FIXED system time per spec; restore in `afterEach`. |
| DST math wrong in sleep-debt / day-of-week / travel | 🟡 Medium | Pin explicit reference offsets; 23h spring-forward + 25h fall-back fixtures (spec testing strategy). |
| Silent pagination truncation skews baselines | 🟡 Medium | 16b enforces explicit `maxRecords` + `truncated` flag; tool summaries note partial windows. |
| `correlate_metrics` is XL (engine + 5 presets + 2 derived pipelines) | 🟡 Medium | Split into 16l-a (core + 3 scalar presets) and 16l-b (2 derived presets); each ships green. |
| **Wake-day key diverges from UTC-keyed `get-calendar`/`get-today`/`get-weekly-summary`** | 🟡 Medium | The new offset-local key is intentionally different; 16b documents the divergence in the helper doc-comment; a follow-up may migrate the UTC-keyed tools. Cross-check expected day assignment in fixtures. |
| Recovery can't be local-day-keyed alone (no offset on the record) | 🟡 Medium | 16b helper takes cycle context and keys recovery via `cycle_id`; 16c/16g/16l-a fetch cycles alongside recovery. |
| Coverage dips below 80% on heavy-branch tools | 🟢 Low | Spec holds stats-utils + analytics tools to >80%; checkpoint gate in 16m. |

---

## Open Questions (carried from spec; block final scope)

| ID | Question | Plan default |
|----|----------|--------------|
| D-1 | Ship as `0.6.0` (Option A) or force `0.5.3`? | `0.6.0` — affects 16m version string only |
| D-2 | Tier 1+2+3 in-release, Tier 4 deferred? | Yes — Tier 4 not in this plan |
| D-3 | `generate_report` disk write? | No — inline string only (16k) |
| D-4 | `correlate_metrics` supersedes `get_correlations`? | Yes — nothing live to deprecate (16l-a) |
| D-5 | Tier 4 deferred to a separate gated plan? | Yes — security audit first |

## Out of Scope (this plan)

- **Tier 4** — `log_behavior`, behavior store, WHOOP CSV import/correlation. Separate gated plan pending security audit (spec D-5).
- **Webhooks** — pushed to `0.7.0` per spec Option A.
- **`generate_report` disk write** — only if D-3 flips to yes (would require a sandboxed dir + traversal rejection + security review).

## Acceptance Definition

This plan is "done" (ready to implement) when:
1. The human has resolved D-1 through D-5 (or accepted the defaults above).
2. `code-reviewer` and `test-engineer` sub-agents have reviewed this breakdown (see review note below).
3. The human approves the task order and scope.

---

## Sub-Agent Review Note (2026-06-11)

`code-reviewer` reviewed this breakdown against the live codebase; findings incorporated:

| Finding | Severity | Resolution in this plan |
|---------|----------|-------------------------|
| `get-calendar` keys by **UTC** (`iso.slice(0,10)`), not `timezone_offset` — "reuse" premise false | Critical | Decision 7 rewritten: wake-day key is net-new offset-local logic; documents divergence; risk re-rated Medium. |
| `Recovery` has no offset → can't be local-day-keyed alone | Important | 16b helper takes cycle context (keys via `cycle_id`); 16c/16g/16l-a fetch cycles. |
| `correlate_metrics` is genuinely XL | Important | Split into 16l-a (core + 3 scalar presets) and 16l-b (2 derived presets). |
| `data_points` cap (M-2) only wired into correlate | Important | Added `capDataPoints` to 16e, 16g, 16k acceptance. |
| Parallelization overstated — all tools edit `src/server.ts` | Important | Parallelization table corrected: tool/test files parallel, `server.ts` edits serialized. |
| `ABSOLUTE_MAX_RECORDS`/`truncated` already exist in `pagination.ts` | Minor | 16b imports/wraps them, does not redefine. |
| No existing tool emits a disclaimer; "identical to v3" moot | Minor | Decision 8 added: `DISCLAIMER` is established net-new here, no competing convention. |
| 16g-before-16l is a test-confidence preference, not a hard dep | Minor | Re-labeled "recommended ordering" in graph + parallelization note. |
| Plan hardcodes `0.6.0` while D-1 pending | Minor | 16m gains an explicit D-1-resolved gate before any version/doc edit. |

**Confirmed sound by the reviewer:** foundation-first ordering (16a/16b), vertical-slice integrity (each tool task leaves the system green), and keeping the CSV neutralizer with `generate_report` rather than hoisting it to foundation (correct YAGNI given Tier 4 is deferred).

`test-engineer` could not read files in its session (tooling limitation), so the test-strategy axis was validated directly against the spec's Testing Strategy section and the confirmed `tests/tools/` layout: every task's verification command maps to a real `tests/tools/*.test.ts` path; property tests (16a), fake-timers + DST fixtures (16e/16g/16j), the shared disclaimer test and server-registration test (16m), and the >80%/>70% coverage gate (16m) all trace to spec requirements. Open follow-up for implementers: `stats-utils` currently lacks `Number.isFinite` guards on inputs (NaN can propagate) — 16a should add finite-input guards to the new functions to honor the "no NaN" contract.
