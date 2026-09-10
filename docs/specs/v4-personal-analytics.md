# Spec: WHOOP MCP Server — V4 Personal Baseline Analytics

> **Status:** Draft (awaiting human approval + sub-agent review)
> **Requested label:** `0.5.3`
> **Recommended label:** `0.6.0` (see [Versioning Decision](#versioning-decision) — these are features, not a patch)
> **Date:** 2026-06-11
> **Baseline:** v0.5.2 shipped — 14 tools, 4 resources, 5 prompts, 716 tests, lint/typecheck/build clean
> **Prior specs:** [v2-feature-enhancements.md](./v2-feature-enhancements.md), [v3-platform-enhancements.md](./v3-platform-enhancements.md)
> **Source of requirements:** r/whoop community pain-point synthesis (recurring post genres) cross-checked against the WHOOP v2 public API surface (profile, body measurement, cycles, recovery, sleep, workouts).

## Revision Log

- **2026-06-11 (rev 2)** — Human-review tightenings: (1) `get_training_load` reverted to **coupled** ACWR with explicit coupled-vs-uncoupled + log-scale-strain caveats in `load_note`, plus a `kilojoule` linear-load alternative basis; (2) added `provisional` flag (requires ≥ 21 of 28 SCORED chronic days for a reliable ratio); (3) insufficient chronic data → `acwr_zone: "insufficient_data"` (not "undertraining"); (4) `get_baselines.latest_percentile` now excludes `latest` from its own distribution (convention consistency); (5) `get_sleep_debt` documents `need_from_recent_nap_milli` as negative + adds a nap fixture, achieved pinned to stage sums; (6) `detect_travel_impact` rebound band fixed at ±0.5σ (`REBOUND_BAND_SD`); (7) Tier-4 CSV import reframed — formula-injection is an output guard in `generate_report`, not a parser concern.
- **2026-06-11 (rev 1)** — Initial draft + `code-reviewer` / `security-auditor` / `test-engineer` findings incorporated (see summary below).

---

## Objective

Add a **personal-baseline analytics layer** to the WHOOP MCP server so AI assistants can answer the questions WHOOP users actually ask — *"Am I getting sick?"*, *"Is my HRV normal for me?"*, *"Am I overtraining?"*, *"How much sleep debt have I built up?"*, *"Why is my Monday recovery always red?"* — grounded in each user's own rolling baseline rather than population averages.

**Target users:** AI assistant users (Claude Desktop, Claude Code, claude.ai web, Cursor) who want their WHOOP data interpreted *relative to their own normal*, not against generic numbers.

**Why this matters (the moat):** Competitors with raw data access don't compute personalized baselines, acute:chronic load ratios, sleep debt, or lagged correlations. WHOOP itself emphasizes that the signal is *your trend vs. your baseline*. These tools turn raw records into the interpretations users want, fully within WHOOP's read-only OAuth API (TOS-compliant, zero ban risk).

**Success looks like:**
- An assistant can flag an early illness signal (HRV/RHR/respiratory-rate deviation beyond ~2σ of a 30-day baseline) in one tool call.
- An assistant can state whether today's HRV is normal *for this user* with percentile context.
- An assistant can report cumulative sleep debt and weekday/weekend consistency ("social jetlag").
- An assistant can compute an acute:chronic workload ratio and flag sustained low-recovery + high-strain streaks.
- Every analytical answer carries a clear "not medical advice" disclaimer.

---

## Versioning Decision

The request labels this work **0.5.3**. Per SemVer, adding new MCP tools is a **MINOR** change (new backward-compatible functionality), not a PATCH. The roadmap in `v3-platform-enhancements.md` also already reserves **0.6.0** for `get_correlations` + webhooks.

**Recommendation:** Ship this analytics layer as **0.6.0** and reconcile the overlap:

| Option | Description | Tradeoff |
|--------|-------------|----------|
| **A (recommended)** | Ship V4 as **0.6.0**. Fold the planned `get_correlations` into V4 as the generalized `correlate_metrics` (Tier 3). Move webhooks to **0.7.0**. | Cleanest SemVer; one analytics release; resolves the `correlate_metrics`/`get_correlations` duplication. |
| **B** | Ship V4 as **0.6.0**, keep `get_correlations` *and* `correlate_metrics` separate. | Two overlapping correlation tools — confusing for the model and users. Not recommended. |
| **C** | Force the **0.5.3** label as requested. | Violates SemVer; collides with reserved 0.6.0; correlation duplication unresolved. |

**This spec is written assuming Option A.** If the human insists on the 0.5.3 label, the tool designs below are unchanged — only the version string and `CHANGELOG` heading differ.

> **OPEN DECISION D-1:** Confirm Option A (ship as 0.6.0, fold correlations in, push webhooks to 0.7.0) vs. forcing 0.5.3.

---

## Assumptions

```
ASSUMPTIONS:
1. All required fields exist on the WHOOP v2 API (VERIFIED against src/api/types.ts):
   - Recovery.score: recovery_score, hrv_rmssd_milli, resting_heart_rate,
     spo2_percentage?, skin_temp_celsius?
   - Sleep.score: respiratory_rate?, sleep_performance_percentage?,
     stage_summary, sleep_needed { baseline_milli, need_from_sleep_debt_milli, ... }
   - Sleep: start, end, timezone_offset, nap
   - Cycle.score: strain, kilojoule, average_heart_rate, max_heart_rate
   - Cycle: start, end?, timezone_offset
   - Workout.score: strain, kilojoule, zone_durations, average/max_heart_rate
   - Workout: sport_name, start, end, timezone_offset
2. No new OAuth scopes needed — existing six read: scopes cover all data.
3. No new RUNTIME dependencies — pure-TypeScript statistics (extend stats-utils.ts);
   Node built-ins (node:fs, node:path) only for generate_report file output and
   the GATED log_behavior store.
4. Node.js >= 20 remains the minimum (unchanged).
5. All computation stays in-process. No external DB. The only persistent local
   state introduced is the GATED behavior log (Tier 4), stored under
   ~/.whoop-mcp/ with 0600 perms — same directory and permission model as tokens.
6. The WHOOP journal (alcohol/caffeine/etc.) is NOT exposed by the v2 API. Behavior
   correlation is therefore a workaround: locally logged behaviors OR an uploaded
   WHOOP data-export CSV joined against live API data. (Tier 4, gated.)
7. Auto-pagination (fetchAllPages) and date parsing (date-utils) are reused as-is.
→ Correct these now or implementation proceeds with these.
```

---

## Tech Stack (unchanged)

- TypeScript ~5.x (strict, no `any`), Node.js >= 20, native `fetch`
- `@modelcontextprotocol/sdk`, Zod — no other runtime deps
- Vitest, ESLint, Prettier; build via `tsc`

## Commands (unchanged)

```bash
npm run build        # tsc
npm test             # vitest run
npm test -- --coverage
npm run lint
npm run typecheck
npm run dev
```

---

## Release Scope & Tiers

| Tier | Tools | Storage | Scopes | Status in this spec |
|------|-------|---------|--------|---------------------|
| **1 — Core** | `detect_anomalies`, `get_baselines`, `get_sleep_debt`, `get_training_load`, `get_day_of_week_patterns` | none | existing | Fully specced, MVP |
| **2 — Nice-to-have** | `get_workout_analytics`, `get_event_readiness`, `detect_travel_impact`, `generate_report` | report writes file (opt-in path) | existing | Specced; ship if Tier 1 lands cleanly |
| **3 — Reconcile** | `correlate_metrics` (generalizes the planned `get_correlations`) | none | existing | Specced; resolves D-1 overlap |
| **4 — Gated** | `log_behavior` + WHOOP journal CSV import & correlation | **new** local store (0600) | existing | Specced but **deferred** — needs security pass + human sign-off |

> **OPEN DECISION D-2:** Confirm Tier 1+2+3 ship in this release and Tier 4 is deferred to a follow-up (e.g. 0.6.1 or 0.7.0) pending a dedicated security audit of local behavior storage.

---

## Shared Foundations

### `stats-utils.ts` extensions (pure TypeScript, no deps)

Reuse existing `mean`, `median`, `standardDeviation`, `linearRegression`, `detectAnomalies`, `trendDirection`. Add:

| Function | Signature | Purpose |
|----------|-----------|---------|
| `percentile` | `(values: number[], p: number) => number` | **Linear-interpolation** percentile (p ∈ [0,100]); empty array throws; p0 = min, p100 = max; single element returns that element. |
| `zScore` | `(value: number, mean: number, sd: number) => number` | Standardized deviation; returns 0 when sd === 0. |
| `rollingWindow` | `(values: number[], size: number) => number[][]` | Yields full rolling windows of length `size`; when `values.length < size` returns `[]` (no partial windows); `size < 1` throws. |
| `pearsonR` | `(x: number[], y: number[]) => number` | Correlation coefficient (already specced for v0.6.0; lands here under Option A). |
| `isSignificant` | `(r: number, n: number) => boolean` | `R_CRITICAL_TABLE` lookup, floor-to-nearest-key (conservative). |
| `correlationStrength` / `correlationDirection` | `(r) => ...` | Strength/direction classification. |

All functions: empty array throws; `sd === 0` returns a defined value (no NaN propagation), consistent with existing module behavior.

### Output-size / privacy convention (security M-2)

Every tool result (including full `data_points` arrays and report bodies) is sent to the
LLM provider by the nature of MCP. To minimize routine health-PII exposure: cap
`data_points` arrays at a documented default length (the analysis stats are computed on
the full set; only the echoed array is capped) and keep report/summary bodies
summary-first. This is inherent to MCP, not new egress — but the new tools materially
increase volume, so caps are required, not optional.

### Baseline computation convention (shared by anomaly/baseline/training-load)

```
- Baseline window: rolling N days (default 30) of SCORED records only.
- "Today" / "current" / "latest" value is EXCLUDED from the baseline/distribution it
  is compared against (no self-contamination): baseline = records in [now - N days, today),
  current = today. `get_baselines.latest_percentile` ranks `latest` against the window
  EXCLUDING `latest` itself, consistent with this convention.
- Records with score_state != "SCORED" are excluded from all stats.
- Minimum data guard: each tool declares its minimum N of valid points; below that
  it returns a clear "insufficient data to establish a baseline" message, never NaN.
```

### Pagination convention (shared) — avoid silent truncation

`fetchAllPages` defaults to `maxRecords: 100`. Tools allowing windows up to 90–180 days
(and sleep can yield multiple records/day via naps) can exceed 100 records and be
**silently truncated**. Therefore:

```
- Each tool MUST pass an explicit maxRecords sized to its window, capped at the
  module's ABSOLUTE_MAX_RECORDS = 500.
- If a fetch hits the cap, the tool sets `truncated: true` in its output and the
  summary notes that results are based on a partial window. Never report a
  baseline/aggregate from a silently truncated set as if complete.
```

### Cross-source day-key convention (shared by correlate_metrics / day-of-week)

Recovery and cycle records are cycle-keyed; sleep is wake-day-keyed. To align metrics
from different endpoints on a common day index, all tools use the **`get_calendar`
wake-day convention**: a record is assigned to the local calendar day of its relevant
timestamp (sleep → `end`/wake-up day; recovery/cycle → cycle `start` local day),
computed via each record's `timezone_offset`.

### Disclaimer convention

Every Tier 1–4 tool that produces an interpretation includes the single canonical
string (identical to the v3 `get_correlations` design — one string, asserted by a
shared test across all tools):

```
disclaimer: "Statistical observation from your data, not medical advice."
```

---

## Tier 1 — Core Tools

### Tool 1.1 — `detect_anomalies` (illness early-warning)

| Field | Value |
|-------|-------|
| **MCP name** | `detect_anomalies` |
| **Description** | Compare today's HRV, resting heart rate, and respiratory rate against your personal rolling baseline and flag deviations that may signal illness, overtraining, or stress. |
| **Endpoints** | `/v2/recovery`, `/v2/activity/sleep` (respiratory rate lives on sleep score) |
| **Scopes** | existing (`read:recovery read:sleep`) |

**Input schema**
```typescript
z.object({
  baseline_days: z.number().int().min(7).max(90).optional()
    .describe("Rolling baseline window in days. Default: 30."),
  threshold_sd: z.number().min(1).max(4).optional()
    .describe("Std-deviation threshold to flag an anomaly. Default: 2."),
})
```

**Output shape**
```typescript
interface AnomalyReport {
  evaluated_at: string;            // ISO 8601
  baseline_days: number;
  threshold_sd: number;
  metrics: AnomalyMetric[];
  flagged: boolean;                // true if ANY metric breaches threshold
  summary: string;                 // e.g. "Respiratory rate +2.3σ above baseline — possible early illness signal"
  disclaimer: string;
}
interface AnomalyMetric {
  metric: "hrv" | "rhr" | "respiratory_rate";
  current: number | null;          // null if no scored value today
  baseline_mean: number | null;
  baseline_sd: number | null;
  z_score: number | null;
  direction: "above" | "below" | "normal";
  flagged: boolean;                // |z| > threshold_sd
  // Direction-aware note: elevated RHR/resp-rate or depressed HRV are the
  // illness-suggestive directions; the note reflects this.
  note: string;
}
```

**Algorithm**
1. Fetch baseline-window records (recovery + sleep), SCORED only, excluding today.
2. Compute `mean`/`sd` per metric. HRV & RHR from recovery; respiratory rate from sleep.
3. Today's values from the latest SCORED record(s).
4. `z = zScore(current, mean, sd)`. Flag when `|z| > threshold_sd`.
5. Direction-aware `note`: RHR↑ / resp-rate↑ / HRV↓ are illness-suggestive; the summary highlights the WHOOP-community-favored respiratory-rate signal first.

**Acceptance criteria**
- [ ] Flags HRV / RHR / respiratory-rate deviations beyond `threshold_sd` (default 2σ).
- [ ] Today's value excluded from its own baseline.
- [ ] Respiratory rate sourced from the most recent SCORED sleep; HRV/RHR from most recent SCORED recovery.
- [ ] Each metric reports `direction` and a direction-aware illness-suggestive `note`.
- [ ] `flagged` (top-level) true iff any metric breaches threshold.
- [ ] Fewer than 7 valid baseline points → "insufficient data" message, no NaN.
- [ ] `sd === 0` (constant baseline) → `z_score` 0, `direction` "normal", not flagged.
- [ ] Missing today value (no SCORED record yet) → `current: null`, metric not flagged, summary notes the gap.
- [ ] `disclaimer` present.
- [ ] Unit tests: flagged-up, flagged-down, normal, missing-today, constant-baseline, insufficient-data.

---

### Tool 1.2 — `get_baselines` (personal normal ranges)

| Field | Value |
|-------|-------|
| **MCP name** | `get_baselines` |
| **Description** | Return your personal rolling baseline and percentile bands for HRV, resting heart rate, respiratory rate, sleep duration, and recovery score — so "is this normal for me?" can be answered against your own history. |
| **Endpoints** | `/v2/recovery`, `/v2/activity/sleep` |
| **Scopes** | existing |

**Input schema**
```typescript
z.object({
  baseline_days: z.number().int().min(14).max(180).optional()
    .describe("Rolling baseline window in days. Default: 30."),
})
```

**Output shape**
```typescript
interface BaselineReport {
  period: { start: string; end: string; days: number };
  metrics: Record<BaselineMetricName, BaselineBand | null>; // null when insufficient data
  disclaimer: string;
}
type BaselineMetricName = "hrv" | "rhr" | "respiratory_rate" | "sleep_hours" | "recovery_score";
interface BaselineBand {
  sample_size: number;
  mean: number;
  median: number;
  std_dev: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  latest: number | null;            // most recent SCORED value
  latest_percentile: number | null; // where `latest` falls in the distribution (0–100)
}
```

**Acceptance criteria**
- [ ] Returns mean/median/sd + p10/p25/p50/p75/p90 per metric.
- [ ] `latest_percentile` ranks `latest` against the window EXCLUDING `latest` itself (consistent with the baseline self-exclusion convention).
- [ ] Metrics with < 14 valid points → `null` band (not partial/NaN).
- [ ] `period.start`/`end` reflect the actual data range used.
- [ ] `disclaimer` present.
- [ ] Unit tests: full bands, single-metric-insufficient, all-insufficient, latest-at-extremes (p≈0 / p≈100).

---

### Tool 1.3 — `get_sleep_debt`

| Field | Value |
|-------|-------|
| **MCP name** | `get_sleep_debt` |
| **Description** | Compute cumulative sleep debt (needed vs. achieved) and bedtime/wake-time consistency, including weekday-vs-weekend "social jetlag", over a date range. |
| **Endpoints** | `/v2/activity/sleep` |
| **Scopes** | existing |

**Input schema**
```typescript
z.object({
  days: z.number().int().min(3).max(90).optional()
    .describe("Days to analyze. Default: 14."),
  start: z.string().optional()
    .describe("Start date — ISO 8601 or relative ('last 14 days', 'this month')."),
})
```

**Output shape**
```typescript
interface SleepDebtReport {
  period: { start: string; end: string; days: number };
  nights_analyzed: number;
  total_debt_hours: number;          // sum of max(0, needed - achieved) across nights
  avg_nightly_debt_hours: number;
  consistency: {
    bedtime_std_dev_minutes: number; // variance of sleep-onset clock time
    waketime_std_dev_minutes: number;
    social_jetlag_minutes: number;   // |mean weekend midpoint - mean weekday midpoint|
  };
  nights: SleepDebtNight[];
  summary: string;
  disclaimer: string;
}
interface SleepDebtNight {
  date: string;                      // wake-up day (YYYY-MM-DD)
  needed_hours: number;              // sleep_needed total (baseline + debt + strain + nap)
  achieved_hours: number;            // asleep time (in-bed minus awake)
  debt_hours: number;                // max(0, needed - achieved)
}
```

**Algorithm notes (pinned definitions — no hedging)**
- **`needed_hours` = `baseline_milli + need_from_recent_strain_milli + need_from_recent_nap_milli`** (milli → hours). It **EXCLUDES `need_from_sleep_debt_milli`**. *Critical:* `need_from_sleep_debt_milli` is WHOOP's own running accumulation of prior nights' debt; including it and then re-summing `max(0, needed − achieved)` across the range would double-count and inflate `total_debt_hours` super-linearly. (See finding C1.) Note: `need_from_recent_nap_milli` is typically **negative** in the API (a recent nap *reduces* the night's need) — summing the fields handles this correctly; do NOT clamp, abs, or negate it.
- **`achieved_hours` = sum of scored asleep stages = `total_light_sleep_time_milli + total_slow_wave_sleep_time_milli + total_rem_sleep_time_milli`** (milli → hours). This is the chosen, single definition — cleaner than in-bed-minus-awake — and deliberately excludes awake and `total_no_data_time_milli`.
- Exclude `nap: true` records from nightly debt; the main night is the **longest non-nap SCORED sleep per wake-up day**.
- Clock time uses each record's `timezone_offset` so bedtime consistency reflects local time, not UTC.
- **Social jetlag (heuristic, not the clinical MSFsc):** absolute difference between mean sleep-midpoint on weekend nights (Sat/Sun wake-up) vs. weekday nights. Labeled a simplification in the summary.
- If only weekday OR only weekend nights exist, `social_jetlag_minutes` is `null` (cannot compute a cross-group difference).

**Acceptance criteria**
- [ ] `needed_hours` excludes `need_from_sleep_debt_milli` (uses baseline + strain + nap only); a fixture proves a multi-night range does NOT super-accumulate debt.
- [ ] `need_from_recent_nap_milli` is summed as-is (it is **negative** — a nap reduces need); a fixture with a nap-reduced-need night proves the negative value is preserved, not "fixed".
- [ ] `achieved_hours` = light + slow-wave + REM stage sums (awake and no-data excluded).
- [ ] `debt_hours` per night = `max(0, needed - achieved)` (never negative).
- [ ] Naps (`nap: true`) excluded from nightly debt computation; a fixture with a nap on a night proves exclusion.
- [ ] Bedtime/wake-time consistency computed in *local* time via `timezone_offset`.
- [ ] `social_jetlag_minutes` = |weekend midpoint − weekday midpoint|; `null` when only one group present.
- [ ] Nights without a SCORED main sleep are omitted from `nights` (and don't count toward `nights_analyzed`).
- [ ] < 3 valid nights → "insufficient data" message.
- [ ] Sleep crossing midnight assigned to wake-up day (consistent with `get_calendar`).
- [ ] `truncated` flag honored per the pagination convention.
- [ ] `disclaimer` present (canonical string).
- [ ] Unit tests: positive debt, zero debt (over-slept), nap exclusion, DST spring-forward (23h) and fall-back (25h) boundaries with a fixed reference offset, weekend-only data (`social_jetlag_minutes: null`).

---

### Tool 1.4 — `get_training_load`

| Field | Value |
|-------|-------|
| **MCP name** | `get_training_load` |
| **Description** | Compute acute:chronic workload ratio (7-day vs 28-day strain), training monotony, and flag sustained high-strain + low-recovery streaks — the established overtraining-risk signals. |
| **Endpoints** | `/v2/cycle` (daily strain), `/v2/recovery` (recovery for streak flagging) |
| **Scopes** | existing |

**Input schema**
```typescript
z.object({
  end: z.string().optional().describe("End date — ISO 8601 or relative. Default: now."),
  load_basis: z.enum(["strain", "kilojoule"]).optional()
    .describe("Load metric for ACWR. Default: 'strain' (0–21, nonlinear — heuristic). 'kilojoule' is a linear, energy-based alternative."),
})
// Coupled ACWR: acute = trailing 7 days; chronic = trailing 28 days (which INCLUDES the acute 7).
```

**Output shape**
```typescript
interface TrainingLoadReport {
  period: { start: string; end: string; days: number };
  load_basis: "strain" | "kilojoule";
  acute_load: number;                // mean daily load, trailing 7 days
  chronic_load: number;              // mean daily load, trailing 28 days (COUPLED — includes the acute 7)
  acwr: number | null;               // acute:chronic ratio; null when chronic data insufficient
  acwr_zone: "undertraining" | "optimal" | "elevated" | "high_risk" | "insufficient_data";
  provisional: boolean;              // true when < 21 of 28 chronic days are SCORED (ratio unreliable)
  monotony: number | null;           // mean daily load / sd of daily load (7-day); null when sd===0
  strain_streak: { length_days: number; threshold: number } | null; // consecutive high-strain days
  low_recovery_high_strain_days: number; // count in window of (recovery<34 AND strain>14)
  load_note: string;                 // states coupled-ACWR + strain-nonlinearity caveats
  summary: string;
  disclaimer: string;
}
```

**Algorithm notes**
- Daily load = the SCORED per-day value for the chosen `load_basis`: cycle `strain` (default) or cycle `kilojoule`.
- **Coupled ACWR:** `acute_load` = mean daily load over trailing 7 days; `chronic_load` = mean daily load over trailing 28 days, which **includes** the acute 7 (the standard 7:28 coupled ratio). The literature distinguishes *coupled* (acute ⊆ chronic) from *uncoupled* (non-overlapping) ACWR — this tool uses **coupled** and says so in `load_note`.
- **Strain is nonlinear:** WHOOP strain is a 0–21 *logarithmic* scale, so averaging it and ratio-ing the averages is a rougher heuristic than ACWR computed on linear load (sRPE/TRIMP/kilojoule). `kilojoule` is offered as a linear-energy alternative basis. `load_note` always states this caveat.
- ACWR = `acute_load / chronic_load`.
- **Insufficient chronic data:** if fewer than 21 of the 28 chronic-window days have a SCORED value (or `chronic_load === 0`), set `acwr: null`, `acwr_zone: "insufficient_data"`, and `provisional: true`. This is NOT "undertraining" — a brand-new user who just trained hard has high acute load and no chronic history; the summary says chronic history is too short for a reliable ratio.
- **`provisional`** is `true` whenever < 21 of 28 chronic days are present; any ratio shown should be read cautiously.
- ACWR zones (sports-science heuristic, applied only when not provisional): `< 0.8` undertraining, `0.8–1.3` optimal, `1.3–1.5` elevated, `> 1.5` high_risk.
- **Monotony** = mean / sd of the 7-day load series. Constant load (`sd === 0`) is *maximum* monotony (the unhealthy case), NOT zero — so return `null` with a "no day-to-day variation" note rather than `0` (which would misleadingly read as healthy variety). (See finding I2.)
- Streak = longest run of consecutive days with strain above a documented threshold (default 14).

**Acceptance criteria**
- [ ] `acute_load` = mean daily load over trailing 7 days; `chronic_load` over trailing 28 days (COUPLED — includes the acute 7), documented as coupled in `load_note`.
- [ ] `load_basis` selects `strain` (default) or `kilojoule`; both computed from SCORED cycles.
- [ ] `load_note` always present, stating both the coupled-ACWR choice and strain's 0–21 nonlinearity (heuristic).
- [ ] `acwr` = acute/chronic when chronic data sufficient; `null` otherwise.
- [ ] Insufficient chronic data (< 21 of 28 SCORED days OR `chronic_load === 0`) → `acwr: null`, `acwr_zone: "insufficient_data"`, `provisional: true` (NOT "undertraining").
- [ ] `provisional` is `true` when < 21 of 28 chronic days present.
- [ ] `acwr_zone` mapped per documented thresholds only when not provisional.
- [ ] `monotony` = mean/sd of 7-day load; `sd === 0` → `null` (not 0) with explanatory note.
- [ ] `low_recovery_high_strain_days` counts days meeting BOTH conditions.
- [ ] < 7 valid acute load days → "insufficient data".
- [ ] Missing days (no SCORED cycle) excluded from means; counts use available data, documented.
- [ ] `truncated` flag honored per the pagination convention.
- [ ] `disclaimer` present (overtraining heuristics are not medical advice).
- [ ] Unit tests: optimal/elevated/high-risk zones, brand-new-user-trained-hard (chronic insufficient → `acwr: null`, `acwr_zone: "insufficient_data"`, `provisional: true`, NOT undertraining), provisional (< 21 chronic days), constant load (`monotony: null`), `kilojoule` basis, streak detection, combined-flag counting.

---

### Tool 1.5 — `get_day_of_week_patterns`

| Field | Value |
|-------|-------|
| **MCP name** | `get_day_of_week_patterns` |
| **Description** | Break down recovery, sleep, and strain by day of week to surface patterns like "Monday recovery is consistently lower" or weekday-vs-weekend differences. |
| **Endpoints** | `/v2/recovery`, `/v2/activity/sleep`, `/v2/cycle` |
| **Scopes** | existing |

**Input schema**
```typescript
z.object({
  days: z.number().int().min(14).max(180).optional().describe("Lookback window. Default: 56 (8 weeks)."),
})
```

**Output shape**
```typescript
interface DayOfWeekReport {
  period: { start: string; end: string; days: number };
  by_day: Record<Weekday, DayAggregate>;     // Mon..Sun
  weekday_vs_weekend: {
    recovery_delta: number | null;           // weekend mean - weekday mean
    sleep_hours_delta: number | null;
    strain_delta: number | null;
  };
  highlights: string[];                        // e.g. "Lowest avg recovery: Monday (54%)"
  disclaimer: string;
}
interface DayAggregate {
  sample_size: number;
  avg_recovery: number | null;
  avg_sleep_hours: number | null;
  avg_strain: number | null;
}
```

**Acceptance criteria**
- [ ] Each weekday aggregates only SCORED records assigned to that local weekday (uses `timezone_offset`).
- [ ] Days with no data → `null` averages, `sample_size: 0`.
- [ ] `weekday_vs_weekend` deltas computed from non-null aggregates only.
- [ ] `highlights` names the lowest/highest recovery weekday and any notable weekend gap.
- [ ] < 14 days window → "insufficient data".
- [ ] `disclaimer` present.
- [ ] Unit tests: full week coverage, single-weekday-missing, weekend-vs-weekday delta sign.

---

## Tier 2 — Nice-to-Have Tools

### Tool 2.1 — `get_workout_analytics`

| Field | Value |
|-------|-------|
| **MCP name** | `get_workout_analytics` |
| **Description** | Analyze workouts over a range — HR-zone distribution, strain-per-minute efficiency, best/worst sessions by activity type, and time-of-day effects. |
| **Endpoints** | `/v2/activity/workout` |
| **Scopes** | existing |

**Input schema**
```typescript
z.object({
  days: z.number().int().min(7).max(180).optional().describe("Lookback window. Default: 30."),
  sport: z.string().optional().describe("Filter by sport_name (case-insensitive)."),
})
```

**Output (summary)**
- Aggregate zone-duration distribution (% time in zones 0–5) from `zone_durations`.
- `strain_per_minute` = strain / active minutes; best/worst sessions by this metric.
- Per-`sport_name` rollups (count, avg strain, avg duration).
- Time-of-day buckets (morning/afternoon/evening, local time via `timezone_offset`) with avg strain.

**Acceptance criteria**
- [ ] Zone distribution sums to ~100% (rounding documented).
- [ ] `strain_per_minute` guards zero-duration workouts (excluded, documented).
- [ ] `sport` filter case-insensitive; unknown sport → empty result with message.
- [ ] Time-of-day buckets use local time.
- [ ] < 1 SCORED workout in range → "insufficient data".
- [ ] `disclaimer` present.
- [ ] Unit tests: zone math, per-sport rollup, time-of-day bucketing, zero-duration guard.

---

### Tool 2.2 — `get_event_readiness`

| Field | Value |
|-------|-------|
| **MCP name** | `get_event_readiness` |
| **Description** | Given a target event date, project readiness from the recent recovery trend and suggest a taper window. |
| **Endpoints** | `/v2/recovery`, `/v2/cycle` |
| **Scopes** | existing |

**Input schema**
```typescript
z.object({
  event_date: z.string()
    .describe("Event date — ISO 8601 (YYYY-MM-DD) only. Must be today or in the future."),
  lookback_days: z.number().int().min(14).max(90).optional().describe("Recovery-trend window. Default: 28."),
})
```

> **Note:** `date-utils.resolveDateExpression` is backward-looking only (no "in 10 days"/"next Saturday"). Rather than add forward expressions (scope creep), `event_date` accepts an explicit ISO-8601 date only and is validated as today-or-future. (See finding I3.)

**Output (summary)**
- Recent recovery trend (slope/direction/confidence via existing `linearRegression` + `trendDirection`).
- `days_until_event` (rejects past dates at the schema/handler boundary).
- Projected readiness band (current baseline ± trend), **clamped to 0–100**, explicitly labeled a heuristic projection, not a prediction.
- Suggested taper window (e.g. reduce strain N days out) framed as general guidance.

**Acceptance criteria**
- [ ] `event_date` is ISO-8601 only; past dates → validation error; relative expressions rejected with a clear message.
- [ ] `days_until_event` correct (UTC day math).
- [ ] Trend reuses existing regression utilities.
- [ ] Projected readiness clamped to [0, 100] (no >100 or <0 from linear extrapolation).
- [ ] Projection clearly labeled heuristic, not medical/performance guarantee.
- [ ] < 14 valid recovery points → "insufficient data".
- [ ] `disclaimer` present.
- [ ] Unit tests: future event, today, past event rejected, relative-expression rejected, improving/declining/stable trend, extrapolation clamped at bounds, insufficient data.

---

### Tool 2.3 — `detect_travel_impact`

| Field | Value |
|-------|-------|
| **MCP name** | `detect_travel_impact` |
| **Description** | Detect timezone shifts from cycle/sleep records and quantify how many days recovery takes to rebound after travel (jet-lag recovery). |
| **Endpoints** | `/v2/cycle`, `/v2/recovery` |
| **Scopes** | existing |

**Input schema**
```typescript
z.object({
  days: z.number().int().min(14).max(180).optional().describe("Lookback window. Default: 60."),
  min_offset_change_hours: z.number().int().min(1).max(12).optional()
    .describe("Minimum timezone-offset change (hours) to count as travel. Default: 2."),
})
```

**Output (summary)**
- Detected travel events: date, offset change (hours), direction (east/west).
- Per-event recovery rebound: days until recovery returns to within the rebound band of the pre-travel baseline mean. **Rebound band = ±0.5σ of the pre-travel recovery baseline** (module constant `REBOUND_BAND_SD = 0.5`).
- Aggregate avg rebound days.

**Acceptance criteria**
- [ ] Travel event detected when consecutive-record `timezone_offset` change ≥ `min_offset_change_hours`.
- [ ] Offset parsed from WHOOP's `+HH:MM` / `-HH:MM` string format.
- [ ] Rebound = days for recovery to return within ±0.5σ (`REBOUND_BAND_SD = 0.5`) of the pre-travel recovery baseline mean; capped (and flagged) if it never recovers within the window.
- [ ] No travel events → empty list with clear message.
- [ ] < 14 days → "insufficient data".
- [ ] `disclaimer` present.
- [ ] Unit tests: eastward/westward detection, sub-threshold ignored, rebound counting at the ±0.5σ band, never-rebounds-in-window (capped + flagged), no-travel case, offset-string parsing.

---

### Tool 2.4 — `generate_report`

| Field | Value |
|-------|-------|
| **MCP name** | `generate_report` |
| **Description** | Export a date range of WHOOP data as Markdown or CSV — addresses the long-standing data-export frustration. |
| **Endpoints** | `/v2/recovery`, `/v2/activity/sleep`, `/v2/cycle`, `/v2/activity/workout` |
| **Scopes** | existing |

**Input schema**
```typescript
z.object({
  format: z.enum(["markdown", "csv"]).describe("Output format."),
  days: z.number().int().min(1).max(180).optional().describe("Lookback window. Default: 30."),
  start: z.string().optional().describe("Start date — ISO 8601 or relative."),
  sections: z.array(z.enum(["recovery", "sleep", "strain", "workouts"])).optional()
    .describe("Which sections to include. Default: all."),
})
```

**Output / behavior**
- Returns the report content **inline as a string** in the tool result (the primary, safe path — the assistant presents/saves it).
- File-write to disk is **NOT** done by default. (Writing arbitrary paths from an MCP tool is a security surface — path traversal.) If a future `output_path` option is added, it MUST be confined to a configurable safe directory with traversal rejection. Flagged as OPEN DECISION D-3.
- **CSV formula-injection neutralization (security C-1):** RFC-4180 quoting alone does NOT prevent spreadsheet formula execution. Any cell whose first character is in the set `= + - @ \t \r` (tab `0x09`, CR `0x0D`) is neutralized by prefixing a single quote (`'`) BEFORE RFC-4180 quoting. This applies to the **inline string path too** (users paste reports into Excel/Sheets), and shares the exact same neutralizer code path as the Tier-4 CSV import (so any imported value re-exported here is also neutralized).

**Acceptance criteria**
- [ ] Markdown output is valid, with section headers and tables.
- [ ] CSV output is RFC-4180-safe (quote/escape fields containing commas, quotes, newlines).
- [ ] CSV cells leading with `= + - @ \t \r` are neutralized (prefixed `'`) — including a fixture for a legitimately negative value (e.g. `-5` HRV delta) proving real data isn't corrupted, only made inert.
- [ ] `sections` filter respected; default all.
- [ ] Returns content inline (no implicit disk write).
- [ ] Empty range → report with "no data" notices, not an error.
- [ ] `disclaimer` line included in the report body.
- [ ] Unit tests: markdown structure, CSV escaping (comma/quote/newline), formula-injection neutralization (`=`,`+`,`-`,`@`,`\t`,`\r` leads + negative-number non-corruption), section filtering, empty range.

> **OPEN DECISION D-3:** Should `generate_report` ever write to disk? Default spec: no (inline string only). If yes, requires a sandboxed output directory + path-traversal rejection + a security review.

---

## Tier 3 — `correlate_metrics` (reconciles planned `get_correlations`)

Generalizes the v0.6.0 `get_correlations` design (preset correlation types) into an **arbitrary-pair, lagged** correlation tool. Under Option A, this *replaces* `get_correlations` (one tool, not two).

| Field | Value |
|-------|-------|
| **MCP name** | `correlate_metrics` |
| **Description** | Compute the correlation between any two daily health metrics, with an optional day lag — e.g. day-N strain vs. day-(N+1) recovery, or sleep duration vs. next-day HRV. |
| **Endpoints** | `/v2/recovery`, `/v2/activity/sleep`, `/v2/cycle` |
| **Scopes** | existing |

**Input schema**
```typescript
z.object({
  // EITHER a named preset (reproduces the legacy get_correlations types verbatim)
  preset: z.enum([
    "sleep_duration_vs_recovery",
    "strain_vs_next_day_recovery",
    "hrv_vs_sleep_performance",
    "workout_strain_vs_recovery_drop",
    "sleep_consistency_vs_hrv",
  ]).optional().describe("Named correlation preset. Mutually exclusive with x_metric/y_metric."),
  // OR an arbitrary daily-metric pair with optional lag
  x_metric: z.enum(["recovery", "hrv", "rhr", "respiratory_rate",
                    "sleep_hours", "sleep_performance", "strain"]).optional(),
  y_metric: z.enum(["recovery", "hrv", "rhr", "respiratory_rate",
                    "sleep_hours", "sleep_performance", "strain"]).optional(),
  lag_days: z.number().int().min(0).max(7).optional()
    .describe("Days y trails x. 0 = same day. Default: 0. (e.g. x=strain, y=recovery, lag=1)."),
  days: z.number().int().min(14).max(90).optional().describe("Lookback window. Default: 30."),
})
// Zod .refine(): exactly one of { preset } or { x_metric AND y_metric } must be supplied.
// preset "sleep_consistency_vs_hrv" enforces days >= 21 (7-day window warmup + 14 pairs).
```

> **Resolving the preset gap (C2/D-4):** Two legacy correlations are NOT plain scalar-pair-with-lag and cannot be expressed by `x_metric`/`y_metric` alone:
> - `sleep_consistency_vs_hrv` — X is a *rolling 7-day std-dev of bedtime* (a derived windowed series).
> - `workout_strain_vs_recovery_drop` — Y is a *recovery delta* (day-before → day-after a workout), keyed on workouts not days.
>
> These are therefore kept as **named presets** with their original derived-series logic, so `correlate_metrics` fully supersedes `get_correlations` with no regression. The generic `x_metric`/`y_metric`/`lag_days` path covers the other three presets and any new arbitrary pair.

**Output shape** (mirrors the existing `CorrelationResult` design)
```typescript
interface CorrelationResult {
  preset: string | null;         // named preset, or null for arbitrary pair
  x_metric: string;
  y_metric: string;
  lag_days: number;
  period: { start: string; end: string; days: number };
  sample_size: number;           // paired points after lag alignment
  pearson_r: number;
  strength: "strong" | "moderate" | "weak" | "none";
  direction: "positive" | "negative" | "none";
  p_significant: boolean;        // R_CRITICAL_TABLE lookup
  insight: string;               // grammatical, with specific numbers
  recommendation: string;        // actionable, health-appropriate
  data_points: Array<{ date: string; x_value: number; y_value: number }>; // capped (see M2)
  disclaimer: string;            // always present (canonical string)
}
```

**Acceptance criteria**
- [ ] Zod `.refine()`: rejects supplying both `preset` and `x_metric`/`y_metric`, and rejects a lone `x_metric` without `y_metric`.
- [ ] Day alignment uses the shared cross-source wake-day convention; pairs x[day N] with y[day N + lag_days]; misaligned/missing days excluded.
- [ ] Reuses `pearsonR`, `correlationStrength`, `correlationDirection`, `isSignificant`.
- [ ] `x_metric === y_metric && lag_days === 0` → validation error (trivial self-correlation).
- [ ] Zero-variance series → r 0, strength "none" (no NaN/throw).
- [ ] < 7 valid paired points → "Insufficient paired data" error.
- [ ] `p_significant` from `R_CRITICAL_TABLE` (floor-to-nearest-key).
- [ ] **All five legacy presets reproducible** — the three scalar presets via param combos AND the two derived presets (`sleep_consistency_vs_hrv`, `workout_strain_vs_recovery_drop`) via the named-preset path (back-compat coverage, no regression vs. `get_correlations`).
- [ ] `sleep_consistency_vs_hrv` preset enforces `days >= 21`.
- [ ] `data_points` capped per M2 (default cap, documented).
- [ ] `disclaimer` always present.
- [ ] Unit tests: perfect +/- correlation, lag alignment (sign/magnitude change), missing-day exclusion, self-correlation rejection, preset/pair mutual-exclusion, zero-variance, significance just-above/just-below threshold, each of the 5 presets.

> **OPEN DECISION D-4:** Confirm `correlate_metrics` supersedes the planned `get_correlations` (Option A). If `get_correlations` already shipped or is mid-flight, decide deprecate-and-alias vs. keep-both.

---

## Tier 4 — GATED: `log_behavior` + WHOOP CSV journal correlation

> **This tier introduces the project's first user-data persistence beyond OAuth tokens and a new untrusted-input surface (CSV upload). It is DEFERRED pending a dedicated security audit and explicit human sign-off (per the "Ask First" boundary: token storage changes / new persisted state).** The design below is the proposal to be reviewed, not approved scope.

### 4.1 `log_behavior`

Let users log behaviors (alcohol, caffeine, late meal, stress, etc.) that the WHOOP journal would capture but the v2 API does not expose. Stored locally, correlated against API data via `correlate_metrics`-style analysis.

- **Storage:** `~/.whoop-mcp/behaviors.json`, file mode `0600`, in the `~/.whoop-mcp/` directory which must be `0700`. Same directory/permission model as tokens. Created with restrictive perms; never world-readable.
- **Schema (per entry):** `{ id, date (YYYY-MM-DD), behavior (enum + freeform note), value?, created_at }`. `id` is a `crypto.randomUUID()` (not a counter). Validated with a `.strict()` Zod schema. Freeform note length-capped (≤ 500 chars) and stored as-is (no execution).
- **Operations:** `add`, `list`, `delete` (by id), `clear`. `clear` (wipes all entries) is destructive and requires an explicit `confirm: true` input flag. No network egress of behavior data.
- **Correlation:** join logged behaviors (binary present/absent or numeric value) per day against a chosen WHOOP metric (e.g. alcohol → next-day HRV) using the Tier-3 correlation engine. Freeform notes surfaced in output are rendered as quoted user data, never interpreted as instructions.

**Security requirements (must pass audit):**
- [ ] `~/.whoop-mcp/` directory created/asserted `0700`; `behaviors.json` created `0600`; perms re-asserted on every write.
- [ ] Atomic writes: temp file created in the SAME directory via `fs.open(..., 'wx', 0o600)` (`O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`), then `rename`. Never write to `/tmp`. Verify target is not a symlink (`O_NOFOLLOW`/`lstat`) to prevent TOCTOU/symlink redirection.
- [ ] Store **re-validated with `.strict()` Zod on every load** (integrity boundary — file may be tampered/hand-edited). Invalid/corrupt files quarantined with a clear error, never a raw throw.
- [ ] Prototype-pollution guard: drop `__proto__`/`constructor`/`prototype` keys; no object-merge of parsed data.
- [ ] Path is fixed (`~/.whoop-mcp/`); no user-controlled path component.
- [ ] Entry-count cap (e.g. ≤ 10k) and total-file-size cap (e.g. ≤ 5 MB) — clear error at the limit (disk-fill DoS guard).
- [ ] Freeform notes never interpolated into shell/SQL/HTML; size-capped (≤ 500 chars); enforced at the Zod boundary.
- [ ] `clear` requires `confirm: true`.
- [ ] No behavior data sent to WHOOP or any network endpoint; a no-egress test proves it (and that it never appears in logs).

### 4.2 WHOOP data-export CSV import

Accept an uploaded WHOOP CSV export (which *does* include journal entries) and join it with live API data.

> **Framing (where the formula-injection guard belongs):** CSV *formula* injection (`= + - @` …) is an **output/display** risk — a parser does not execute formula cells; the spreadsheet that later *opens* the file does. That guard therefore lives at the **`generate_report` CSV output** boundary (C-1), NOT in the import parser. The import parser treats every cell as inert data. Import's real risks are resource/DoS and malformed input — the requirements below check those.

**Security requirements (must pass audit):**
- [ ] Input is **in-memory string content only** — no filesystem path param (eliminates path-traversal/symlink class entirely; the assistant already has the content). If a path is ever added later, require `realpath` canonicalization, allowlisted base-dir confinement, `..` rejection, and symlink rejection (same review bar as D-3).
- [ ] CSV parsed with a strict, dependency-free, **streaming/char-scan** parser (no `eval`; no whole-file regex — ReDoS guard). Cells are treated as opaque data; the parser does NOT interpret `= + - @` leads (formula neutralization is an output concern handled in `generate_report`, not here).
- [ ] Caps: total content size, row count, **per-field length, and column count** all bounded (a single multi-GB cell or millions of columns is a memory DoS even within a row cap).
- [ ] Reject NUL bytes; enforce UTF-8; reject compressed input.
- [ ] Any imported value later re-emitted via `generate_report` is neutralized at THAT output boundary by the shared C-1 neutralizer (not at import time).
- [ ] Malformed CSV → clear error, no partial corruption of any local store.
- [ ] Imported data never re-uploaded to any network endpoint (no-egress test).

> **OPEN DECISION D-5:** Defer Tier 4 entirely to a follow-up release gated on a security audit (recommended), or attempt it in-release. Recommended: **defer**.

---

## Project Structure (additions)

```
src/tools/
  detect-anomalies.ts            # Tool 1.1
  get-baselines.ts               # Tool 1.2
  get-sleep-debt.ts              # Tool 1.3
  get-training-load.ts           # Tool 1.4
  get-day-of-week-patterns.ts    # Tool 1.5
  get-workout-analytics.ts       # Tool 2.1
  get-event-readiness.ts         # Tool 2.2
  detect-travel-impact.ts        # Tool 2.3
  generate-report.ts             # Tool 2.4
  correlate-metrics.ts           # Tool 3 (supersedes get-correlations)
  stats-utils.ts                 # MODIFY — add percentile, zScore, rollingWindow, pearsonR, isSignificant, ...
  # Tier 4 (gated, deferred):
  # log-behavior.ts
  # behavior-store.ts
tests/tools/                     # mirror each new file with *.test.ts
src/server.ts                    # MODIFY — register new tools
```

One tool per file; Zod schema + handler co-located; named exports; explicit return types. Tool names `snake_case`, files `kebab-case.ts`, types `PascalCase`, functions `camelCase`.

---

## Code Style (matches existing tools)

```typescript
// src/tools/detect-anomalies.ts
import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { fetchAllPages } from "../api/pagination.js";
import { ENDPOINT_RECOVERY, ENDPOINT_SLEEP } from "../api/endpoints.js";
import { mean, standardDeviation, zScore } from "./stats-utils.js";

export const detectAnomaliesSchema = {
  name: "detect_anomalies",
  description:
    "Compare today's HRV, resting heart rate, and respiratory rate against your " +
    "personal rolling baseline and flag deviations that may signal illness or overtraining.",
  inputSchema: z.object({
    baseline_days: z.number().int().min(7).max(90).optional()
      .describe("Rolling baseline window in days. Default: 30."),
    threshold_sd: z.number().min(1).max(4).optional()
      .describe("Std-deviation threshold to flag an anomaly. Default: 2."),
  }),
};

export async function detectAnomalies(
  client: WhoopClient,
  params: { baseline_days?: number; threshold_sd?: number }
): Promise<AnomalyReport> {
  // ... fetch baseline window, compute z-scores, flag deviations ...
}
```

---

## Testing Strategy

- **TDD** — failing test first, then implement (Prove-It for any bug).
- **Mock the WHOOP API** — `vi.fn()` over `globalThis.fetch`; never hit the real API.
- **Deterministic time** — `vi.useFakeTimers()` with a FIXED system time for every tool touching "today"/relative ranges; timers restored in `afterEach` to prevent cross-test bleed. DST tests pin an explicit reference offset (spring-forward 23h day, fall-back 25h day).
- **Stats unit tests** — hand-computed fixtures for `percentile`, `zScore`, `pearsonR`, `isSignificant`; each expected value annotated with its derivation (or cross-checked against a second method) so a future editor can't "fix" a test to match a buggy impl.
- **Property tests:**
  - `pearsonR`: perfect +correlation (y=2x+3 → r=1), perfect − (y=−x → r=−1), zero-variance → 0, symmetry `r(x,y)===r(y,x)`, bounded `−1≤r≤1`, scale/shift invariance `r(ax+b,y)===r(x,y)` for a>0, sign flip `r(−x,y)===−r(x,y)`.
  - `percentile`: monotonic non-decreasing in p, `percentile(xs,0)===min`, `percentile(xs,100)===max`, single-element array, linear-interpolation midpoints.
  - `rollingWindow`: output length = `max(0, n - size + 1)`; `n < size → []`; `size<1` throws.
  - `isSignificant`: just-above / just-below threshold pair; `n < 7 → false`.
- **Per-tool tests** — at minimum: happy path, insufficient-data, missing/PENDING records, constant/zero-variance, timezone/DST boundary (where local-time logic applies), and the `truncated` flag path where pagination caps apply.
- **Shared disclaimer test** — one parametrized test asserts EVERY analytics tool's output carries the exact canonical disclaimer string (catches a new tool dropping it).
- **Server integration** — one integration test asserts all ~10 new tools are registered on the MCP server with unique `snake_case` names and valid Zod input schemas (catches a tool implemented but never wired up).
- **CSV safety (Tier 4 + generate_report)** — explicit fixtures for formula-leading cells (`=`,`+`,`-`,`@`,`\t`,`\r`), an embedded `","`/newline field, and a legitimately negative value proving non-corruption; Tier-4 import adds NUL-byte, oversized-cell, and column-bomb fixtures.
- **Coverage targets** — > 80% on `src/auth/` and `src/api/` (unchanged); `stats-utils.ts` (core math) and new analytics tools held to the same > 80% bar; > 70% overall.
- Run `npm test` after every increment; `npm run lint && npm run typecheck && npm run build` must be green before any commit.

---

## Boundaries

**Always**
- Validate all tool input with Zod; reject out-of-range windows at the schema layer.
- Exclude non-SCORED records and the "current" value from its own baseline.
- Return a clear "insufficient data" message (never NaN/throw) below each tool's minimum.
- Attach the non-medical-advice `disclaimer` to every interpretive result.
- Reuse `fetchAllPages`, `date-utils`, and `stats-utils` rather than re-implementing.
- Run tests + lint + typecheck + build before committing.

**Ask first**
- Tier 4 (`log_behavior`, CSV import) — new persisted state + untrusted input (D-5).
- `generate_report` writing to disk (D-3).
- Any new runtime dependency (none anticipated).
- Deprecating/aliasing the planned `get_correlations` (D-4).

**Never**
- Add new OAuth scopes (none needed).
- Hit the real WHOOP API in tests.
- Send any user/behavior data to a network endpoint other than WHOOP's read APIs.
- Use `any`; commit secrets; remove or skip failing tests.
- Present statistical output as medical advice.

---

## Success Criteria (verifiable)

- [ ] **D-1 decided** (version label + correlations reconciliation) and reflected in `package.json` + `CHANGELOG.md`.
- [ ] Tier 1 tools (`detect_anomalies`, `get_baselines`, `get_sleep_debt`, `get_training_load`, `get_day_of_week_patterns`) implemented, registered, and passing all acceptance criteria — verify: `npm test -- tests/tools/`.
- [ ] Tier 2 tools implemented (or explicitly deferred with rationale).
- [ ] `correlate_metrics` implemented; the five legacy preset correlations reproducible via params (D-4 resolved).
- [ ] Tier 4 either shipped *after* a passing security audit, or formally deferred (D-5).
- [ ] Every interpretive tool output includes the disclaimer — verify via a shared test asserting the field is present.
- [ ] No new runtime dependencies in `package.json`.
- [ ] No new OAuth scopes in the auth request.
- [ ] `npm run lint && npm run typecheck && npm run build` clean; coverage thresholds met.
- [ ] README + CHANGELOG updated; tool count updated (14 → 14 + N).

---

## Open Questions (consolidated)

| ID | Question | Spec default |
|----|----------|--------------|
| D-1 | Ship as 0.6.0 (recommended) or force 0.5.3 label? | 0.6.0, Option A |
| D-2 | Tier 1+2+3 in-release, Tier 4 deferred? | Yes |
| D-3 | `generate_report` disk write? | No — inline string only |
| D-4 | `correlate_metrics` supersedes `get_correlations`? | Yes (one tool) |
| D-5 | Tier 4 (`log_behavior` + CSV) defer to follow-up? | Defer pending security audit |

---

## Sub-Agent Review Summary (incorporated 2026-06-11)

The draft was reviewed by `code-reviewer`, `security-auditor`, and `test-engineer`. Material findings and their resolution:

| Finding | Source | Resolution in this spec |
|---------|--------|-------------------------|
| **C1** — `get_sleep_debt` double-counts `need_from_sleep_debt_milli` | code-reviewer | `needed_hours` redefined to exclude the debt component (baseline + strain + nap only). |
| **C2/D-4** — `correlate_metrics` can't reproduce 2 of 5 legacy presets | code-reviewer | Added a named-`preset` path alongside the generic pair path; both derived presets preserved. |
| **C-1 (sec)** — `generate_report` CSV formula injection (non-gated) | security-auditor | Added formula-cell neutralization (`= + - @ \t \r`) shared with Tier-4 import, including inline path. |
| **I1** — Coupled ACWR + log-scale strain | code-reviewer | **Human override (rev 2):** keep **coupled** ACWR (acute ⊆ chronic), documented as such in `load_note`; added `kilojoule` linear-load alternative + nonlinearity caveat. (Reviewer had suggested uncoupled.) |
| **I2** — Monotony `sd===0 → 0` is inverted | code-reviewer | Returns `null` (not 0) for constant strain. |
| **I3** — `get_event_readiness` forward dates don't exist; extrapolation unbounded | code-reviewer | ISO-8601-only `event_date` (today-or-future); readiness clamped to [0,100]. |
| **I4** — Silent pagination truncation | code-reviewer | Added shared pagination convention: explicit `maxRecords` + `truncated` flag. |
| **I5** — `get_sleep_debt` "achieved" under-specified | code-reviewer | Pinned to sum of light+SWS+REM stage sums. |
| **I6** — Training-load chronic minimum too low | code-reviewer | Added `provisional` flag (rev 2) — requires ≥ 21 of 28 SCORED chronic days for a reliable ACWR; below that, `acwr: null` + `acwr_zone: "insufficient_data"`. |
| **I-1..I-5 (sec)** — Tier-4 storage/CSV hardening | security-auditor | Temp-file `O_EXCL`/`O_NOFOLLOW`/`0600`, dir `0700`, count/size/field/column caps, Zod-on-load + prototype-pollution guard, in-memory-only CSV, ReDoS/NUL/UTF-8 guards. |
| **M2/M3/M4 (sec)** — data_points cap, randomUUID + confirm-on-clear, note-as-data | security-auditor | Output-size convention added; `crypto.randomUUID()` ids; `clear` requires `confirm: true`; notes rendered as quoted data. |
| **Test verifiability** — vague criteria, missing property/DST/registration tests, disclaimer test | test-engineer | Testing Strategy expanded: property tests, fixed fake-timers + DST, shared disclaimer test, server-registration test, fixture provenance, stats-utils held to >80%. |
| **M1/M3/M4/M5** — social-jetlag label, day-key convention, latest_percentile note, canonical disclaimer | code-reviewer | Labeled social jetlag a heuristic; added cross-source day-key convention; documented `latest_percentile` self-inclusion; single canonical disclaimer string. |

Deferred-by-design (confirmed sound by all three): Tier 4 gating (D-5), `generate_report` inline-only default (D-3), webhooks pushed to 0.7.0.

---

## Acceptance Definition

This spec is "done" (ready for the Plan phase) when:
1. The human has resolved D-1 through D-5.
2. ✅ `code-reviewer`, `security-auditor`, and `test-engineer` sub-agents have reviewed and their findings are incorporated (see summary above).
3. The human approves the final scope.
