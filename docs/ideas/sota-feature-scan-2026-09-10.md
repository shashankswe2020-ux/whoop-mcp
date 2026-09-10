# WHOOP MCP Feature Opportunity Scan

Date: 2026-09-10. Status: research recommendations, not an approved implementation plan.

## Recommendation

Prioritize trustworthy, composable answers over tool count: structured results,
explicit data quality, privacy controls, then the existing personal-baseline
analytics roadmap. Add proactive updates only after approving the hosting and
security requirements. Do not promise proprietary WHOOP metrics that the public
member API does not expose.

## Verified Local Baseline

- Rebased local `main` onto `origin/main` at `1a370ae`; two local commits remain ahead.
- Package version is `0.6.1`; 14 tools, four resources, five prompts, HTTP and stdio.
- The rebased source passes 750 tests across 37 test files with the installed dependencies.
- [Server result formatting](../../src/server.ts) serializes JSON into text blocks;
  it does not yet supply `structuredContent` or `outputSchema`. Read-only annotations
  already exist, so annotations are not a new feature opportunity.
- [Task 16](../plans/task-16-v4-personal-analytics.md) and the
  [coaching draft](../specs/v5-coaching-personalization.md) are plans, not shipped tools.
  Their `0.6.0` target and older baseline counts are stale relative to the package.
  Choose a future release label when approving them; this scan does not relabel drafts.
- The [README comparison](../../README.md) contains an August 30 registry snapshot.
  Competitor feature statements are documentation signals, not proof of quality or security.

## Live Ecosystem Evidence

Public npm metadata was queried on September 10 for four representative packages.
This is a targeted comparison, not an exhaustive market survey. Dependency counts
are direct runtime dependencies, not total transitive packages. `mcpName` in a
manifest is an identity declaration, not independent registry-listing verification.

| Package                | Latest | Published UTC | Runtime deps | Evidence-backed signal                                                                                                         |
| ---------------------- | ------ | ------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `whoop-ai-mcp`         | 0.6.1  | 2026-08-07    | 2            | Existing analytics, HTTP/stdin-stdout transports, no database.                                                                 |
| `whoop-mcp-unofficial` | 0.6.5  | 2026-08-29    | 6            | Documents privacy modes, optional SQLite, synthetic demo, diagnostics and a CLI tool-call interface.                           |
| `mcp-server-whoop`     | 0.2.2  | 2026-07-17    | 2            | Documents five focused tools, pending-score safeguards, local timestamps, identity suppression and artifact security evidence. |
| `@nchemb/whoop-mcp`    | 0.2.0  | 2026-04-27    | 4            | Documents local SQLite history, read-only SQL and an OAuth relay with a stated test-user capacity limit.                       |

Metadata sources: [this package](https://registry.npmjs.org/whoop-ai-mcp),
[unofficial](https://registry.npmjs.org/whoop-mcp-unofficial),
[mcp-server-whoop](https://registry.npmjs.org/mcp-server-whoop),
[@nchemb](https://registry.npmjs.org/@nchemb%2Fwhoop-mcp).
Feature sources: [davidmosiah](https://github.com/davidmosiah/whoop-mcp),
[Yadheedhya06](https://github.com/Yadheedhya06/mcp-server-whoop),
[nchemb](https://github.com/nchemb/whoop-mcp).

The repository documentation was read, but competitor packages were not installed,
executed or security-audited. Main-branch documentation may differ from published
artifacts. Privacy-mode labels do not establish aggregate-only guarantees. Claims
that data "never leaves the machine" must account for the assistant receiving it.

The useful competitive distinction is not maximum tool count: one alternative
emphasizes broad automation, another a deliberately narrow and explicit data
contract. This project can retain its two-dependency/no-database default while
adopting better output semantics and diagnostics.

## Already Planned, Not New Discoveries

Task 16 already covers personal baselines, anomalies, sleep debt, training load,
weekday patterns, workout analytics, event readiness, travel impact, reports and
lagged correlations. Its deferred tier includes behavior logging and CSV import.
The coaching draft adds daily recommendations, sleep projections and population
benchmarks. These remain useful backlog items, but should not be counted again as
new features discovered by this scan.

## Prioritized Opportunities

Effort is relative: S = a bounded existing surface; M = shared behavior or a new
analytical slice; L = persisted state, hosting or cross-client integration.
Priorities are engineering judgment, not measured customer demand.

| Priority | Opportunity                              | User value and smallest useful increment                                                                                                                                                                           | Effort and dependencies                                                                                   |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| P0       | Structured results and evidence metadata | Add `outputSchema` and `structuredContent`, retaining JSON text compatibility. Include units, requested/observed windows, source IDs, computation version and exclusions where applicable. Start with `get_today`. | M; existing SDK and Zod, no new WHOOP endpoint.                                                           |
| P0       | Data-quality and freshness explanations  | Answer "Is this really today's recovery?" Distinguish pending scores, missing data, calibration, incomplete recording and truncated history. Expose fetch time separately from source update time.                 | M; build shared conventions alongside task 16b.                                                           |
| P0       | Minimal-disclosure mode                  | Opt-in aggregate-only responses and identity suppression across tools, resources and reports. State clearly that data sent to an assistant is outside this server's privacy boundary.                              | M; common output policy and cross-surface tests; no new storage needed.                                   |
| P1       | Reliable cross-tool local-day context    | Make today, calendar, summaries and analytics agree around midnight. Join records by IDs first, label local-day attribution explicitly and never substitute an old recovery for a missing current one.             | M; extend task 16b to existing tools through an approved migration.                                       |
| P1       | Explain a recovery change                | Show concurrent changes in sleep, load, HRV and RHR relative to the user's prior baseline, with coverage and uncertainty. Describe associations, not causal contributions to WHOOP's proprietary score.            | M; composition over task 16 foundations, not a duplicate correlation engine.                              |
| P1       | Nap and workout-timing analysis          | Compare next main-sleep outcomes after naps or earlier/later workouts, with matched-day counts and baseline context.                                                                                               | M; extend planned workout/sleep analytics, explicit confounding caveat.                                   |
| P1       | Training-zone distribution               | Summarize WHOOP heart-rate-zone minutes by week and sport; expose recording coverage. Do not label WHOOP zones as laboratory lactate thresholds or infer VO2 max.                                                  | S-M; workout score fields, can fit inside planned workout analytics.                                      |
| P1       | Shareable bounded report resources       | Extend planned report generation with an MCP resource link for larger outputs, explicit expiry and redaction; retain a compact inline summary.                                                                     | M; resource authorization and memory/size limits. Disk persistence requires separate approval.            |
| P2       | Live refresh from verified webhooks      | Invalidate stale records and notify connected resource subscribers when recovery/sleep/workout changes. Add reconciliation for missed events.                                                                      | L; HTTPS receiver, replay/dedup protection, account binding and deployment approval.                      |
| P2       | Guided personal experiments              | Extend deferred behavior logging with a chosen intervention, baseline period, adherence tracking and before/after effect estimates. Observational results must not imply causality.                                | L; consent, secure local persistence, deletion/export and statistical review.                             |
| P2       | Long-running report jobs                 | Progress, cancellation and optional task execution for bounded historical reports, only if measured latency warrants it.                                                                                           | M-L; MCP task support is experimental in the cited spec; require client negotiation and result isolation. |

## Public API Feasibility

The [WHOOP API reference](https://developer.whoop.com/api) is the authority for
data availability, not screenshots of the consumer app.

- Existing member scopes expose recovery HRV/RHR/SpO2/skin temperature, sleep
  stages/need/consistency/efficiency, cycle strain/energy, and workout zones,
  recording percentage, distance and elevation. These support the P0/P1 ideas.
- The reviewed member API does not expose journal entries, raw continuous heart
  rate, ECG, blood pressure, Healthspan/WHOOP Age or strength sets/reps. Treat these
  as unavailable through existing scopes, not as tools waiting for implementation.
- The current reference also documents **trusted-partner lab operations** under a
  separate client-credentials authorization scheme. Their presence is not evidence
  that an ordinary member OAuth app can retrieve lab results. Defer pending partner access.
- Do not claim the entire API is read-only: member access revocation is documented
  as `DELETE /v2/user/access`. A disconnect/revoke feature is feasible but needs
  explicit approval for the new endpoint and token lifecycle changes.
- [Webhooks](https://developer.whoop.com/docs/developing/webhooks/) are configured
  in the developer dashboard, not through an assumed webhook-management REST API.
  A receiver is feasible even though the old `manage_webhooks` proposal was deferred.
- V2 recovery events identify the associated **sleep UUID**, not the cycle ID.
  Verify timestamp-plus-raw-body HMAC-SHA256 signatures, deduplicate deliveries,
  handle deletions, bind the user ID, and reconcile missed events. WHOOP does not
  currently document cycle/day-strain/body-measurement webhook events.
- Resource notifications need a connected, supporting MCP client. Offline alerts
  require a scheduler and delivery channel; neither a webhook nor MCP alone supplies them.

## Statistical And Product Gates

1. Ship missingness, calibration and baseline self-exclusion before interpreting scores.
   Constant baselines should carry an explicit limitation, not reassurance based only on `z=0`.
2. Review task 16's ACWR and coaching thresholds before implementation. Do not turn a
   heuristic ratio into a validated injury-risk category or a guaranteed training prescription.
3. For lag searches and repeated correlations, address autocorrelation, multiple
   comparisons, minimum paired observations and uncertainty. A naive Pearson cutoff
   alone is not sufficient evidence for a personalized causal recommendation.
4. Offset changes indicate clock changes, not confirmed travel; an offset is not an
   IANA timezone and cannot determine future DST. Ask for timezone context when forecasting.
5. Distinguish sleep opportunity planning from predicting recovery color or race performance.
   Population comparisons need measurement-compatible sources, not invented percentile tables.
6. Start with explicit evidence fields; evaluate assistant answer accuracy and tool
   selection on fixed scenarios before claiming these features improve coaching.

## Suggested Delivery Order

1. Approve a future release label and reconcile the stale task-16/coaching baselines.
2. Ship one `get_today` structured-output/data-quality slice with compatibility tests.
3. Add privacy policy enforcement across every output surface.
4. Build task 16a/16b and the baseline/sleep slices, then add recovery-change and timing views.
5. Extend reports with bounded resources. Consider webhooks or persistent experiments
   only after explicitly approving their additional storage, hosting and security scope.

## Additional Confirmed Opportunities

### P1: Diagnostics And Synthetic Demo (S-M)

Add a non-interactive `doctor` command and an explicitly synthetic demo mode.
Report configuration readiness, granted scopes when known, token-expiry status
and available data domains without exposing credentials or health records.
Local-only checks should make no WHOOP calls; live verification must be explicit.
Use the same output schemas for synthetic and real results, with an unmistakable
demo marker. Existing `setup --verify` is useful but is not the whole diagnostics
experience. Competitor evidence: `whoop_connection_status`, `whoop_data_inventory`,
`whoop_demo`, and `doctor` in the unofficial server.

### P1: CLI Access To Existing Tools (M)

Expose the same validated read-only handlers to scripts and agents that do not
support MCP, with JSON output, stable exit behavior and no duplicated analytics.
An allowlisted `call` command could enable scheduled personal reports without
running a remote server. Do not accept arbitrary endpoints, shell fragments or
credentials in arguments. Competitor evidence: the unofficial server's CLI/skill
interface. A distributable usage skill is optional, not a reason to fork handlers.

### P1: Interactive In-Chat Analytics (M-L, Gated)

[MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) now documents
interactive HTML resources rendered within supporting hosts, including Claude
and VS Code. A recovery calendar with click-through records, baseline bands and
date/metric filters would make the existing data easier to inspect.

Start with a read-only visualization of `get_calendar` or `get_trend`, reuse the
structured contract, and retain text/JSON results for unsupported clients. Keep
credentials server-side, use restrictive CSP and avoid third-party analytics.
The extension uses a `ui://` resource and `_meta.ui.resourceUri`; it is not an
ordinary resource link that every client will render. Any additional runtime
package or frontend build tooling requires approval before implementation.

### P2: Offline History And Bounded Exploration (L, Gated)

An opt-in local archive would enable long-window queries and reports without
repeated full-history downloads. Both SQLite-based alternatives show this use
case, but adding a database would change this project's default architecture.
Prefer bounded typed filters/aggregations over unrestricted SQL initially.

Require storage consent, retention/deletion/export controls, account separation,
resumable sync, correction/deletion handling and visible last-sync timestamps.
[WHOOP documents](https://developer.whoop.com/docs/developing/rate-limiting/)
default limits of 100 requests/minute and 10,000/day, with headers describing the
actual budget. Budget pagination and deduplicate shared fetches before attempting
year-scale history; never silently exceed the existing record caps.

## Verification And Release Caution

- `npm ci --ignore-scripts` synchronized installed dependencies to the rebased lockfile.
- After synchronization: 750 tests passed; lint, typecheck and build passed.
- Rebase `range-diff` showed both local patches unchanged. All six restored draft
  files matched the saved stash, including hashes for the three untracked files.
- npm reported 15 dependency advisories: two low, four moderate, seven high and
  two critical. These are registry audit findings, not verified exploitability in
  this server. Triage runtime versus development exposure before the next release;
  no automatic dependency fixes were applied as part of this feature scan.
- No features, public endpoints, OAuth changes, storage changes, commits or pushes
  were added by this scan. The named pre-rebase stash remains as a backup.

## Protocol Sources

- [MCP tools, structured content, output schemas and resource links](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
- [MCP resource subscriptions](https://modelcontextprotocol.io/specification/2025-11-25/server/resources).
- [MCP Apps and host support](https://modelcontextprotocol.io/docs/extensions/apps).
- [MCP tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks):
  experimental in this version, capability-negotiated, with cancellation, TTL and isolation requirements.

These are version-pinned protocol sources, not a claim that every installed client
supports every feature. Verify target SDK/client combinations before implementation.
