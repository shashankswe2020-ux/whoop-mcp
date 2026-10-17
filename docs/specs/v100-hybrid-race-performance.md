# Spec: Hybrid Race Performance — HYROX + Triathlon Tracking, Readiness & Audit

> Status: **APPROVED 2026-10-17** (see Decisions). Implementation: Task 20, starting with T1–T6
> Target release: v1.0.0 (feature-additive; existing tools unchanged)
> Plan: [task-20-hybrid-race-performance.md](../plans/task-20-hybrid-race-performance.md)

## Objective

Give AI assistants connected to whoop-mcp a set of tools to **track HYROX and triathlon
performance**, compute **race readiness from activity logs**, and open a **locally hosted
dashboard**. Every number must be **auditable**: the user can see the evidence behind it,
flag or relabel wrong records, keep a correction log, and check an AI assistant's claims
against the raw data.

**User:** a WHOOP member training for HYROX and/or triathlon who talks to Claude/ChatGPT/
Copilot through this MCP server and wants to know: *"Am I ready for my race on the 14th?"*,
*"Which HYROX station is my weakest?"*, *"Is my bike volume too low vs swim/run?"*,
*"Is what the assistant just told me actually true?"*

### User stories

1. *"How's my HYROX training going?"* → `get_hyrox_performance` summarises confirmed HYROX
   sessions, run vs functional load split, logged race results and station splits.
2. *"Show my triathlon balance for the last 8 weeks."* → `get_triathlon_performance` returns
   swim/bike/run volume, distance, zone distribution and brick sessions per week.
3. *"Am I ready for my HYROX on 2026-11-14?"* → `get_race_readiness` returns a band
   (`ready` / `caution` / `not_ready` / `insufficient_data`) plus every component, its inputs,
   formula and method version.
4. *"Open my dashboard."* → `open_performance_dashboard` starts a 127.0.0.1 server and opens the
   browser on the Session / HYROX / Triathlon / Readiness / Audit views.
5. *"I just did HYROX Mumbai in 1:18:42, here are my splits."* → `log_race_result`.
6. *"That 'Functional Fitness' on Tuesday was a HYROX sim; Thursday's run had a bad HR strap."*
   → `annotate_workout` (relabel / exclude with reason); also doable from the dashboard.
7. *"The assistant said my bike volume rose 40% this month — check it."* → `verify_claim`
   returns `confirmed` / `contradicted` / `unverifiable` with recomputed value and evidence.
8. *"What have I changed and is any data suspicious?"* → `audit_performance_data` lists
   annotations, audit-log entries and automatically detected suspect records.
9. *"Break down last night's HYROX sim."* → `get_hyrox_session_report` groups the auto-split WHOOP
   activities into one session. It returns the day context, segment table, transitions and insights, plus a
   "before you trust these numbers" caveats block (modelled on the Reddit post's report).

## Research Summary (why these choices)

| Finding | Source | Consequence for design |
|---|---|---|
| Inspiration: r/whoop post *"The MCP is just toooooooo good u gotta try"* (1x8c1av). Its image is a **"WHOOP Session Report — Hyrox Simulation + Lift"** (provided by the user). WHOOP auto-split one session into **10 activities** (6 runs, 3 ergs, 1 lift). The report shows: day context (recovery 40 % yellow, HRV/RHR vs baseline, sleep, resp, SpO₂); a header with day strain vs target, session span vs tracked time, peak HR and kcal; time in zone; a **segment-by-segment table** (start, duration, avg/peak HR, strain, kcal); insights (*negative split*, *ergs are where you rest*, *13 % of the block was transition*, *the lift cost more than it felt*); and a **"Before you trust these numbers"** caveats section. | User-supplied screenshot; reddit text unverified (403) | Add a **HYROX session report** that groups consecutive WHOOP workouts into one session. Show segment table, transitions, insights and auto-generated caveats. The caveats section is the model for the audit feature. |
| The report's caveats: (1) indoor **distances are unusable** (11.7 km logged for a 5-min run, 1.7 km for a ski erg, from GPS drift indoors); (2) **station detection is approximate**: WHOOP labels the SkiErg "Skiing" and logged a 1:18 block at 118 bpm as a "Run"; non-erg stations (sleds, carries, burpees, wall balls) get absorbed into runs or transitions; (3) **segment strains don't add up** (55.5 summed vs 15.6 day), because strain is logarithmic; (4) **max HR is estimated** (age-based), so all zone boundaries shift if the true max differs; (5) curve vs summary peaks differ slightly. | Same screenshot | New suspect rules `indoor_distance`, `short_segment_mislabel`, `estimated_max_hr`. Distance/pace is never used for indoor or HYROX segments. Strain is never summed. |
| The report plots **598 per-second HR samples**. The **public WHOOP v2 API has no HR time-series endpoint**, only per-workout avg/max HR and `zone_durations`. | WHOOP developer docs (workout model); `src/api/types.ts` | **No continuous HR curve.** The dashboard draws per-segment avg/peak HR bars on a timeline, with gaps shown as transitions. A minute-level curve would need an unofficial API, which is out of scope. |
| The closest public "MCP + dashboard" project is `sumal009/garmin-mcp` (Swim/Bike/Run view, readiness, training load, HR zones; cloud-hosted on Railway behind a bearer token). | github.com/sumal009/garmin-mcp | Same concept for triathlon, but **local-only**, WHOOP-based and auditable. |
| WHOOP workout `sport_id` "will not exist past 09/01/2025"; `sport_name` remains. | developer.whoop.com workout docs | Classify **only by `sport_name`**. `sport_id` is a fallback when present. |
| WHOOP sport list has Running, Cycling, Swimming, Triathlon (62), Duathlon (49), Functional Fitness (48), HIIT (96), Obstacle Course Racing (94), Rowing (18), Spin (97), Assault Bike (126), Mountain Biking (57), Track & Field (35). **No HYROX sport.** | developer.whoop.com workout docs | A HYROX session can't be detected with certainty. Functional-fitness-type sessions become **`hyrox_candidate`** and only count as HYROX after user confirmation (tag or saved rule). This is the main anti-falseness control. |
| A web-search summary claimed Triathlon = `sport_id 50`. The official table says **62**. | Cross-check of the two sources | Shows the audit requirement in practice. Sport mapping is a tested constant table based on the official docs, with a test fixture for every entry. |
| WHOOP workout score: strain (0–21, **logarithmic**), avg/max HR, kJ, `percent_recorded`, `zone_durations` (zones 0–5), optional distance/altitude. **No pace, power, splits or stations.** | `src/api/types.ts`, WHOOP docs | Load uses zone-weighted minutes (**Edwards TRIMP** = Σ minutes_in_zone_i × i, i=1..5), never summed strain. Splits/stations come **only from manual logs**. |
| HYROX format: 8 × 1 km run, each followed by a fixed station: SkiErg 1000 m, Sled Push 50 m, Sled Pull 50 m, Burpee Broad Jumps 80 m, Row 1000 m, Farmers Carry 200 m, Sandbag Lunges 100 m, Wall Balls 100 reps. Divisions: Open/Pro/Doubles/Relay × Men/Women/Mixed. | hyroxfitness.com station guide, hycrew.com | Fixed ordered schema for HYROX results (`runs[8]`, `stations[8]`, `roxzone`). No division weights are stored or claimed, because they change by season. |
| Triathlon: swim → T1 → bike → T2 → run. Standard distances: Sprint, Olympic, 70.3, 140.6 (plus custom). | General domain knowledge | Fixed ordered schema for triathlon results. |
| CTL/ATL/TSB (Banister impulse-response; 42-day / 7-day EWMA) is widely used in triathlon but uses fixed time constants and external load. ACWR's injury-prediction value is **contested**. | WattsUP / TrainingPeaks-style literature; ACWR reviews | Use CTL/ATL/TSB as the load primitive, labelled **method + limitations**. Report ACWR only as a "load spike" monitor, never as injury risk. Follow the existing rule of no % confidence and no clinical labels. |

## Assumptions (correct me before approval)

1. **Data sources:** WHOOP API v2 workouts/recovery/sleep/cycles **plus manual logs** (race
   results, splits, workout labels) stored locally. No Garmin/Strava/FIT import in this release.
2. **Storage (approved by user 2026-10-17):** `~/.whoop-mcp/performance.json` (state) and
   `~/.whoop-mcp/performance-audit.jsonl` (append-only log), dir `0700`, files `0600`,
   atomic write (temp + rename), `schema_version: 1`.
3. **Dashboard:** built-in `node:http` server bound to `127.0.0.1` on an ephemeral port. Vanilla
   HTML/CSS/JS served from the package with **no new runtime deps** and no CDN assets. Opened with
   the existing spawn-based `openBrowser` (`src/auth/oauth.ts`).
4. **Local-only features:** the dashboard and the write tools (`log_race_result`,
   `annotate_workout`) are registered **only in stdio/local mode**. In remote HTTP mode
   (`src/transport/http.ts`) they are not registered, because there is no local filesystem or browser for that user.
   The read-only analytics tools work in both modes and simply ignore manual data in remote mode.
5. **Readiness is decision support, not medical advice.** It carries the existing canonical
   `DISCLAIMER` from `src/tools/analytics-utils.ts`.
6. Units are metric. Times are stored as integer seconds and displayed `h:mm:ss`.
7. **No HYROX/triathlon benchmarks against other athletes** (no "elite percentile"), because there
   is no verified dataset to compare against. Comparisons are **personal only** (vs your own history).

## Tech Stack (unchanged)

TypeScript ~5.x strict (no `any`), Node.js >= 20, native `fetch`, `@modelcontextprotocol/sdk`,
Zod, Vitest, ESLint, Prettier, `tsc`. **No new runtime dependencies.**

## Commands (unchanged)

```bash
npm run build        # tsc
npm test             # vitest
npm test -- --coverage
npm run lint
npm run typecheck
npm run dev          # tsx — then call open_performance_dashboard from MCP Inspector
```

## Project Structure (additions)

```
src/
├── performance/
│   ├── sport-classifier.ts     # sport_name → discipline (run/bike/swim/multisport/hyrox_candidate/other)
│   ├── session-grouping.ts     # chain workouts into sessions, segment roles, transitions, insights, caveats
│   ├── training-load.ts        # Edwards TRIMP, CTL/ATL/TSB EWMA, ACWR spike monitor
│   ├── readiness.ts            # composite readiness + evidence objects
│   ├── suspect-detector.ts     # automatic plausibility checks (see Audit)
│   ├── store.ts                # performance.json read/write (0600, atomic, versioned)
│   ├── audit-log.ts            # append-only performance-audit.jsonl
│   └── schemas.ts              # Zod: race results, annotations, rules (shared by tools + dashboard)
├── tools/
│   ├── get-hyrox-performance.ts
│   ├── get-hyrox-session-report.ts
│   ├── get-triathlon-performance.ts
│   ├── get-race-readiness.ts
│   ├── log-race-result.ts
│   ├── annotate-workout.ts
│   ├── audit-performance-data.ts
│   ├── verify-claim.ts
│   └── open-performance-dashboard.ts
└── dashboard/
    ├── server.ts               # 127.0.0.1 http server, token, host/origin checks, idle shutdown
    ├── api.ts                  # JSON routes reusing the tool functions above
    └── static/                 # index.html, app.js, style.css (copied to dist on build)
tests/performance/, tests/tools/<each>.test.ts, tests/dashboard/  # mirrors src/
```

## Code Style

Follows `CLAUDE.md`: one tool per file, Zod schema + handler co-located, named exports, explicit
return types, typed errors, `safeTool` wrapper, `readOnlyHint` on read tools.

```typescript
// src/performance/sport-classifier.ts
export type Discipline = "run" | "bike" | "swim" | "multisport" | "hyrox_candidate" | "other";

const SPORT_NAME_TO_DISCIPLINE: Readonly<Record<string, Discipline>> = {
  running: "run",
  "track & field": "run",
  cycling: "bike",
  spin: "bike",
  "mountain biking": "bike",
  swimming: "swim",
  triathlon: "multisport",
  duathlon: "multisport",
  "functional fitness": "hyrox_candidate",
  hiit: "hyrox_candidate",
  "obstacle course racing": "hyrox_candidate",
  // Rowing / Skiing (WHOOP's label for SkiErg) / Assault Bike are "other" when standalone (user decision
  // 2026-10-17); inside a grouped session they become erg-station segments (see Session grouping).
};

export function classifyWorkout(sportName: string, override?: Discipline): Discipline {
  if (override) return override;
  return SPORT_NAME_TO_DISCIPLINE[sportName.trim().toLowerCase()] ?? "other";
}
```

## Feature Design

### Shared evidence contract (extends v0.7.0 `data_quality`)

Every derived number in every new tool and dashboard panel is an `EvidencedMetric`:

```typescript
interface EvidencedMetric {
  value: number | null;
  unit: string;                         // "min", "km", "TRIMP", "s"
  method: string;                       // e.g. "edwards_trimp_ewma_42d"
  method_version: string;               // e.g. "1.0.0"
  window: { start: string; end: string };
  inputs: { records_used: number; records_excluded: number; excluded_reasons: Record<string, number> };
  source: "whoop" | "manual" | "mixed";
  status: "available" | "insufficient_data" | "unconfirmed" | "fetch_failed";
  limitations: string[];
}
```

Every result includes `workout_refs` (local IDs only, never sent to telemetry) so the dashboard
and `verify_claim` can show exactly which records made a number.

### Classification and confirmation

- Discipline comes from `sport_name` through the table above (fixture-tested against the official list).
- **Override precedence:** user annotation for that workout > user rule (e.g. "Functional Fitness
  on Saturdays ≥ 60 min = HYROX sim") > table.
- `hyrox_candidate` is **excluded from HYROX metrics until confirmed** and reported under
  `unconfirmed_candidates` with a count.
- **Brick** = bike workout followed by a run starting ≤ 15 min after the bike ends (constant `BRICK_GAP_MINUTES`).

### Session grouping (HYROX sims)

WHOOP auto-splits a HYROX sim into many workouts, so grouping is needed:

- **Session** = a chain of workouts where each starts ≤ `SESSION_GAP_MINUTES = 10` after the previous one ends.
- Segment roles: `run` (Running) and `erg_station` (Rowing, Skiing, Assault Bike; only inside a
  session); everything else is `other` (e.g. Weightlifting, shown separately like the "+ Lift" in the report).
- A session with ≥ 2 runs and ≥ 1 erg station or functional-fitness segment is a **`hyrox_candidate` session**.
  It counts as HYROX only after the user confirms it.
- **Transition time** = session span − Σ segment durations, reported in seconds and as % of the block.
- Segments are numbered by role (`Run 1..n`, `Ski Erg 1..n`, `Row`). They are never mapped to official
  station numbers, because non-erg stations are invisible to WHOOP.

### Training load and readiness (`method_version 1.0.0`)

- **Daily load** per discipline = Edwards TRIMP from `zone_durations` (zones 1–5 weighted 1–5;
  zone 0 ignored). Workouts with `score_state != SCORED` or user-excluded are dropped and counted
  in `records_excluded`.
- **Fitness (CTL)** = 42-day EWMA, **Fatigue (ATL)** = 7-day EWMA, **Form (TSB)** = CTL − ATL,
  for total and per discipline. Needs ≥ 28 days of history, otherwise `insufficient_data`.
- **Load spike** = 7-day sum / (28-day sum / 4). Over 1.5 is flagged as `"load_spike"` (monitoring only, not injury risk).
- **Readiness components** (each `EvidencedMetric`, each mapped to `green|amber|red|unknown`):
  1. *Recovery*: today's WHOOP recovery score vs your 30-day baseline (reuse `get_baselines`).
     Band from WHOOP's zones (< 34 red, 34–66 amber, > 66 green) via a new shared
     `RECOVERY_ZONES` constant in `src/tools/analytics-utils.ts`, next to `DISCLAIMER`.
  2. *Form*: TSB band (constants `TSB_FRESH`, `TSB_FATIGUED`, documented and boundary-tested).
  3. *Specificity*: share of last-28-day load in race-relevant disciplines (HYROX: run +
     confirmed HYROX; triathlon: each of swim/bike/run ≥ `MIN_DISCIPLINE_SHARE`).
  4. *Sleep*: reuse `get_sleep_debt`.
  5. *Taper* (only when `race_date` given and ≤ 14 days away): ATL trending down.
- **Band** = worst-of rule: any red → `not_ready`; ≥ 2 amber → `caution`; else `ready`. Two or more
  `unknown` → `insufficient_data`. The rule is deterministic and shown in the output. No weighted
  % score, no "confidence %".

### Tools

| Tool | R/W | Input (Zod) | Output highlights |
|---|---|---|---|
| `get_hyrox_performance` | R | `start?`, `end?` (default 8 weeks) | weekly run vs HYROX load, confirmed sessions, `unconfirmed_candidates`, logged races with station splits, **personal** weakest station (station time vs own median across races, needs ≥ 2 races), PRs |
| `get_hyrox_session_report` | R | `date?` (default today, local day) or `session_start?` | day context (recovery, HRV/RHR vs 30-day baseline, sleep, resp, SpO₂), header (day strain, session span vs tracked time, peak HR, kcal), time in zone (summed `zone_durations`), segment table (start, duration, avg/peak HR, strain, kcal), transition time, deterministic insights (each with the rule that triggered it), **caveats ("before you trust these numbers")** |
| `get_triathlon_performance` | R | `start?`, `end?` | per-discipline weekly duration/distance/TRIMP/zone mix, bricks, discipline share, races with leg splits + transitions |
| `get_race_readiness` | R | `sport: "hyrox" \| "triathlon"`, `race_date?` | band, components (evidence), CTL/ATL/TSB series (capped 90 pts), disclaimer |
| `log_race_result` | W (local) | `sport`, `date`, `name`, `category` (HYROX division / tri distance), `total_seconds`, `splits` (ordered fixed schema), `workout_id?`, `notes?` | stored record + validation warnings |
| `annotate_workout` | W (local) | `workout_id`, `action: "relabel" \| "exclude" \| "restore"`, `discipline?`, `reason` (`misclassified` \| `bad_hr` \| `duplicate` \| `not_mine` \| `hyrox_sim` \| `other`), `note?` | before/after + audit entry id |
| `audit_performance_data` | R | `start?`, `end?` | annotations, audit-log entries, **suspect records** with rule ids, unconfirmed candidates |
| `verify_claim` | R | `metric` (enum of supported metrics), `sport?`, `discipline?`, `period {start,end}`, `claimed_value`, `comparison_period?` | `confirmed` \| `contradicted` \| `unverifiable`, recomputed value, tolerance used, evidence refs |
| `open_performance_dashboard` | local | `view?: "session" \| "hyrox" \| "triathlon" \| "readiness" \| "audit"` | `{ url, expires_at }`; opens the browser |

**Validation:** HYROX splits must contain exactly 8 runs + 8 stations in official order (+ optional
roxzone). Triathlon splits contain swim/T1/bike/T2/run. The sum of splits must be within ±5 s of
`total_seconds`, otherwise reject with a clear message. Dates can't be in the future for results.

**`verify_claim` tolerance:** relative ±2 % or absolute unit tolerance (documented per metric).
`unverifiable` is returned when the metric is unsupported, data is insufficient, or the
period has unconfirmed candidates that could change the answer. The tool never guesses.

### Audit ("check for falseness")

1. **Show evidence:** every metric is an `EvidencedMetric`. The dashboard has a "why?" drill-down
   listing the records, exclusions and formula.
2. **Flag/exclude:** `annotate_workout` / dashboard button. Excluded records are kept and listed, never deleted.
3. **Relabel:** change a workout's discipline (e.g. Functional Fitness → HYROX).
4. **Audit log:** append-only JSONL `{ id, at, actor: "mcp_tool" | "dashboard", action,
   workout_id?, before, after, reason }`. Entries are never edited, and `restore` adds a new entry.
5. **Verify AI claims:** `verify_claim`, plus the dashboard "Check a claim" form.
6. **Automatic suspect detection** (flags only, never auto-excludes):
   `low_coverage` (`percent_recorded < 80`), `implausible_pace` (run < 2:30/km, swim < 0:55/100 m,
   bike > 60 km/h avg), `hr_out_of_range` (avg HR < 50 or max HR > 220 during a workout),
   `overlap` (two workouts overlapping > 50 %), `unscored`, `split_sum_mismatch` (manual),
   `indoor_distance` (any distance on a segment inside a HYROX session, or implied pace beyond
   the `implausible_pace` limits; distance/pace is then ignored), `short_segment_mislabel` (a "run"
   segment < 2 min, or one whose avg HR is ≥ 20 bpm below the session's run median; the report's
   1:18 @ 118 bpm case), `estimated_max_hr` (always shown on zone panels: zones are WHOOP's and rely
   on an estimated max HR unless the user's profile says otherwise).
7. **Caveats block ("Before you trust these numbers"):** every session report and dashboard view
   ends with the caveats triggered for that data, generated from the suspect rules plus fixed
   method notes (strain is logarithmic and isn't summed; non-erg HYROX stations aren't visible to WHOOP;
   there's no continuous HR curve in the public API). Each caveat names the records it applies to.

### Session-report insights (deterministic, each shows its rule)

| Insight | Rule |
|---|---|
| Negative split | last run avg HR ≥ first run avg HR + 5 bpm **and** last run duration ≤ first run duration |
| Ergs are recovery | mean erg avg HR ≤ mean run avg HR − 10 bpm |
| Transition-heavy | transition time ≥ 10 % of session span |
| Hidden cost | an `other` segment's strain > the max single HYROX segment strain |
| Day context | recovery band at session start (red/yellow/green) stated with the session's peak zone |

No insight is produced when its inputs are missing. Each insight lists the segment refs it used.

### Dashboard security (local server)

- Bind **127.0.0.1 only**, ephemeral port, never `0.0.0.0`.
- 32-byte random session token from `crypto.randomBytes`, carried in the URL **fragment**
  and then held in memory and sent as a header. Every API request is rejected without it.
- `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defence). POST
  requests require same `Origin` + token header (CSRF).
- Strict CSP (`default-src 'self'`), no inline script, no third-party assets, all output escaped
  via `textContent` (no `innerHTML` with data).
- Auto-shutdown after 30 min idle. A second invocation reuses the running server and issues a new token.
- Dashboard writes go through the **same** Zod schemas + store + audit log as the MCP write tools.

## Testing Strategy

- Vitest, `fetch` mocked with `vi.fn()`, fixtures for WHOOP workouts. The real API is never called.
- **Unit:** classifier (every mapped sport + unknown + override precedence), TRIMP/EWMA (hand-
  computed fixtures), readiness band boundaries, suspect rules (threshold ± ε), schema validation
  (split order, sum tolerance), store (perms `0600`/`0700`, atomic write, corrupt-file recovery
  → typed error, not data loss), audit log (append-only).
- **Integration:** each tool via `createServer` + in-memory transport; remote mode does **not**
  register write/dashboard tools.
- **Dashboard:** start on port 0, assert 127.0.0.1 bind, 401 without token, 403 on bad Host/
  Origin, CSP header present, idle shutdown with fake timers, browser open mocked.
- Coverage: > 80 % on `src/performance/` and `src/dashboard/`, > 70 % overall (repo targets).

## Boundaries

- **Always:** Zod-validate every input (MCP and dashboard), show method + limitations, keep
  manual data local with `0600`, write audit entries for every mutation, run
  `npm test && npm run lint && npm run typecheck && npm run build` before commit.
- **Ask first:** any new runtime dependency (charts are hand-rolled SVG), adding Garmin/Strava/FIT
  import, exposing the dashboard beyond localhost, changing the readiness method (bump
  `method_version`), sending any new field to telemetry.
- **Never:** call HYROX/triathlon sessions confirmed without user confirmation, compare against
  external athletes without a sourced dataset, output % confidence or clinical/injury-risk
  labels, delete user records (exclude only), bind to non-loopback, hit the real WHOOP API in tests.

## Success Criteria

- [ ] All 9 tools are registered in stdio mode. In HTTP mode only the 6 read-only analytics tools are registered (`get_hyrox_performance`, `get_hyrox_session_report`, `get_triathlon_performance`, `get_race_readiness`, `audit_performance_data`, `verify_claim`).
- [ ] A fixture reproducing the Reddit report (6 runs + 2 Skiing + 1 Rowing + Weightlifting with a 29-min gap) is grouped into **one HYROX candidate session + one separate lift**. The segment table, transition time and the 4 insights match hand-computed values. Caveats include `indoor_distance` and `short_segment_mislabel` (Run 4) and the "strains don't add up" note.
- [ ] A standalone Rowing or Assault Bike workout is classified `other`.
- [ ] A Functional Fitness workout is reported as `hyrox_candidate` until annotated, and is then counted in HYROX metrics. The audit log has the entry.
- [ ] `get_race_readiness` returns a band plus 5 components, each with method, version, window, inputs and limitations. With < 28 days of data it returns `insufficient_data` (no NaN).
- [ ] `log_race_result` rejects out-of-order HYROX stations and split sums outside ±5 s.
- [ ] `verify_claim` returns `contradicted` with the recomputed value for a fixture where the claim is 40 % but the truth is 12 %.
- [ ] `open_performance_dashboard` returns a `127.0.0.1` URL and the browser opens. The five views (session, HYROX, triathlon, readiness, audit) render from fixture data, and a relabel from the dashboard shows up in `audit_performance_data`.
- [ ] Security tests: no-token → 401, foreign Host → 403, foreign Origin POST → 403, CSP present.
- [ ] Tests, lint, typecheck and build are clean. README + `references/tools.md` document the new tools.

## Decisions (approved 2026-10-17)

- Spec approved with defaults. Implementation starts with T1–T6.
- Standalone Rowing / Assault Bike / Skiing → `other`. Inside a grouped session they are erg stations.
- Readiness thresholds `TSB_FRESH = +5`, `TSB_FATIGUED = -20`, `MIN_DISCIPLINE_SHARE = 0.15` accepted as
  defaults (heuristics, labelled as such in `limitations`).
- Release as **v1.0.0**.
- Reddit image reviewed (WHOOP HYROX sim session report). It added session grouping, the session report
  and the caveats block.

## Open Questions

1. A continuous HR curve like the Reddit image needs per-sample HR, which the public WHOOP API doesn't
   provide. Accept segment-level HR bars? (Default: yes. Any unofficial API is out of scope.)
