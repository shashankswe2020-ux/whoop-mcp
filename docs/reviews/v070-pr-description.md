# PR: Add Trustworthy Personal Analytics And Aggregate Privacy

## Summary

Prepare the approved 0.7.0 feature scope without publishing or changing package
version metadata beyond the previously local 0.6.1 baseline. Standard mode offers 16 tools, four resources and five prompts.
Aggregate mode exposes only five summary/analytics tools.

This branch also includes the two previously local baseline commits: the 401
error/token-persistence fix and the 0.6.1 version update. It does not bump to 0.7.0.

- Add personal baseline distributions and sleep-debt analysis with explicit sample
  counts, bounded history, baseline self-exclusion and insufficient-data states.
- Match current-day recovery to its cycle and primary sleep. Suppress stale,
  pending, invalid or unjoinable results instead of substituting older scores.
- Advertise output schemas and return equivalent structured content and JSON text.
- Enforce process-level aggregate privacy at registration and output boundaries;
  sanitize tool/resource errors and minimize exact-record metadata.
- Add local-only `doctor` diagnostics and compatible dependency advisory fixes.
- Update README, changelog and site together. The site explicitly distinguishes
  upcoming 0.7.0 functionality from the published 0.6.1 install commands.

## Compatibility

- Default mode remains `standard`; existing tool names and input defaults remain.
- `get_today.sleep.total_hours` retains time-in-bed semantics. New
  `time_in_bed_hours` and `asleep_hours` fields are explicit; summaries use asleep time.
- Missing optional sleep percentages now return null, not zero.
- `WHOOP_MCP_PRIVACY_MODE=aggregate` hides raw tools, resources and incompatible
  prompts. Tool arguments cannot override the policy; reconnect after changing it.
- Calendar/weekly-summary UTC grouping stays unchanged. New analytics uses recorded
  offsets; these cannot reconstruct future timezone rules or within-sleep DST changes.
- No new direct runtime dependency, WHOOP endpoint, OAuth scope or persisted health store.
- Remaining Task 16 analytics, forecasts, webhooks, UI apps and local databases are not included.

## Verification

- [x] 797 tests across 43 files; all WHOOP responses in automated tests are synthetic.
- [x] Real stdio subprocess and authenticated HTTP contract/privacy tests.
- [x] Lint, typecheck, build, source/test formatting and whitespace checks.
- [x] Coverage: 95.61% overall lines, 98.84% API, 99.18% auth.
- [x] Production dependency audit: zero findings after targeted compatible updates.
- [x] Built local-only diagnostics smoke test; no OAuth or health API calls.
- [x] Site browser checks at 1440px, 390px and 320px: no horizontal overflow,
      valid internal anchors, matching copy-command payloads, desktop/mobile screenshots.

## Known Risks And Release Follow-Ups

- Three moderate development-only Vitest audit entries remain for the redirect-mock
  advisory. Remediation requires a separate major-version migration; do not expose
  test/development servers to untrusted clients.
- [ ] Manually verify Claude Desktop or VS Code display/discovery in both privacy modes.
- [ ] Complete human release review, then synchronize package, lockfile and MCP registry
      version metadata to 0.7.0 and authorize publication. Existing registry metadata is 0.6.0;
      package metadata is 0.6.1. Neither is bumped in this feature PR preparation.

References: [release specification](https://github.com/shashankswe2020-ux/whoop-mcp/blob/feature/v070-personal-analytics/docs/specs/v070-trustworthy-personal-analytics.md),
[execution checklist](https://github.com/shashankswe2020-ux/whoop-mcp/blob/feature/v070-personal-analytics/docs/plans/task-17-v070-trustworthy-personal-analytics.md),
[implementation review and security triage](https://github.com/shashankswe2020-ux/whoop-mcp/blob/feature/v070-personal-analytics/docs/reviews/v070-implementation-review.md).

## Scope Note

Supporting analytics/coaching drafts are included as historical design context,
not as additional implemented scope. Pre-existing edits to the Task 14 and Task 15
plans and the general implementation plan are left outside this PR. No package
publication is performed by opening this PR.
