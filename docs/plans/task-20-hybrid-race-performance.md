# Task 20: Hybrid Race Performance (HYROX + Triathlon) — Implementation Plan

> Status: **APPROVED 2026-10-17 — start with T1–T6** (target v1.0.0)
> Spec: [v100-hybrid-race-performance.md](../specs/v100-hybrid-race-performance.md)

## Approach

Build bottom-up: pure computation first (no I/O, easiest to test), then local storage +
audit log, then read tools, then write tools, then the dashboard. Every slice is
TDD (failing test → implement → `npm test && npm run lint && npm run typecheck`) and
committed on its own.

```
T1 classifier ─┐
T2 load model ─┼─► T5 readiness ─► T7 read tools ─┐
T3 suspects  ──┘                                  ├─► T9 server registration ─► T10 dashboard server ─► T11 dashboard UI ─► T12 docs/release
T4 store + audit log ─► T6 schemas ─► T8 write + audit tools ─┘
```

Parallelisable: T1, T2, T3 and T4 are independent.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Wrong sport mapping produces false metrics | Fixture test per official WHOOP sport name. HYROX requires confirmation. Unknown names map to `other`. |
| Readiness looks authoritative but is heuristic | Deterministic worst-of rule, method/version/limitations in output, no % scores, disclaimer |
| Local dashboard becomes an attack surface | Loopback only, token, Host/Origin checks, CSP, no `innerHTML`, idle shutdown, dedicated security tests |
| Corrupt or concurrent writes to `performance.json` | Atomic temp+rename. Parse failure throws a typed error and the file is never overwritten. Audit log is append-only. |
| Remote HTTP mode has no local disk/browser | Write + dashboard tools aren't registered in remote mode (tested) |
| Tool count grows the assistant's context | Concise descriptions. Outputs capped (series ≤ 90 points, lists ≤ 50 with `truncated`). |

## Tasks

- [x] **T1: Sport classifier + session grouping** — `sport-classifier.ts`, `session-grouping.ts`
  - Acceptance: every official WHOOP sport relevant to run/bike/swim/multisport/HYROX maps
    correctly by `sport_name` (case/space-insensitive). Standalone Rowing/Skiing/Assault Bike and unknown
    names → `other`. Override precedence is annotation > rule > table. Brick detection works with
    `BRICK_GAP_MINUTES = 15`. Sessions are chained with `SESSION_GAP_MINUTES = 10`. The Reddit-report fixture
    groups into one HYROX candidate session (6 runs, 2 ski, 1 row) plus a separate lift, with correct
    transition time.
  - Verify: `npm test -- tests/performance/sport-classifier.test.ts tests/performance/session-grouping.test.ts`
  - Files: `src/performance/sport-classifier.ts`, `src/performance/session-grouping.ts`, tests

- [x] **T2: Training load model** — `src/performance/training-load.ts`
  - Acceptance: Edwards TRIMP from `zone_durations`. 42/7-day EWMA CTL/ATL, TSB, load-spike
    ratio, per discipline and total. Unscored/excluded records are counted, not used. Fewer than 28 days
    gives `insufficient_data`. Output matches hand-computed fixtures to 2 dp.
  - Verify: `npm test -- tests/performance/training-load.test.ts`
  - Files: `src/performance/training-load.ts`, test

- [x] **T3: Suspect detector** — `src/performance/suspect-detector.ts`
  - Acceptance: rules `low_coverage`, `implausible_pace`, `hr_out_of_range`, `overlap`,
    `unscored`, `indoor_distance`, `short_segment_mislabel`, `estimated_max_hr` with threshold ±ε
    tests. Flags only, never mutates or excludes. Also builds the "before you trust these numbers" caveats
    list with record refs.
  - Verify: `npm test -- tests/performance/suspect-detector.test.ts`
  - Files: `src/performance/suspect-detector.ts`, test

- [x] **T4: Local store + audit log** — `store.ts`, `audit-log.ts`
  - Acceptance: dir `0700`, files `0600`, atomic write, `schema_version: 1`. A missing file returns empty state.
    A corrupt file throws a typed error and leaves the file untouched. The JSONL log is append-only. Paths are
    injectable for tests (temp dirs).
  - Verify: `npm test -- tests/performance/store.test.ts tests/performance/audit-log.test.ts`
  - Files: `src/performance/store.ts`, `src/performance/audit-log.ts`, tests

- [x] **T5: Readiness composer** — `src/performance/readiness.ts` (+ `RECOVERY_ZONES` in `analytics-utils.ts`)
  - Acceptance: 5 components as `EvidencedMetric`. The worst-of band rule matches the spec.
    Taper applies only when `race_date` ≤ 14 days away. Boundary tests for each threshold.
    Includes `DISCLAIMER`.
  - Verify: `npm test -- tests/performance/readiness.test.ts`
  - Files: `src/performance/readiness.ts`, `src/tools/analytics-utils.ts`, test
  - Depends on: T1, T2

- [x] **T6: Zod schemas** — `src/performance/schemas.ts`
  - Acceptance: race result (HYROX 8 runs + 8 stations in official order + optional roxzone;
    triathlon swim/T1/bike/T2/run), ±5 s split-sum rule, no future dates, annotation and
    rule schemas. Error messages are readable by an assistant.
  - Verify: `npm test -- tests/performance/schemas.test.ts`
  - Files: `src/performance/schemas.ts`, test
  - Depends on: T4 (shares the stored types)

- [ ] **T7: Read tools** — `get_hyrox_performance`, `get_hyrox_session_report`, `get_triathlon_performance`, `get_race_readiness`
  - Acceptance: tool outputs match the spec. `hyrox_candidate` is excluded until confirmed and counted in
    `unconfirmed_candidates`. Personal weakest station needs ≥ 2 races. The session report reproduces the
    Reddit-report fixture: segment table, transition %, the 4 insights with their rules, and caveats. Outputs are
    capped with `truncated`. Results are correct when the store is empty or unavailable (remote mode).
  - Verify: `npm test -- tests/tools/get-hyrox-performance.test.ts tests/tools/get-hyrox-session-report.test.ts tests/tools/get-triathlon-performance.test.ts tests/tools/get-race-readiness.test.ts`
  - Files: 4 tool files + 4 tests
  - Depends on: T1, T2, T3, T5

- [ ] **T8: Write + audit tools** — `log_race_result`, `annotate_workout`, `audit_performance_data`, `verify_claim`
  - Acceptance: every mutation writes one audit entry with before/after. `restore` appends a new entry and never edits an old one.
    `verify_claim` returns confirmed/contradicted/unverifiable with tolerance and evidence. The 40 % vs 12 %
    fixture returns `contradicted`.
  - Verify: `npm test -- tests/tools/log-race-result.test.ts tests/tools/annotate-workout.test.ts tests/tools/audit-performance-data.test.ts tests/tools/verify-claim.test.ts`
  - Files: 4 tool files + 4 tests
  - Depends on: T3, T4, T6, T7

- [ ] **T9: Server registration + mode gating**
  - Acceptance: all 9 tools are registered in stdio mode. In HTTP mode only the 6 read-only analytics tools are registered.
    `readOnlyHint` is correct. Tool-name allowlists are updated in `src/telemetry/telemetry.ts` and
    `collector/src/collector.ts` (names only, no new fields).
  - Verify: `npm test -- tests/server.test.ts tests/transport tests/telemetry` and `cd collector && npm test`
  - Files: `src/server.ts`, `src/telemetry/telemetry.ts`, `collector/src/collector.ts`, tests
  - Depends on: T7, T8

- [ ] **T10: Dashboard server + `open_performance_dashboard`**
  - Acceptance: binds 127.0.0.1 on an ephemeral port. Token in URL fragment. 401 without token, 403 on bad
    Host/Origin, CSP header present. JSON API reuses the tool functions and schemas. Idle shutdown
    after 30 min. A second call reuses the server. Browser opened via existing `openBrowser` (mocked
    in tests).
  - Verify: `npm test -- tests/dashboard tests/tools/open-performance-dashboard.test.ts`
  - Files: `src/dashboard/server.ts`, `src/dashboard/api.ts`, `src/tools/open-performance-dashboard.ts`, tests
  - Depends on: T9

- [ ] **T11: Dashboard UI** — `src/dashboard/static/*` (+ build copy step)
  - Acceptance: Session (segment timeline with avg/peak HR bars and transition gaps, segment table,
    insights, caveats), HYROX, Triathlon, Readiness (with "why?" evidence drill-down) and Audit views
    (relabel/exclude/restore, audit log, suspects, "check a claim"). Hand-rolled SVG charts.
    No inline script and no `innerHTML` with data. Keyboard accessible (see `references/accessibility-checklist.md`).
  - Verify: `npm run build`, then `npm run dev`, call the tool from MCP Inspector, and check the views in a browser.
    A relabel made in the UI shows up in `audit_performance_data`.
  - Files: `index.html`, `app.js`, `style.css`, `package.json` build script
  - Depends on: T10

- [ ] **T12: Docs + release prep**
  - Acceptance: README, `references/tools.md`, `references/privacy.md` (new local files) and
    CHANGELOG are updated. Full gate is clean: `npm test && npm run lint && npm run typecheck && npm run build`.
  - Files: docs only
  - Depends on: T11

## Checkpoints

1. After T1–T6: pure logic and storage are done. Review the numbers against hand calculations.
2. After T9: try all tools in MCP Inspector with a real account (manual, never in tests).
3. After T11: dashboard security review (`security-auditor` agent) before release.
