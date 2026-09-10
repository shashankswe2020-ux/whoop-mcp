# Next Release: Trustworthy Personal Analytics

> Status: approved by the user on 2026-09-10; implemented in the working tree, not published.
> Proposed release: `0.7.0`, from shipped package `0.6.1`.
> Date: 2026-09-10.
> Baseline: 14 tools, four resources, five prompts; 750 tests passing.
> Evidence: [September SOTA scan](../ideas/sota-feature-scan-2026-09-10.md).

## Objective

Deliver trustworthy current-day answers plus two descriptive analytics tools:
`get_baselines` and `get_sleep_debt`. Users should be able to ask "Is this current?",
"Is this typical for me?" and "How much sleep have I missed?" without receiving
stale scores, invented zero values or unsupported medical interpretations.

The user selected **core plus personal analytics**. This proposal includes structured
results, freshness/pending-score safeguards, opt-in privacy controls, local diagnostics,
personal baselines and sleep debt. It does not expand the release to every SOTA idea.

## Assumptions And Scope

- Keep the SDK and Zod as the only direct runtime dependencies; no new WHOOP endpoints,
  scopes, OAuth behavior, token storage formats or persisted health data.
- Propose `0.7.0` as the next minor release; do not bump package metadata until release verification.
- Standard mode retains the existing 14 tools, four resources and five prompts.
  Adding the two tools makes 16 tools; do not add separate tools for shared metadata.
- Share calculations through pure helpers, not tool-to-tool calls. Reuse pagination,
  error types and cache primitives. Never create a second statistical engine.
- The new spec controls this release once approved. The broader
  [Task 16 plan](../plans/task-16-v4-personal-analytics.md) remains the analytics backlog.
  Only the necessary subset of 16a/16b, plus 16d and 16e, belongs here.

## Compatibility And Structured Results

- Every successful tool result supplies schema-validated `structuredContent` and a
  JSON text block encoding the same object. Each tool advertises its `outputSchema`.
- Preserve existing tool names, input defaults and existing output fields in standard
  mode. Do not wrap old payloads in a new `data` envelope. Metadata is additive.
- Keep `isError: true` semantics for failures; never disguise errors as valid measurements.
  Errors must not include tokens, upstream response bodies or health records.
- Missing data is `null` with an explicit reason, not zero. `get_today` optional sleep
  performance/efficiency fields becoming nullable is an intentional contract correction,
  documented in migration notes and tested with legacy JSON-text clients.
- Retain `get_today.sleep.total_hours` as the legacy time-in-bed value for compatibility;
  add `time_in_bed_hours` and `asleep_hours` with unambiguous units. Summary text uses
  asleep time, computed as light + slow-wave + REM, excluding awake/no-data time.
- Validate external fields used by new analytics and current-day selection at their
  boundary; malformed/non-finite observations are excluded with counted reasons.

## Shared Evidence Contract

Use an additive `data_quality` object for `get_today` and the two new tools:

- `evaluated_at`: computation time, never presented as upstream fetch time.
- `requested_period` and `observed_period`: explicit ISO bounds; observed is null when empty.
- Per-source metadata: nullable `fetched_at`, nullable `source_updated_at`, records
  fetched/used, exclusion counts, `truncated`, and cache status `hit`, `miss` or `unknown`.
- If the existing client cannot provide an actual fetch timestamp or cache status,
  return null/unknown. Do not substitute computation time or infer cache hits.
- Status/reasons distinguish `available`, `pending`, `missing`, `stale`, `unscored`,
  `calibrating`, `invalid` and `fetch_failed`; partial results name unavailable sources.
- Units, method version and limitations accompany derived metrics. No arbitrary
  percentage "confidence" scores or clinical risk labels.
- Keep raw source IDs out of new metadata by default. Correlation of records uses IDs
  internally; provenance exposed to users is limited to source domains and time windows.

## Current-Day Safeguards

- Select the current cycle and latest relevant non-nap primary sleep from bounded
  collections, not independent `records[0]` values. Join recovery using both
  `cycle_id` and `sleep_id` where corresponding records are available.
- Current recovery requires a matching current cycle and primary sleep. A newest
  pending primary sleep suppresses older recovery; a missing join never falls back
  to an unrelated score. Endpoint failure remains distinct from absent data.
- Compare local days using each record's offset and an injected clock. If cycle
  context is unavailable, mark recovery missing/unverifiable rather than guessing.
  An offset describes recorded local time, not an IANA zone or future DST rules.
- Require `score_state === "SCORED"` for score-derived metrics; calibration is explicit
  and suppresses baseline-relative interpretation. Do not coerce missing scores to zero.
- Keep latest workout separately labeled as historical context with its occurrence
  time; never imply it occurred today merely because it is the latest workout.
- Preserve useful partial responses; all three primary sources failing still raises
  a typed failure. No raw provider error text reaches the assistant.
- Verification fixtures: pending sleep plus older scored recovery; a latest nap;
  mismatched IDs; stale cycle; missing score; near-local-midnight; endpoint failures;
  and in-bed duration different from scored asleep duration.

## Personal Baselines

Implement `get_baselines` from [the analytics draft](v4-personal-analytics.md), with
these clarifications taking precedence over conflicting historical comments:

- Input: `baseline_days`, integer 14-180, default 30. Analyze HRV, resting HR,
  respiratory rate, asleep hours and recovery score using existing read scopes.
- Identify the latest eligible observation per metric, then exclude that observation
  and the current local day from the comparison distribution. Exclude calibration,
  non-SCORED data and invalid numeric values. Sleep uses one main non-nap sleep per wake day.
- Require at least 14 valid historical observations per metric after exclusions.
  Otherwise return a null band with sample count and an insufficient-data reason.
- Provide mean, median, standard deviation and p10/p25/p50/p75/p90 using linear
  interpolation. Latest percentile uses midrank: `100 * (below + 0.5 * equal) / count`.
  A constant baseline gets `constant_baseline: true`, not a claim of normality.
- Join recovery to cycles for local-day attribution. Missing cycle context excludes
  that observation and is counted; never use recovery update time as the physiological day.
- Report actual observed bounds, explicit truncation and the canonical disclaimer.
  No population norms, diagnosis, anomaly alerts or causal interpretations.
- Tests cover interpolation endpoints, ties, no self-inclusion, calibration,
  missing joins, metric-specific insufficiency, constant data and pagination caps.

## Sleep Debt

Implement `get_sleep_debt` from the analytics draft, with these pinned semantics:

- Input: `days`, integer 3-90, default 14; optional `start` accepts the existing
  ISO/relative-date parser. `start` anchors a window of `days` calendar days;
  without it use the last `days` days. Clamp to evaluation time and reject future
  or empty ranges. Return resolved bounds so the assistant can inspect the choice.
- Use the longest SCORED non-nap sleep by elapsed duration per local wake day;
  break ties by latest end, then stable ID. Exclude invalid records with counted reasons.
- Needed hours = baseline + recent strain + recent nap, preserving the nap field's
  sign and excluding WHOOP's accumulated sleep-debt component.
- Achieved hours = scored asleep stages. Daily deficit is `max(0, needed - achieved)`.
  `total_debt_hours` is the sum of observed nightly deficits, not outstanding debt
  or a prediction of how much extra sleep will restore recovery.
- Return WHOOP's latest standing debt separately as `standing_debt_hours` when present,
  with its source date; never derive it from the window sum.
- Fewer than three usable nights produces insufficient-data status and null aggregates,
  not zero debt. Missing nights are not treated as zero-sleep nights.
- Use circular clock-time statistics for bedtime, wake time and midpoint comparisons.
  Social jetlag is the shortest circular distance between weekday/weekend mean
  midpoints; null if a group is absent or its circular mean is undefined.
- Use elapsed timestamps for durations and recorded offsets for local clock labels.
  Document that a single offset cannot reconstruct within-sleep DST changes.
- Compute aggregates on the full bounded dataset; expose at most 30 nightly records,
  with separate output-cap and upstream-truncation flags. Canonical disclaimer required.
- Fixtures cover naps, signed nap adjustment, debt double counting, stage sums,
  midnight clock wrapping, DST-adjacent records, missing groups, missing nights and caps.

## Privacy Controls

- Add process-level `WHOOP_MCP_PRIVACY_MODE=standard|aggregate`, default `standard`.
  Validate before registration. Tool arguments and prompts cannot override this policy.
- Aggregate mode exposes only an allowlist of aggregate-capable tools: weekly summary,
  period comparison, trend, baselines and sleep debt. Return aggregate fields only:
  no profile/body details, raw records, per-day arrays, latest observations, individual
  source IDs, email/name or exact activity timestamps. Analysis-window dates are allowed.
- Do not register individual-record, collection, today or calendar tools in aggregate
  mode; reject direct calls too. Disable the four raw resources. Filter prompts whose
  workflows require disabled tools; do not promise unavailable capabilities.
- Use per-tool allowlisted output projections, not generic recursive key deletion.
  Generate summaries only from allowed fields. New tools remain unavailable in aggregate
  mode until an explicit projection and leakage test exist.
- The same projected object feeds structured and text results. Cover HTTP and stdio,
  resource reads, tool discovery/direct calls, prompt retrieval and error paths.
- Document that aggregate health data still reaches the assistant provider. This is
  minimization, not anonymization, and does not erase data already shared with a client.

## Local Diagnostics

- Add `whoop-ai-mcp doctor` with readable output and `--json` for scripts.
- Check runtime, required configuration presence, configured transport/privacy mode
  and token-file presence/permissions without fetching WHOOP data, opening a browser,
  refreshing tokens, rewriting files or printing configuration values/token paths.
- Do not claim granted scopes or token validity from configuration alone. Unknown
  values remain unknown. Direct users to existing `setup --verify` for explicit live checks.
- Exit 0 for locally ready, 1 for remediation needed, 2 for invalid invocation.
  Tests inject filesystem/configuration dependencies and assert zero network/auth calls.
- Synthetic demo and generic CLI tool calls are later work, not release requirements.

## Delivery Boundaries

Deferred: anomaly alerts, training-load risk categories, correlations, weekday/workout
analytics, coaching forecasts, benchmarks, report export, MCP Apps, webhook receivers,
offline databases, behavior journals, CSV import and experimental MCP tasks.

Existing calendar/weekly-summary UTC grouping is not silently migrated in this release.
Label their convention explicitly and document its difference from new offset-local
analytics. A cross-tool date migration requires its own approved compatibility contract.

## Engineering Conventions

Use strict TypeScript, named exports, explicit exported return types and kebab-case
files. Co-locate new tool schemas and handlers; mirror source files under `tests/`.
Follow the current pattern:

```typescript
export async function getToday(client: WhoopClient): Promise<TodaySnapshot>;
```

Keep orchestration in tool handlers, pure statistics in `src/tools/stats-utils.ts`,
and date/quality conventions in a small shared analytics helper. Wire registrations
through `src/server.ts`, process configuration through `src/index.ts`, and diagnostics
under `src/cli/`. Do not build unused correlation primitives for this release.

## Testing And Release Gates

Use Vitest and mocked WHOOP fetches. Write failing tests before behavior changes;
test pure statistics first, then handler fixtures and in-memory MCP contracts.
Run `npm test` after each increment. Keep existing tests and add documented assertions
for intentional compatibility corrections rather than deleting failing cases.

```sh
npm test -- tests/tools/get-today.test.ts tests/server.test.ts
npm test
npm run lint
npm run typecheck
npm run build
npm test -- --coverage
```

- All output schemas match returned structured results and serialized text; both
  new tools are registered in standard mode with unique names and bounded inputs.
- Standard/aggregate capabilities match their documentation; no forbidden-field
  leakage across any exposed surface, including errors and resource access.
- Maintain >80% auth/API coverage and >70% overall; do not remove or skip failures.
- Triage the scan's 15 npm advisories, including two critical, against the current
  lockfile. Unresolved applicable high/critical issues block release absent explicit
  documented risk acceptance. No blind `npm audit fix` or major dependency upgrades.
- Run code/security review and manual supported-client checks for structured results,
  JSON-text fallback and aggregate-mode discovery before packaging.
- Update README, changelog and client migration notes only with implemented behavior.
  Version metadata changes happen after gates pass; publishing/committing needs approval.

## Approval And Execution

The user approved the release contract and requested implementation on 2026-09-10.
See the [execution checklist](../plans/task-17-v070-trustworthy-personal-analytics.md)
for implemented slices and outstanding release gates. Package metadata remains at
0.6.1 until manual client smoke checks and release authorization are complete.

Aggregate output omits observed-record timestamps and source-update timestamps;
exposed period bounds are reduced to calendar dates. All five existing prompts
depend on excluded raw capabilities and are therefore unavailable in aggregate mode.
No new aggregate prompt was added. Existing raw resource payloads remain unchanged
in standard mode, but their errors are sanitized.
