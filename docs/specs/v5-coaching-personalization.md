# Spec: WHOOP MCP Server — v0.6 Coaching & Personalization Layer

> **Status:** Draft (awaiting human approval + sub-agent review)
> **Target release:** `0.6.0` (the *user-facing coaching layer* of the 0.6.0 release — see [Versioning & Relationship to v4](#versioning--relationship-to-v4))
> **Spec iteration:** v5 (follows `v4-personal-analytics.md`)
> **Date:** 2026-06-13
> **Baseline:** v0.5.x shipped — 14 tools, 4 resources, 5 prompts, ~700 tests, lint/typecheck/build clean
> **Depends on:** `v4-personal-analytics.md` analytics primitives (`get_training_load`, `get_sleep_debt`, `get_baselines`, `detect_anomalies`)
> **Source of requirements:** Top-10 r/whoop community asks, filtered to what a read-only WHOOP-OAuth MCP can *actually* solve.

---

## Objective

The v4 analytics layer turns raw WHOOP records into **interpretations** (baselines, sleep debt, training load, anomalies). This v0.6 layer turns those interpretations into the **decisions and forward projections** users actually ask for:

- *"I'm at 45% recovery — what should today's workout be?"* → `get_daily_recommendation`
- *"What time should I sleep tonight (and the next few nights) to be green for Saturday's race?"* → `forecast_sleep`
- *"Is a 7.2% HRV good for my age?"* → `get_benchmarks`
- A coaching conversation that reasons over recovery + strain + sleep + anomalies at once → `daily_coaching` prompt.

**Target users:** AI assistant users (Claude Desktop, Claude Code, claude.ai web, Cursor) who want their WHOOP data turned into *what to do next*, grounded in their own history.

**Why this matters (the moat):** WHOOP Coach gives generic, single-metric answers. These tools let a stronger model reason over recovery, acute:chronic load, sleep debt, and anomaly signals **together**, personalized to the user's own baseline — fully within WHOOP's read-only OAuth API (TOS-compliant, zero ban risk).

**Success looks like:**
- An assistant can give a concrete training recommendation (push / maintain / recover + a target strain band) from one tool call that already accounts for recovery, recent load, sleep debt, and anomaly flags.
- An assistant can project the nightly sleep needed over the coming nights to hit a target by a future date.
- An assistant can place a user's HRV/RHR/sleep against published age/sex norms *with the right caveats*.
- Every interpretive answer carries the canonical "not medical advice" disclaimer.

---

## Scope & Mapping to the Top-10 r/whoop Asks

| # | r/whoop ask | This spec | Notes |
|---|-------------|-----------|-------|
| 5 | Daily training recommendations | ✅ `get_daily_recommendation` | Core deliverable |
| 7 | Sleep planning & debt forecasting | ✅ `forecast_sleep` | Forward-looking complement to v4's backward `get_sleep_debt` |
| 10 | Benchmarking & population context | ✅ `get_benchmarks` | Partner/friend comparison **out of scope** (single-user OAuth) |
| 4 | Smarter WHOOP Coach | ✅ `daily_coaching` prompt | Orchestration over the new + existing tools |
| 1 | Raw data export | — (v4 `generate_report`) | Already specced in v4 |
| 2 | Long-term trends / custom ranges | — (shipped) | `get_trend`, `compare_periods` |
| 3 | Behavior–recovery correlations | — (v4 `correlate_metrics`) | Already specced in v4 |
| 6 | Custom weekly/monthly reports | — (v4 `generate_report`, `get_weekly_summary`) | Already covered |
| 9 | Illness/overtraining early warning | 🔶 Detection in v4 `detect_anomalies`; **proactive push deferred** | Webhooks + scheduling → **0.7.0** (see [Deferred](#deferred--out-of-scope)) |
| 8 | Cross-app integration (Strava/Calendar/etc.) | ❌ Non-goal | Multi-connector concern; belongs at the assistant level, not this server |

---

## Versioning & Relationship to v4

Two specs now target `0.6.0`: this one and `v4-personal-analytics.md`. They are **complementary layers**, not competitors:

- **v4 = analytics primitives** (compute baselines, sleep debt, training load, anomalies).
- **v0.6 coaching layer (this spec) = composition over those primitives** into decisions/forecasts.

These tools are thin orchestration over v4's outputs — `get_daily_recommendation` reuses `get_training_load` + `get_sleep_debt` + `detect_anomalies`; `forecast_sleep` reuses the sleep-need fields; `get_benchmarks` reuses `get_baselines`.

| Option | Description | Tradeoff |
|--------|-------------|----------|
| **A (recommended)** | Ship v4 primitives **and** this coaching layer together as **0.6.0**. v4 lands first (prerequisite), this layer second, one release. | Delivers the actual user-facing value of 0.6.0; clean dependency order. |
| **B** | Ship v4 as 0.6.0, this coaching layer as **0.6.1 / 0.7.0**. | Smaller releases; users wait for the headline "what should I do today" feature. |
| **C** | Build coaching tools standalone (no v4 dependency), duplicating ACWR/sleep-debt math inline. | Code duplication; rejected. |

**This spec assumes Option A and treats v4 Tier-1 tools as a hard prerequisite.**

> **OPEN DECISION D-1:** Confirm Option A (bundle with v4 as 0.6.0) vs. Option B (follow-on point release). **This decision is conditional on v4's own D-1** (v4 recommends 0.6.0 but the human may force 0.5.3). If v4 ships as 0.5.3, this layer's version string follows suit (the tool designs are unchanged — only the release label differs).

---

## Assumptions

```
ASSUMPTIONS (verified against src/api/types.ts unless noted):
1. v4-personal-analytics.md Tier-1 tools (get_training_load, get_sleep_debt,
   get_baselines, detect_anomalies) and the stats-utils.ts extensions ship FIRST
   and are importable. This spec depends on them. (NOT independently verifiable —
   gated on v4 landing.)
2. WHOOP v2 profile exposes NO age or date of birth. UserProfile = { user_id,
   email, first_name, last_name } only; BodyMeasurement = { height_meter,
   weight_kilogram, max_heart_rate }. THEREFORE get_benchmarks takes `age`/`sex`
   as USER INPUT — they cannot be read from the API. (VERIFIED in types.ts.)
3. Required score fields exist (VERIFIED):
   - Recovery.score.recovery_score, hrv_rmssd_milli, resting_heart_rate
   - Sleep.score.sleep_needed { baseline_milli, need_from_sleep_debt_milli,
     need_from_recent_strain_milli, need_from_recent_nap_milli },
     stage_summary, sleep_performance_percentage?, respiratory_rate?
   - Cycle.score.strain, kilojoule
4. No new OAuth scopes — existing six read: scopes cover all data.
5. No new RUNTIME dependencies. Benchmarking norms are a BUNDLED static
   TypeScript table (a data module checked into the repo), not a network call
   or a new package.
6. date-utils.resolveDateExpression is backward-looking only. forecast_sleep's
   target_date therefore accepts an explicit ISO-8601 future date only (same
   pattern as v4 get_event_readiness), NOT relative forward expressions.
7. All computation stays in-process. No new persistent state, no untrusted input
   surface (benchmarks read bundled constants; no file/CSV import here).
8. Node.js >= 20 remains the minimum (unchanged).
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

## Shared Foundations (reused, not re-implemented)

- **Pagination:** reuse `fetchAllPages` with an explicit `maxRecords` sized to the window (v4 pagination convention); set `truncated: true` and note it when the cap is hit.
- **Date keys:** reuse v4's cross-source wake-day convention (sleep → wake-day; recovery/cycle → cycle-start local day via `timezone_offset`).
- **Baselines / stats:** reuse `stats-utils.ts` (incl. v4 additions `percentile`, `zScore`) and the v4 Tier-1 tool functions directly — do NOT re-derive ACWR or sleep-debt math.
- **Insufficient-data guard:** every tool declares a minimum N of valid records; below it, returns a clear "insufficient data" message — never NaN/throw.
- **Output-size convention:** echoed `data_points`/per-night arrays capped at a documented default; stats computed on the full set.
- **Disclaimer convention:** every interpretive result carries the single canonical string (shared test across all tools):
  ```
  disclaimer: "Statistical observation from your data, not medical advice."
  ```

---

## Tool 1 — `get_daily_recommendation` (ask #5)

| Field | Value |
|-------|-------|
| **MCP name** | `get_daily_recommendation` |
| **Description** | Recommend today's training action (recover / maintain / build) and a target strain band, synthesizing current recovery, recent acute:chronic load, sleep debt, and anomaly flags — personalized to your goal. |
| **Endpoints** | `/v2/recovery`, `/v2/cycle`, `/v2/activity/sleep` (via the v4 primitives) |
| **Scopes** | existing |
| **Depends on** | v4 `get_training_load`, `get_sleep_debt`, `detect_anomalies` |

> **Call-volume note (M3):** This tool runs three paginating primitives plus its own recovery fetch — recovery is fetched ~3× and sleep ~2× per call. The existing 429 retry/backoff covers correctness; the implementation SHOULD dedupe the shared recovery/sleep fetches (single fetch passed into the primitives) where practical. The expected per-call request volume is documented in the handler.
  planned_sport: z.string().max(80).optional()
    .describe("Sport you intend to do (echoed back as labeled data; not used for filtering)."),
})
// planned_sport is the only freeform field. It is length-capped (≤ 80) and control
// characters (\r \n \t NUL) are stripped at the handler boundary. It is echoed ONLY
// into a dedicated structured `planned_sport` echo field / `factors[].state`, never
// interpolated into the natural-language `summary` (prompt-injection hygiene, sec MED-1).
```

**Output shape**
```typescript
interface DailyRecommendation {
  evaluated_at: string;                 // ISO 8601
  goal: "recover" | "maintain" | "build";
  recovery_score: number | null;        // today's SCORED recovery; null if not yet scored
  recovery_band: "red" | "yellow" | "green" | "unknown";
  recommended_action: "rest" | "easy" | "moderate" | "hard";
  target_strain: { min: number; max: number } | null; // WHOOP 0–21 scale; null when recovery unknown
  factors: RecommendationFactor[];      // each input that moved the recommendation
  cautions: string[];                   // e.g. anomaly flags, high ACWR, high sleep debt
  summary: string;
  disclaimer: string;
}
interface RecommendationFactor {
  factor: "recovery" | "training_load" | "sleep_debt" | "anomaly";
  state: string;                        // human-readable (e.g. "ACWR 1.6 — high_risk")
  influence: "raised" | "lowered" | "neutral"; // direction it pushed the recommendation
}
```

**Algorithm (heuristic, fully documented — all constants named)**

Action ladder (ordered, floor = `rest`): `hard` → `moderate` → `easy` → `rest`. "One step toward rest" moves right; "one step toward hard" moves left. Steps never underflow past `rest` or overflow past `hard`.

Named constants (module-level, shared where noted):
- `RECOVERY_ZONES` — `< 34` red, `34–66` yellow, `> 66` green. **Extracted into one shared constant imported by both this tool and the v4 primitives** (sec M5 / DRY — single source of truth for WHOOP's zone cutoffs).
- `SLEEP_DEBT_CAUTION_HOURS = 5` — `get_sleep_debt.total_debt_hours` above this is a caution.
- `TARGET_STRAIN_BY_ACTION` — deterministic, **disjoint** bands keyed on the FINAL action (see step 5).

1. Fetch the latest SCORED recovery for **today in the user's local day** (derived from the latest cycle's `timezone_offset`, per the v4 wake-day convention — not UTC). Map to band via `RECOVERY_ZONES`. No SCORED recovery for today → `recovery_band: "unknown"`, base action `easy`, `target_strain: null`, summary notes the gap.
2. Base action from band: red→`easy`, yellow→`moderate`, green→`hard`. (Red is `easy` by default; it becomes `rest` only when step 3 adds a caution — M1.)
3. **Each active caution applies exactly one step toward rest** (cumulative, capped at the `rest` floor): `detect_anomalies.flagged === true`; `get_training_load.acwr_zone === "high_risk"`; `get_sleep_debt.total_debt_hours > SLEEP_DEBT_CAUTION_HOURS`. Each appends a `factors` entry (`influence: "lowered"`) and a `cautions` entry. Three cautions on a green day → `hard`→3 steps→`rest`.
4. **Goal modifies last:** `recover` applies one additional step toward rest (capped at `rest`); `build` applies one step toward hard **only if zero cautions are active AND recovery is not red** (never escalates past a caution or a red recovery). `maintain` is neutral.
5. `target_strain` is derived from the **FINAL `recommended_action`** (not the raw recovery band — I1), via `TARGET_STRAIN_BY_ACTION` with disjoint bands: `rest` `{0,4}`, `easy` `{4,8}`, `moderate` `{8,14}`, `hard` `{14,18}`. Output is clamped to `[0,21]` purely as a defensive guard (the mapping never exceeds it). `recovery_band: "unknown"` → `target_strain: null`.
6. If any underlying primitive returns "insufficient data", that factor is marked `neutral` with a note (it applies no step), the other factors still contribute, and the summary states the recommendation is partial — never a throw.

**Acceptance criteria**
- [ ] "Today" is resolved in the user's LOCAL day via the latest cycle's `timezone_offset` (not UTC); a near-local-midnight fixture proves the correct cycle is chosen.
- [ ] Recovery band uses the shared `RECOVERY_ZONES` constant (same constant the v4 primitives import); cutoff tests at 33/34 and 66/67.
- [ ] `target_strain` is mapped from the **final** `recommended_action` via disjoint `TARGET_STRAIN_BY_ACTION` bands; a green-recovery + anomaly fixture yields a lowered action AND a lowered strain band (the two outputs agree — I1). `recovery_band: "unknown"` → `target_strain: null`.
- [ ] Each active caution (anomaly flag, ACWR `high_risk`, `total_debt_hours > SLEEP_DEBT_CAUTION_HOURS=5`) applies exactly one step toward rest and adds a `cautions` entry; a fixture with all three cautions on a green day yields `rest` (floor, no underflow).
- [ ] `SLEEP_DEBT_CAUTION_HOURS` boundary tested at threshold and threshold±ε.
- [ ] `goal: "build"` escalates one step toward hard ONLY when zero cautions AND not red; blocked otherwise. `goal: "recover"` always applies one extra step toward rest (capped at `rest`). `maintain` neutral.
- [ ] No SCORED recovery today → `recovery_band: "unknown"`, `target_strain: null`, action `easy`, summary notes the gap (no NaN).
- [ ] Each primitive independently returning "insufficient data" → that factor `neutral` + noted, others still contribute; one test per primitive (training-load / sleep-debt / anomaly).
- [ ] A mid-composition `fetch` rejection / 5xx → the tool returns a graceful partial result OR a typed error (state which); a test pins the chosen behavior.
- [ ] `factors` lists every input with a structured `{factor, state, influence}` entry; assertions check the specific factor per branch, not just non-emptiness.
- [ ] `planned_sport` is `≤ 80` chars, control-chars stripped, echoed ONLY into a labeled field (never the `summary`); fixtures with an oversized value and an injection-style value (`"ignore previous instructions…"`) prove containment.
- [ ] `disclaimer` present (canonical string).
- [ ] Unit tests: a **parametrized decision-table** test (band × goal × caution-set) as the source of truth — incl. yellow+build+no-caution→hard, yellow+build+caution→moderate, low/normal ACWR→no adjustment, all-three-cautions→rest, recovery-unknown, and per-primitive insufficiency.

---

## Tool 2 — `forecast_sleep` (ask #7)

| Field | Value |
|-------|-------|
| **MCP name** | `forecast_sleep` |
| **Description** | Project the nightly sleep needed over the coming nights to clear accumulated sleep debt and meet your nightly need by a target date — the forward-looking complement to `get_sleep_debt`. |
| **Endpoints** | `/v2/activity/sleep`, `/v2/cycle` (recent strain feeds need) |
| **Scopes** | existing |
| **Depends on** | v4 `get_sleep_debt` (current debt + nightly-need definitions) |

**Input schema**
```typescript
z.object({
  target_date: z.string()
    .describe("Target date — ISO 8601 (YYYY-MM-DD) only. Must be today or future."),
  habitual_wake_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be 24h HH:MM").optional()
    .describe("Local wake time 'HH:MM' to anchor suggested bedtimes. Default: inferred from recent mean wake time."),
  baseline_days: z.number().int().min(7).max(90).optional()
    .describe("History window for nightly-need estimate. Default: 14."),
})
// habitual_wake_time validated at the schema boundary with an ANCHORED, LINEAR regex
// (no backtracking quantifiers — no ReDoS, sec MED-2), mirroring src/tools/date-utils.ts.
```

> **Note:** Like v4 `get_event_readiness`, `target_date` is ISO-only and validated today-or-future at the schema/handler boundary; relative forward expressions ("next Saturday") are rejected with a clear message (date-utils is backward-looking only).

**Output shape**
```typescript
interface SleepForecast {
  generated_at: string;
  target_date: string;
  nights_until_target: number;
  starting_debt_hours: number;          // from get_sleep_debt at evaluation time
  nightly_need_hours: number;           // baseline + recent-strain + recent-nap (v4 definition, excludes debt component)
  plan: ForecastNight[];
  projected_debt_at_target_hours: number; // residual debt if the plan is followed
  summary: string;
  disclaimer: string;
}
interface ForecastNight {
  date: string;                         // wake-up day (YYYY-MM-DD)
  recommended_sleep_hours: number;      // nightly_need + a share of debt repayment
  suggested_bedtime_local: string | null; // wake_time - recommended_sleep_hours; null if wake time unknown
  debt_remaining_hours: number;         // running residual after this night
}
```

**Algorithm (heuristic projection, not a prediction)** — named constant `MAX_NIGHTLY_SLEEP_HOURS = 10`.

1. **`starting_debt_hours` (pinned — I2):** the **standing** debt = most recent SCORED night's `need_from_sleep_debt_milli` (milli→hours). This is WHOOP's own running accumulation and is the physiologically meaningful "debt to clear" — deliberately NOT `get_sleep_debt.total_debt_hours` (which is a backward *sum* that scales with the window and would make the forecast depend arbitrarily on `baseline_days`). Documented as a deliberate deviation from `get_sleep_debt`.
2. **`nightly_need_hours` (pinned — I3):** the **mean** of `get_sleep_debt.nights[].needed_hours` over the non-nap main-sleep nights in the window (each night's need already EXCLUDES the debt component per v4). `wake_time` for bedtime math is `habitual_wake_time` if supplied, else the mean local wake clock-time over those same nights.
3. **Per-night recommended sleep:** `recommended_sleep_hours = min(MAX_NIGHTLY_SLEEP_HOURS, nightly_need_hours + (debt_remaining / nights_left))`. Debt that the cap leaves unrepaid on a night **rolls forward** to subsequent nights' `debt_remaining`; whatever remains after the last night becomes `projected_debt_at_target_hours` (so `debt_remaining_hours` is an unambiguous running residual — M4).
4. `suggested_bedtime_local = wake_time − recommended_sleep_hours` in **local** time; `null` when no wake time supplied and none inferable. (Local-time subtraction is DST-sensitive — see tests.)
5. `nights_until_target = 0` (target is today) → single-night plan from current standing debt, no multi-night spread.
6. Explicitly labeled a heuristic projection in `summary` (sleep need re-computes nightly as strain/naps change).

**Acceptance criteria**
- [ ] `target_date` ISO-only, today-or-future; past dates and relative expressions rejected with clear messages. **The today/past check uses the user's LOCAL day** (consistent with `plan[].date` wake-day labels), and `nights_until_target` is the local-day difference — a near-local-midnight fixture proves the count matches the labeled nights (no UTC off-by-one — I5).
- [ ] `starting_debt_hours` = most recent SCORED night's `need_from_sleep_debt_milli` (standing debt), and is invariant to `baseline_days`; a fixture varying `baseline_days` proves `starting_debt_hours` does not scale with the window.
- [ ] `nightly_need_hours` = mean of v4 per-night `needed_hours` over non-nap nights (excludes the debt component — no double counting); a fixture pins the mean.
- [ ] Per-night `recommended_sleep_hours = min(10, need + debt_share)`; debt above the cap rolls forward; final residual = `projected_debt_at_target_hours`; `debt_remaining_hours` is the running residual.
- [ ] `suggested_bedtime_local` computed in local time from `wake_time`; `null` when wake time unknown; a DST-crossing fixture asserts the local-time subtraction is correct.
- [ ] `nights_until_target === 0` → single-night plan, no error.
- [ ] Zero-debt and sleep-surplus (negative standing debt) inputs handled: recommended sleep floors at `nightly_need_hours`, residual `0`.
- [ ] `habitual_wake_time` malformed input rejected at the schema boundary (anchored regex).
- [ ] < the minimum valid nights for a need estimate → "insufficient data" message.
- [ ] `truncated` flag honored per pagination convention.
- [ ] Projection labeled heuristic, not medical/performance guarantee.
- [ ] `disclaimer` present.
- [ ] Unit tests: multi-night roll-forward split, single-night (target today), per-night cap applied (large debt) with roll-forward, zero-debt, negative standing debt, wake-time-unknown bedtime null, DST-crossing bedtime, local-midnight boundary, past-date rejected, relative-expression rejected, malformed-wake-time rejected, insufficient-data.

---

## Tool 3 — `get_benchmarks` (ask #10)

| Field | Value |
|-------|-------|
| **MCP name** | `get_benchmarks` |
| **Description** | Place your personal HRV, resting heart rate, respiratory rate, and sleep duration against published age/sex population norms, alongside your own rolling baseline — with explicit comparability caveats. |
| **Endpoints** | `/v2/recovery`, `/v2/activity/sleep` (via v4 `get_baselines`) + bundled static norm tables |
| **Scopes** | existing |
| **Depends on** | v4 `get_baselines` |

**Input schema**
```typescript
z.object({
  age: z.number().int().min(18).max(100).optional()
    .describe("Your age in years (18+). REQUIRED for population comparison — the WHOOP API does not expose age. Omit to get personal baselines only."),
  sex: z.enum(["male", "female"]).optional()
    .describe("Biological sex for sex-specific norms (RHR, HRV). Omit to fall back to combined norms where available."),
  baseline_days: z.number().int().min(14).max(180).optional()
    .describe("Personal baseline window. Default: 30."),
})
```

> **Critical constraint (verified):** The WHOOP v2 profile exposes **no age/DOB**. `age` and `sex` are therefore **user inputs**. When `age` is omitted, the tool returns personal baselines only and a note that population context requires an age.

**Output shape**
```typescript
interface BenchmarkReport {
  age: number | null;
  sex: "male" | "female" | null;
  metrics: Record<BenchmarkMetric, BenchmarkBand | null>; // null when insufficient personal data
  caveats: string[];                    // comparability caveats (see below)
  disclaimer: string;
}
type BenchmarkMetric = "hrv" | "rhr" | "respiratory_rate" | "sleep_hours";
interface BenchmarkBand {
  personal_mean: number;                // from get_baselines
  personal_sample_size: number;
  population: PopulationContext | null; // null when age missing or no norm for this metric/age/sex
}
interface PopulationContext {
  source: string;                       // citation key into the bundled norm table
  source_version: string;               // publication year / dataset version (auditability)
  age_band: string;                     // e.g. "35–39"
  p5: number; p10: number; p25: number; p50: number; p75: number; p90: number; p95: number;
  user_percentile: number | null;       // where personal_mean falls (see percentile model)
  beyond_published_range: boolean;       // true when personal_mean is outside [p5, p95]
  interpretation: string;               // DESCRIPTIVE, non-diagnostic, caveat co-located
}
```

**Percentile model (pinned — I4)**
`user_percentile` is computed by **piecewise-linear interpolation** between the published anchors `{p5,p10,p25,p50,p75,p90,p95}` mapped to `{5,10,25,50,75,90,95}`. A `personal_mean` below `p5` or above `p95` is **clamped to [1, 99]** (never 0/100) and `beyond_published_range: true` is set with a "beyond published range" note. The extra anchors (p5/p10/p90/p95 beyond the original p25/p50/p75) exist specifically so the tails are interpolatable rather than guessed.

**Norm-table design**
- Norms live in a **bundled static data module** (`src/tools/benchmark-norms.ts`) — typed constants, no network, no new dependency. Each row carries `source` AND `source_version` for auditability.
- Age bands are **contiguous and non-overlapping** and cover **adults only** (18+); the input `age.min(18)` matches table coverage so the "no norm for band" path is the exception, not the norm.
- Tables cover, at minimum: resting heart rate by age/sex, sleep duration by age, respiratory rate (adult range). **HRV norms are method-dependent** (see caveats) and included only if a defensible RMSSD-comparable source is used.
- `interpretation` strings are constrained to **descriptive, non-diagnostic** phrasing (e.g. "above the 50th percentile for your age band"), never implied diagnosis; the disclaimer is co-located.

**Mandatory caveats (always in `caveats`)**
- HRV (RMSSD) is highly method- and time-of-day dependent; WHOOP's overnight RMSSD is **not** directly comparable to morning or lab measurements — treat population HRV percentiles as rough context only.
- Population norms describe groups, not individuals; "normal for your age" is not "optimal for you" — the personal baseline is the more meaningful reference.

**Acceptance criteria**
- [ ] `age` omitted → personal baselines returned, `population: null` for every metric, a note explaining age is required for population context (no error).
- [ ] `age` present → population band looked up by age band (and `sex` when provided) from the bundled table; `user_percentile` computed via the pinned piecewise-linear model.
- [ ] `sex` omitted but `age` present → falls back to combined-sex norms where available; metrics with only sex-specific norms → `population: null` with a reason.
- [ ] `user_percentile` model tested at exact anchors (p25/p50/p75 → 25/50/75), between knots (interpolated), and beyond p5/p95 (clamped to [1,99] + `beyond_published_range: true`).
- [ ] No norm entry for a metric/age/sex combination → that metric's `population: null` with a reason (not a throw).
- [ ] `age`/`sex` are NEVER read from the WHOOP API — a test asserts `fetch` is never called with the profile URL during a benchmark run.
- [ ] `age`/`sex` and benchmark output are NEVER written to disk, the token store, or `ResourceCache` (in-process only).
- [ ] Each population entry carries `source` + `source_version` resolvable to the bundled table.
- [ ] Mandatory caveats always present: HRV-comparability, group-vs-individual, and (the spec ships adult-only norms) an adult-derived-norms note.
- [ ] `interpretation` strings contain no diagnostic language (asserted) and co-locate the disclaimer.
- [ ] `truncated`/insufficient-window notes from the underlying `get_baselines` are propagated.
- [ ] Metrics with insufficient personal data → `null` band.
- [ ] Output schema has NO partner/friend field (asserted structurally), confirming single-user scope.
- [ ] `disclaimer` present.
- [ ] Norm-table **structural-invariant** tests: `p5<p10<p25<p50<p75<p90<p95` monotonic per row, age bands contiguous + non-overlapping (boundary test e.g. 29 vs 30), valid sex keys.
- [ ] Unit tests: age-present full lookup, age-missing baselines-only, sex-omitted combined fallback, no-norm-for-band null, percentile at anchors/between/beyond, insufficient personal data, caveats always present, no-API-for-age, no-persist.

> **OPEN DECISION D-2:** Which published norm sources/tables to bundle, and their licensing for redistribution in the repo. HRV norms specifically need a source whose measurement method is reasonably comparable to WHOOP overnight RMSSD, or HRV population context is dropped (personal baseline only).

---

## Prompt — `daily_coaching` (ask #4)

A static MCP prompt (mirrors the existing 5 in `src/prompts/index.ts`) that orchestrates a coaching conversation: instructs the assistant to call `get_daily_recommendation`, `get_today`, `get_sleep_debt`, and `detect_anomalies`, then reason over them together and respond with a recommendation + rationale + the non-medical-advice caveat.

**Input schema (prompt args)**
```typescript
{ goal: z.string().optional().describe("Training intent: recover | maintain | build (default maintain)") }
```

**Acceptance criteria**
- [ ] Registered with a `snake_case` name and an optional `goal` arg.
- [ ] Message text references the real tool names above and asks for a concrete recommendation + rationale + caveat.
- [ ] Unit test asserts registration and that the rendered text names the orchestrated tools.

---

## Deferred / Out of Scope

| Ask | Decision | Rationale |
|-----|----------|-----------|
| #9 proactive illness/overtraining **alerts** | **Deferred → 0.7.0** | Detection already exists (`detect_anomalies`). Proactive *push* needs webhooks + scheduled checks — a transport/hosting concern reserved on the v3 roadmap, not an analytics tool. |
| #8 cross-app integration (Strava/Apple Health/calendar) | **Non-goal** | A multi-connector problem solved at the assistant level with other MCP servers; keep this server WHOOP-focused. |
| Partner/friend benchmarking | **Non-goal** | Single-user OAuth — no access to another user's data. |

> **OPEN DECISION D-3:** Confirm webhooks/proactive alerts stay on the 0.7.0 track (vs. pulling a scheduled-check stub into 0.6.0).

---

## Project Structure (additions)

```
src/tools/
  get-daily-recommendation.ts    # Tool 1
  forecast-sleep.ts              # Tool 2
  get-benchmarks.ts              # Tool 3
  benchmark-norms.ts             # Bundled static norm tables (data module, no logic)
src/prompts/index.ts             # MODIFY — register daily_coaching prompt
src/server.ts                    # MODIFY — register the 3 new tools
tests/tools/                     # mirror each new file with *.test.ts
tests/prompts/                   # daily_coaching registration test
```

One tool per file; Zod schema + handler co-located; named exports; explicit return types. Tool names `snake_case`, files `kebab-case.ts`, types `PascalCase`, functions `camelCase`.

---

## Code Style (matches existing tools)

```typescript
// src/tools/get-daily-recommendation.ts
import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { getTrainingLoad } from "./get-training-load.js";
import { getSleepDebt } from "./get-sleep-debt.js";
import { detectAnomalies } from "./detect-anomalies.js";

export const getDailyRecommendationSchema = {
  name: "get_daily_recommendation",
  description:
    "Recommend today's training action (recover / maintain / build) and a target " +
    "strain band from current recovery, recent load, sleep debt, and anomaly flags.",
  inputSchema: z.object({
    goal: z.enum(["recover", "maintain", "build"]).optional()
      .describe("Your training intent today. Default: 'maintain'."),
    planned_sport: z.string().optional()
      .describe("Sport you intend to do (echoed into the rationale)."),
  }),
};

export async function getDailyRecommendation(
  client: WhoopClient,
  params: { goal?: "recover" | "maintain" | "build"; planned_sport?: string }
): Promise<DailyRecommendation> {
  // ... compose v4 primitives, apply documented heuristic, return recommendation ...
}
```

---

## Testing Strategy

- **TDD** — failing test first, then implement (Prove-It for any bug).
- **Mock the WHOOP API** — `vi.fn()` over `globalThis.fetch`; never hit the real API. Compose tools by mocking the underlying fetch, not the v4 functions, so integration through the primitives is exercised.
- **Fixture provenance** — maintain a documented table mapping each raw fetch fixture to the exact primitive output it produces (e.g. "N records below the min → `acwr_zone: insufficient_data`"), citing the v4 threshold it relies on, so composition tests aren't brittle against primitive internals. **Tie every fixture record timestamp to the fixed fake clock** so "today"/"last-N-days" windows are stable. If any primitive follows `next_token`, include at least one multi-page fixture (or note primitives are single-page within these windows).
- **Deterministic time** — `vi.useFakeTimers()` with a FIXED system time for every tool touching "today" / "nights until target"; timers restored in `afterEach`. Local-midnight and DST-crossing fixtures pin explicit `timezone_offset`s.
- **Per-tool tests** — at minimum: happy path, insufficient-data, missing/PENDING records, boundary (recovery band edges, target-date today/past, age present/absent), and the `truncated` path where pagination caps apply.
- **Heuristic-boundary tests** — recovery band cutoffs (33/34, 66/67), target-strain clamping at [0,21], sleep-night cap, percentile at extremes — each fixture annotated with its hand-computed expected value.
- **No-API-for-age test** — `get_benchmarks` must not consult the profile endpoint for `age`/`sex`.
- **Shared disclaimer test** — one parametrized test asserts every new interpretive tool output carries the exact canonical disclaimer string.
- **Server/prompt registration test** — assert the 3 new tools and `daily_coaching` prompt are registered with unique `snake_case` names and valid Zod schemas (catches a tool implemented but never wired up).
- **Coverage targets** — new tools and `benchmark-norms.ts` consumers held to > 80% **line and branch** (decision-heavy heuristics need branch coverage); > 80% on `src/auth/` and `src/api/` (unchanged); > 70% overall.
- **Finiteness invariant** — a parametrized assertion that every numeric output field is finite (no NaN/Infinity) across all fixtures, cheaply guarding every band/clamp/split/percentile path.
- Run `npm test` after every increment; `npm run lint && npm run typecheck && npm run build` must be green before any commit.

---

## Boundaries

**Always**
- Validate all tool input with Zod; reject out-of-range windows and non-future `target_date`s at the schema layer.
- Reuse v4 primitives (`get_training_load`, `get_sleep_debt`, `get_baselines`, `detect_anomalies`) — never re-derive ACWR / sleep-debt / baseline math.
- Return a clear "insufficient data" message (never NaN/throw) below each tool's minimum.
- Attach the canonical non-medical-advice `disclaimer` to every interpretive result.
- Run tests + lint + typecheck + build before committing.

**Ask first**
- Bundling specific published norm tables and confirming their redistribution licensing (D-2).
- Any new runtime dependency (none anticipated).
- Pulling proactive-alert/webhook scaffolding into 0.6.0 (D-3).

**Never**
- Add new OAuth scopes (none needed).
- Read age/DOB from the WHOOP API (it isn't there) — `age`/`sex` are user inputs only.
- **Log tool inputs (especially `age`/`sex`/`planned_sport`) or computed health values** — log only tool name, requestId, and duration (sec LOW-1/LOW-2). Error and "insufficient data" messages must not embed `age`/`sex` or raw metric values beyond what the user-facing explanation needs.
- **Persist `age`/`sex` or benchmark output** to disk, the token store, or `ResourceCache` — these tools are in-process only (sec LOW-3).
- **Convert `benchmark-norms` to a remote-fetched or user-importable source** — it must remain a bundled static module; changing that re-introduces the untrusted-input/integrity surface v4 Tier 4 was gated for and requires a fresh security pass (sec INFO-1).
- Hit the real WHOOP API in tests.
- Send any user data to a network endpoint other than WHOOP's read APIs.
- Use `any`; commit secrets; remove or skip failing tests.
- Present statistical or heuristic output as medical advice.

---

## Success Criteria (verifiable)

- [ ] **D-1 decided** (bundle with v4 as 0.6.0 vs. follow-on) and reflected in `package.json` + `CHANGELOG.md`.
- [ ] v4 Tier-1 primitives present and imported (prerequisite); this layer adds no duplicate analytics math.
- [ ] `get_daily_recommendation`, `forecast_sleep`, `get_benchmarks` implemented, registered, and passing all acceptance criteria — verify: `npm test -- tests/tools/`.
- [ ] `daily_coaching` prompt registered and tested.
- [ ] `get_benchmarks` returns personal-only output with a clear note when `age` is omitted, and never reads age from the API.
- [ ] Every interpretive tool output includes the canonical disclaimer — verified via a shared test.
- [ ] No new runtime dependencies in `package.json`; no new OAuth scopes.
- [ ] `npm run lint && npm run typecheck && npm run build` clean; coverage thresholds met.
- [ ] README + CHANGELOG updated; tool count updated.

---

## Open Questions (consolidated)

| ID | Question | Spec default |
|----|----------|--------------|
| D-1 | Ship coaching layer bundled with v4 as 0.6.0, or as a follow-on point release? **Conditional on v4's own D-1.** | Bundle as 0.6.0 (Option A) |
| D-2 | Which published norm sources to bundle for `get_benchmarks`, with `source_version` + redistribution licensing? Adult-only (18+); HRV included only if RMSSD-comparable. | Pending source decision |
| D-3 | Proactive alerts/webhooks stay on 0.7.0? | Yes — deferred |

---

## Sub-Agent Review Summary (incorporated 2026-06-13)

The draft was reviewed by `code-reviewer`, `security-auditor`, and `test-engineer`. No Critical/High architectural or security defects were found; the layer is materially lower-risk than v4 Tier 4 (no new scopes, deps, persistence, or untrusted-input surface). Material findings and their resolution:

| Finding | Source | Resolution in this spec |
|---------|--------|-------------------------|
| **I1** — `target_strain` derived from raw band, contradicting the adjusted action | code-reviewer / test-engineer | `target_strain` now maps from the FINAL `recommended_action` via disjoint `TARGET_STRAIN_BY_ACTION` bands; agreement asserted. |
| **I2** — `forecast_sleep` starting debt scaled arbitrarily with `baseline_days` | code-reviewer | Pinned `starting_debt_hours` to the latest night's `need_from_sleep_debt_milli` (standing debt), invariant to window. |
| **I3** — `nightly_need_hours` aggregation undefined | code-reviewer / test-engineer | Defined as mean of v4 per-night `needed_hours` over non-nap nights. |
| **I4 / percentile model** — percentile undefined from 3 quantiles | code-reviewer / test-engineer | Added p5/p10/p90/p95 anchors + piecewise-linear model, clamped [1,99] with `beyond_published_range`. |
| **I5 / timezone** — UTC vs local-day inconsistency | code-reviewer / test-engineer | "Today" and `nights_until_target` use the local wake-day convention; midnight + DST fixtures added. |
| **Multi-caution semantics** — step ladder undefined | test-engineer | Defined ordered action ladder, one step per caution, goal applied last, floor at `rest`; decision-table test required. |
| **Pinned constants** — "high debt" / red action vague | code-reviewer / test-engineer | Named `SLEEP_DEBT_CAUTION_HOURS=5`, `MAX_NIGHTLY_SLEEP_HOURS=10`, shared `RECOVERY_ZONES`. |
| **MED-1** — `planned_sport` freeform injection surface | security-auditor | Capped `.max(80)`, control-chars stripped, echoed only into a labeled field, never `summary`; injection fixture. |
| **MED-2** — `habitual_wake_time` unvalidated / ReDoS | security-auditor | Anchored linear `HH:MM` regex at the schema boundary. |
| **MED-3** — norm-table liability, minors, `interpretation` wording | security-auditor | `age.min(18)`; adult-derived-norms caveat; non-diagnostic `interpretation` (asserted); `source_version` per row. |
| **LOW-1/2/3, INFO-1** — logging/persistence/drift | security-auditor | "Never" boundaries: no-log inputs/health values, no-persist `age`/`sex`/output, norms must stay a bundled static module. |
| **M3** — multiplied API call volume | code-reviewer | Documented; dedupe shared recovery/sleep fetch where practical. |
| **M6 / truncated** — benchmark doesn't surface `truncated` | code-reviewer | Propagate `truncated`/insufficient-window from `get_baselines`. |
| **Test rigor** — fixture provenance, per-primitive insufficiency, fetch-rejection path, branch coverage, finiteness invariant, norm-table structural invariants, registration substrings | test-engineer | Folded into Testing Strategy + per-tool acceptance criteria. |

Deferred-by-design (confirmed sound): webhooks/proactive alerts → 0.7.0 (D-3); cross-app integration and partner benchmarking → non-goals.

---

## Acceptance Definition

This spec is "done" (ready for the Plan phase) when:
1. The human has resolved D-1 through D-3.
2. ✅ `code-reviewer`, `security-auditor`, and `test-engineer` sub-agents have reviewed and their findings are incorporated (see summary above).
3. The human approves the final scope.
