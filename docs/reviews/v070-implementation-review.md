# 0.7.0 Implementation Review

Date: 2026-09-10. Scope: approved trustworthy-core plus baseline/sleep-debt implementation.
This is an implementation self-review and dependency triage, not an independent audit.

## Findings Addressed

- Correctness: latest records are no longer independently combined into a current-day
  recovery. Pending/invalid primary sleep, missing joins, stale cycles, null provider
  fields and endpoint failures have explicit regression coverage.
- Correctness: relative sleep windows use the supplied clock. Stage sums and signed
  nap adjustments determine observed deficits; WHOOP standing debt stays separate.
- Security: aggregate mode fails closed at registration and uses per-tool schemas to
  project allowed fields. Record arrays, latest observations, identity fields and exact
  record timestamps are excluded. Resources/prompts cannot bypass the allowlist.
- Security: tool and resource errors no longer echo provider bodies or arbitrary
  exception messages. Local diagnostics inspect metadata only and never perform OAuth.
- Architecture: existing API client, paginator, statistics and transports are reused.
  No new endpoint, OAuth scope, runtime dependency or persisted health store was added.
- Performance: today remains four parallel bounded calls; analytics uses at most
  500 records per source, honors paginator delays/caps, and bounds echoed nights at 30.
- Readability: schemas are shared for validation/output and pure helpers centralize
  local-day attribution, source quality, main-sleep selection and statistical conventions.

## Dependency Triage

Before remediation, npm reported 15 findings: two critical, seven high, four moderate,
two low. Targeted `npm update` of identified vulnerable packages within existing
ranges refreshed the lockfile; manifest ranges and direct dependency count did not change.

After remediation, `npm audit --omit=dev` reports zero vulnerabilities. The full audit
reports three moderate package entries (`vitest`, `@vitest/mocker`, and
`@vitest/coverage-v8`) for one underlying
[redirect-mock file-read advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).
These are development-only, excluded from the published runtime. The audit's suggested
fix is a major Vitest migration; the advisory identifies fixed versions at 4.1.11+.
No major upgrade or risk suppression was applied. Avoid exposing development/test servers
to untrusted clients; schedule a separate test-runner migration.

## Verification Sources

Final automated verification: 797 tests in 43 files; 95.61% overall line coverage,
98.84% API and 99.18% auth. Lint, typecheck, build, format check and whitespace
checks pass. Both real stdio subprocess and HTTP transport tests use synthetic data.
The built doctor command was smoke-tested without network access.

- [MCP output schemas and structured content](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
- [Zod object parsing and unknown-key stripping](https://zod.dev/api#objects).
- [WHOOP member API](https://developer.whoop.com/api).
- [Execution and release checklist](../plans/task-17-v070-trustworthy-personal-analytics.md).

## Residual Limitations

Recorded offsets cannot infer future timezone rules or within-sleep DST transitions.
Old calendar/weekly-summary grouping stays UTC. Fetch timestamps/cache hits remain
unknown where the client lacks that metadata. Whole malformed records are conservatively
excluded from new analytics; no attempt is made to reconstruct corrupted measurements.
Health aggregates remain sensitive and still reach the assistant provider.
Manual desktop-client display checks and release authorization remain outstanding.

## PR Documentation And Site Check

README and changelog describe the unreleased 0.7.0 scope and compatibility changes;
historical npm comparison entries remain labeled as published 0.6.1 information.
The site retains its existing design while adding a release preview, data-quality
and privacy notes, and accurate published-install instructions. Browser checks at
1440px, 390px and 320px found no horizontal overflow or missing internal anchors.
The 320px header was adjusted to wrap navigation instead of the product wordmark.
No browser page errors were observed on reload. The tracked favicon is present.
Copy-button payloads match the displayed commands; clipboard write permissions
were not altered or bypassed during testing.
