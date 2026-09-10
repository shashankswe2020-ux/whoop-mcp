# Task 17: Trustworthy Personal Analytics Execution

Approved for implementation and publication: 2026-09-10. Release: 0.7.0.
Contract: [release spec](../specs/v070-trustworthy-personal-analytics.md).

## Increment Status

1. [x] Current-day regression and score-state guard. Verified pending primary sleep
       suppresses recovery. Check: `npm test -- tests/tools/get-today.test.ts`.
2. [x] Bounded selection, ID joins, recorded-offset days and quality metadata.
       Verified stale/mismatched/invalid records, partial endpoints, null scores and open cycles.
       Preserved legacy duration; added asleep/time-in-bed fields.
3. [x] Shared analytics validation, percentile and circular-clock primitives.
       Existing paginator reused with page validation and a 500-record cap.
       Check: `npm test -- tests/tools/analytics-utils.test.ts`.
4. [x] Personal baselines and sleep debt with synthetic fixtures and insufficient-data
       behavior. Check: `npm test -- tests/tools/get-baselines.test.ts tests/tools/get-sleep-debt.test.ts`.
5. [x] Schema-validated MCP results and aggregate-only registration/projections.
       Check: `npm test -- tests/server-release.test.ts tests/server.test.ts tests/resources/index.test.ts`.
6. [x] Local diagnostics and early process privacy validation.
       Check: `npm test -- tests/cli/doctor.test.ts tests/index.test.ts`.
7. [x] Real stdio child-process and authenticated HTTP parity with synthetic data.
       Check: `npm test -- tests/transport/stdio-mcp-integration.test.ts tests/transport/http-mcp-integration.test.ts`.
8. [x] Targeted compatible lockfile advisory fixes; no dependency range changes.
       Runtime audit is clean; development-only moderate Vitest advisory remains.
9. [x] README migration guidance, unreleased changelog, spec status and backlog linkage.
10. [x] Site release preview and local [PR description](../reviews/v070-pr-description.md).
        Published 0.6.1 installation is distinct from upcoming 0.7.0 capabilities.
        Browser layout checked at 1440px, 390px and 320px; no horizontal overflow,
        valid internal anchors and matching displayed/copied installation commands.

## Release Gates

- [x] Implementation increments tested before proceeding; no tests deleted or skipped.
- [x] Code/security self-review fixes applied: invalid-newest fallback, date-clock injection,
      malformed page classification, nullable scores, resource error redaction and aggregate timestamp minimization.
- [x] Final formatting, full test/coverage, lint, typecheck and build pass recorded:
      797 tests across 43 files; 95.61% line coverage overall, 98.84% API and 99.18% auth.
      `npm run format:check` and `git diff --check` also pass.
- [x] Built `node dist/index.js doctor --json` smoke-tested. It correctly reports
      missing shell credentials without network calls; local token-file metadata checks pass.
- [x] Manual Claude Desktop or VS Code client smoke check confirmed passed by the
      release owner on 2026-09-10: standard and aggregate modes. This is a user
      confirmation, not a claim of an additional agent-run desktop UI test.
- [x] Human release review and publishing authorization received; package, lockfile
      and MCP registry descriptor versions synchronized to 0.7.0.
- [ ] Publication verified against the npm registry after the release workflow.

The automated transport checks are not a claim that a desktop client's UI was
manually exercised. No WHOOP health API calls were made in automated tests.
Creating the feature branch and PR does not publish a package. Publication requires
separate authorization after the remaining release gates are complete.
