# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Dashboard redesign: warm light/dark theme, serif headings, and sections
  divided by rules instead of stacked cards. Readiness leads with a large
  verdict and a summary of red/amber components; each component is one row, and
  the band rule moves into a "How the verdict is decided" disclosure.
- Dashboard copy uses sentence case and plain labels ("Not ready", "Bad HR",
  "Discipline share %") instead of raw identifiers; method names show as code.
- Audit groups flagged records by rule, with one "Correct…" button per row;
  groups over three rows start collapsed. Candidate workout ids are compact
  confirm chips.
- Chart axes use rounded ticks with gridlines.

### Security
- Browser-launch failure logs no longer print the URL fragment, so the dashboard
  access token never reaches stderr (#295).
- Performance writes take an interprocess lockfile (`performance.lock`), so two
  MCP processes can't lose each other's updates. Busy writers get a clear
  "try again" error (#296).
- Store change and audit entry are one transaction: if the audit append fails,
  `performance.json` is rolled back, so "Nothing was changed." is true. A failed
  rollback is reported as a partial write (#293).
- Audit-log reads scan backwards and stop after the requested entries, 10,000
  lines or 2 MiB; oversized lines are skipped (#292).
- An existing data directory must be owned by you and is tightened to `0700`; the
  audit log is opened without following symlinks and tightened to `0600` (#294).

## [1.0.0] - 2026-10-18

### Added
- HYROX and triathlon performance tracking: `get_hyrox_session_report`,
  `get_hyrox_performance`, `get_triathlon_performance`, `get_race_readiness`,
  `audit_performance_data` and `verify_claim`.
- Local-only tools: `log_race_result` (validated HYROX station and triathlon leg
  splits), `annotate_workout` (relabel, exclude or restore a workout) and
  `open_performance_dashboard`.
- Readiness band from recovery, training form (Edwards TRIMP CTL/ATL/TSB),
  specificity, sleep debt and taper. Each component carries its evidence and the
  band rule is returned verbatim.
- Audit features: every metric reports its method, window and records used or
  excluded; automatic suspect-record rules; caveats on every result; an
  append-only audit log; and claim verification.
- Local dashboard on `127.0.0.1` with Session, HYROX, Triathlon, Readiness and
  Audit views. Token-protected, Host/Origin checked, strict CSP, no third-party
  assets, stops after 30 idle minutes.
- Local files `performance.json` and `performance-audit.jsonl` in `~/.whoop-mcp`
  (0600).

### Notes
- The race tools are not available in aggregate privacy mode. Remote HTTP mode
  exposes only the six read-only race tools.

## [0.9.1] - 2026-10-09

### Changed
- Replaced Buy Me a Chai sponsorship links with the active Buy Me a Coffee
  profile across setup output, the README, GitHub funding metadata, and
  contributor messaging.
- Added a branded Buy Me a Coffee button and updated sponsor link to the public
  project website.
- Updated `@modelcontextprotocol/sdk` to `1.32.1`, removing the high-severity
  OAuth credential-forwarding advisory affecting versions through `1.30.1`.
- Pinned the collector's transitive `sharp` tooling to `0.35.5` or newer,
  removing the high-severity librsvg advisory from release CI.

### Verification
- 934 tests across 51 files pass.
- Lint, formatting, typecheck, build, package dry-run, and production website
  checks pass.

## [0.9.0] - 2026-10-06

### Added
- Successful setup responses now end with an optional sponsor link for every
  supported client.
- Added sponsor links to the README, project website, and GitHub funding
  metadata.

### Fixed
- The HTTP transport returns 400 Bad Request for a malformed `Host` header or
  request URL instead of crashing the server process.

### Verification
- 936 tests across 51 files pass.
- Lint, formatting, typecheck, and build checks pass.
- The installed `whoop-ai-mcp@0.9.0` tarball ends setup output with the sponsor
  link and contains 191 expected files; `npm audit` reports zero vulnerabilities.

## [0.8.4] - 2026-09-23

### Fixed
- Tool output schemas now advertise JSON Schema 2020-12, restoring Claude
  Desktop compatibility after its stricter schema-dialect validation.
- Standard and aggregate privacy modes retain their existing output contracts
  and runtime validation.

### Verification
- 890 tests across 48 files pass.
- Lint, formatting, typecheck, build, and package dry-run checks pass.
- The package dry-run reports `whoop-ai-mcp@0.8.4` with 191 expected files;
  `npm audit` reports zero vulnerabilities.

## [0.8.3] - 2026-09-23

### Fixed
- Refresh grants now include WHOOP's required offline scope, restoring silent
  refresh of expired access tokens.
- MCP initialization and tool discovery no longer wait for interactive WHOOP
  authentication. The WHOOP client authenticates lazily and shares one
  in-flight authentication.
- Interactive OAuth is serialized across processes with safe stale-lock
  recovery, preventing repeated browser windows, fixed-port callback races,
  and misleading state-mismatch errors.
- CSRF state and PKCE validation remain intact.

### Verification
- 890 tests across 48 files pass.
- Lint, formatting, typecheck, build, and package dry-run checks pass.
- The package dry-run reports `whoop-ai-mcp@0.8.3` with 191 expected files;
  `npm audit` reports zero vulnerabilities.

## [0.8.2] - 2026-09-21

### Added
- Added privacy-safe tool error categories to opted-in telemetry and the private
  maintainer dashboard. Categories are fixed and coarse; raw errors, response
  bodies, health values and identifiers remain excluded.
- Added a row-preserving collector migration that classifies historical tool
  errors as `unknown` while keeping existing aggregate counts intact.

### Fixed
- Remote MCP requests now accept verified OAuth connector bearer tokens and
  attach their authenticated client context to MCP handlers. Invalid or expired
  tokens continue to return an unauthorized response.

### Verification
- 882 client tests across 47 files and 83 collector/dashboard tests pass.
- Client and collector lint, typecheck, formatting and build checks pass.
- Dashboard rendering was verified at desktop and mobile widths without page
  overflow, console errors or failed requests.

## [0.8.1] - 2026-09-19

### Changed
- Reworked the README into a concise, visual introduction with a demo, example
  questions, a guided quickstart and links to detailed documentation.
- Moved installation, configuration, tool contracts, privacy, telemetry,
  troubleshooting, hosting and development guidance into eight topic guides
  under `references/`.
- Made installation examples version-independent with `@latest` and linked to
  the latest release rather than a fixed package version.
- Updated the public site with consent-based telemetry details, current client
  setup commands, privacy guidance and links to the new reference guides.
- Improved site command wrapping and accessible copy feedback on narrow screens.

### Fixed
- Corrected documentation for pagination, missing measurements, cache behavior,
  token bootstrap, authenticated health probes and release publication.
- Removed outdated setup transcripts and clarified collector retention and the
  maintainer-only dashboard. Preserved the CLI's configuration-help anchor.

No WHOOP API, OAuth, token-storage or telemetry-policy behavior changes.

## [0.8.0] - 2026-09-19

### Added
- One-time telemetry consent during interactive setup, defaulting to No. The
  choice is saved in client configuration; `setup --telemetry=on|off` supports
  explicit scripted choices. Unattended startup remains off without opt-in.
- Private Cloudflare-hosted usage dashboard with owner-only Access/JWT validation,
  daily trends, activity rankings, error rates and package-version filters. No
  unique-user tracking; existing test aggregates remain identified as test activity.
- Opt-in named MCP prompt-template retrieval counts, with strict allowlists and
  a row-preserving aggregate migration. No prompt text, arguments or chat content.
- Opt-in CLI command and MCP tool usage telemetry. Requires
  `WHOOP_MCP_TELEMETRY=1` and an explicit HTTPS collector URL; no default collector.
- Local-only `telemetry status` command. `DO_NOT_TRACK=1` and aggregate privacy
  override opt-in; `doctor` remains strictly local.
- Strict usage-event allowlists, no health data or identifiers, bounded best-effort
  delivery, and a hosted-collector release gate covering retention and access logs.
- Maintainer collector implementation: strict bounded ingestion,
  aggregate-only D1 counts, identifier-free throttling, and a default-off kill
  switch. Synthetic and manual Claude Desktop delivery and live storage-failure
  handling were verified. The owner approved collection for consenting clients
  at release; synthetic counts were removed and six actual Desktop events preserved.

### Fixed
- Setup preserves saved telemetry decisions, custom endpoints and privacy settings
  when credentials change. Invalid optional telemetry endpoints disable collection
  without blocking setup. Setup failures and explicit opt-outs never send events.
- Claude Code registration places environment flags before the executable separator.

### Privacy and Operations
- No default-on tracking, user IDs, installation IDs, chat content, prompt arguments,
  health data or raw event storage. `DO_NOT_TRACK=1`, explicit opt-out and aggregate
  privacy suppress collection. Setup supplies the maintainer HTTPS endpoint only
  after explicit consent; MCP startup does not prompt or assume consent.
- Collector and dashboard tooling remain outside the npm client artifact. Root
  runtime dependencies are unchanged. Collector/dashboard CI runs on Node 22;
  the MCP client remains tested on Node 20 and 22.
- Upgraded Vitest and its coverage provider together to 4.1.11, resolving the
  redirect-mock path-traversal advisory (GHSA-82fw-gwwq-j7x9). Full client and
  private collector dependency audits report zero known vulnerabilities; CI now
  audits development dependencies too.

### Verification
- 870 client tests across 47 files and 77 collector/dashboard tests pass.
- Client line coverage with Vitest 4: 95.40% overall, 98.62% API and 98.54% auth.
- Lint, typecheck, formatting, build, runtime audit and npm package/publish
  dry-runs pass. Consent persistence and opt-out regressions received final approval.

## [0.7.1] - 2026-09-19

### Fixed
- `get_today` now recognizes the current open WHOOP cycle even when it started
  on the previous local calendar day, restoring current strain and recovery
  instead of incorrectly reporting stale or missing data (#245).
- The OAuth authorization and token exchange flows honor
  `WHOOP_REDIRECT_URI` for HTTP loopback callbacks, with validated host, port,
  and path matching. `http://localhost:3000/callback` remains the default
  (#220).

### Changed
- Refreshed development tooling: `@types/node` 26.5.0, TypeScript ESLint
  8.69.0, ESLint 10.9.1, Prettier 3.9.6, and `tsx` 4.23.13.
- Updated GitHub Actions for checkout, Node setup, and Pages configuration,
  artifact upload, and deployment to their current major releases.
- Updated the locked Zod runtime dependency from 4.4.3 to 4.5.4 without
  changing the compatible package range.

### Verification
- **812 tests** across 43 files pass, including regression tests for overnight
  open-cycle matching and validated custom OAuth loopback callbacks.
- Lint, typecheck, build, coverage, production dependency audit, and GitHub
  Pages deployment pass on the release baseline.

## [0.7.0] - 2026-09-10

**Trustworthy Personal Analytics**

### Added
- `get_baselines`: personal percentile bands with baseline self-exclusion, calibration filtering, minimum sample counts and explicit truncation.
- `get_sleep_debt`: observed nightly deficits, separate WHOOP standing debt, circular local-clock consistency and bounded nightly output.
- Output schemas and equivalent structured/JSON-text results for all 16 tools.
- Process-level aggregate privacy mode with a five-tool allowlist, explicit projections and no raw resources or incompatible prompts.
- Local-only `doctor` command with JSON output and stable exit codes.
- Site release overview covering personal analytics, current-day safeguards,
  aggregate privacy and diagnostics, with installation instructions for 0.7.0.

### Fixed
- `get_today` now matches recovery to the current cycle and primary sleep, checks score states, skips naps, and does not substitute older data for pending or invalid current sleep.
- Accept nullable provider score objects and open-cycle end timestamps.
- Tool/resource errors no longer expose provider bodies or arbitrary internal messages.
- Targeted compatible dependency refresh clears runtime and high/critical audit findings. Three moderate development-only Vitest findings remain; a major test-runner migration is deferred.

### Compatibility
- `get_today.sleep.total_hours` retains time-in-bed semantics; new `time_in_bed_hours` and `asleep_hours` are explicit. Summaries use asleep time; missing optional sleep percentages now return null instead of zero.
- New current-day/analytics metadata labels data quality and recorded-offset day attribution. Calendar/weekly-summary UTC grouping remains unchanged.
- Aggregate mode intentionally reduces capabilities and output detail. Standard remains the default. No new runtime dependency, OAuth scope, WHOOP endpoint or health-data storage was added.

### Verification
- 750 → **797 tests** across 43 files, including real stdio subprocess and authenticated HTTP tests with synthetic WHOOP data.
- Line coverage: **95.61% overall**, **98.84% API**, **99.18% auth**. Lint, typecheck, build and source/test formatting pass.
- Runtime dependency audit: zero findings. Three moderate development-only Vitest entries remain; no major-version migration or risk suppression was applied.
- Manual desktop-client smoke test confirmed passed by the release owner on 2026-09-10; publication authorized. Automated transport tests do not replace client UI verification.

## [0.6.1] - 2026-08-08

### Fixed
- **Token refresh path recovered for non-JSON 401 responses** (#219) — `parseErrorBody()` now reads the response body once and parses JSON from the captured text, preventing undici's `Body is unusable: Body has already been read` failure that previously blocked 401 refresh handling.
- **Refreshed access token now persists across subsequent client calls** (#219) — after a successful 401 refresh, the client stores the new token for future requests to avoid repeated `401 -> refresh -> retry` cycles.

### Test count
- 748 → **750** (+2 regression tests for #219). Full suite, lint, typecheck, and build pass.

## [0.6.0] - 2026-06-13

### Added
- **Setup wizard supports Codex & GitHub Copilot** — `whoop-ai-mcp setup --client=codex` prints a `codex mcp add` command (registers the server in `~/.codex/config.toml`) and `--client=copilot` prints a `code --add-mcp` command for GitHub Copilot in VS Code. Both reuse the same shell-quoting as the Claude Code path; the interactive prompt now offers all four targets.
- **Shared in-memory cache (`MemoryCache`)** — generic LRU + TTL cache (`src/cache/memory-cache.ts`) backing both MCP resources and read tools. Opt-in per request via `client.get(path, { cache: true, ttlMs })`. TTLs: profile 1 hr, recovery/sleep 5 min, cycle 2 min; date-range collections stay uncached. Cache keys are normalized by path with alphabetically-sorted query params (no tokens in keys), concurrent identical requests are de-duplicated (stampede prevention), and the whole cache is cleared on token refresh. `get_today` now serves from the same cache, so a warm cache makes zero API calls.
- **Write-safety preview pattern (`withPreview`)** — future-ready two-phase preview/confirm utility (`src/tools/write-safety.ts`) with `WritePreview<P>`, `WriteReceipt<R>`, and `WriteResult<P, R>` types. `confirm: false` returns a preview with a generated UUID v4 `idempotency_key`; `confirm: true` executes the write and echoes the same key for safe retries. No write tools are registered (WHOOP exposes no public write endpoints yet).

### Changed
- **Removed legacy `ResourceCache`** — resources now delegate caching to the shared `MemoryCache` via the API client. `registerResources` and `createWhoopServer` no longer return a cache handle.

### Test count
- 716 → **748** (+32). MemoryCache 97.75% / write-safety 100% line coverage. Lint, typecheck, build clean.

## [0.5.2] - 2026-06-03

### Security
- **OAuth `openBrowser` URL scheme validation** (#151) — reject non-HTTP(S) URL schemes (`javascript:`, `file:`, `vbscript:`, malformed URLs) BEFORE spawning the child process. Defense-in-depth; the URL is constructed from constants today.
- **OAuth callback `Referrer-Policy: no-referrer`** (#110) — added to all callback HTML responses so the auth code in the callback URL cannot leak via Referer. All four HTML response paths now flow through a single `HTML_RESPONSE_HEADERS` constant.
- **Token refresh error differentiation** (#111) — `refreshAccessToken` now wraps fetch in try/catch and raises `WhoopNetworkError` on transport failures; `authenticate`'s refresh catch block rethrows network errors so callers can retry instead of forcing the user through a full re-auth on transient DNS/connection issues.
- **Windows `cmd /c start` title guard** (#109) — verified the empty `""` title placeholder is in place; added a platform=win32 unit test to lock it in.

### Changed
- **BREAKING: `get_calendar` removes `workout_count` field** (#156) — the field was hard-coded to `0` (no implementation path that wouldn't add a workout API fetch). Removed from `CalendarDay` for honesty over backwards compatibility. No in-repo callers consumed it.
- **`get_calendar.start` is now the grid origin** (#154) — when provided, the grid iterates FORWARD from `start` for `days` days, clamped to today (no future days). Previously `start` only filtered the API query while the displayed grid stayed anchored at today. `period.start` in the response now equals the provided `start`.
- **YYYY-MM date inputs reject years outside 2010–2099** (#158) — typos like `0226-05` previously parsed as year 226 and returned empty WHOOP data. Now throws `InvalidDateExpression` with a clear message.
- **`get_calendar` throttles inter-page delay for large ranges** (#152) — `numDays > 30` now uses `interPageDelayMs=100` across all three paginated streams (recovery/sleep/cycle); `numDays ≤ 30` retains `0` (unchanged hot path). Mitigates 429 risk on 90-day requests.
- **`compare_periods` schema-level ISO 8601 validation** (#153) — all four date params now use a shared `isoDateString` schema with a clear error message instead of bare `z.string()`. Centralized `ISO_8601_REGEX` export from `src/tools/date-utils.ts`.

### Added
- **End-to-end MCP integration test over HTTP transport** (#161) — new `tests/transport/http.integration.test.ts` exercises `initialize` → `tools/list` → `tools/call get_profile` through the real SDK `StreamableHTTPClientTransport` ↔ `StreamableHTTPServerTransport` pair, with WHOOP API mocked at `globalThis.fetch`.
- **HTTP transport regression test** (#159) — verifies `activeConnections` counter cannot drift negative under repeated malformed JSON bodies; the malformed-JSON catch block now has an inline comment locking in the `res.on('close')` ownership invariant.
- **README privacy notes for analytical tools** (#99) — documents that `get_weekly_summary`, `get_trend`, and `compare_periods` return concentrated summaries derived from underlying records, with the `anomalies` array flagging deviations from your personal baseline. No new data exposure vs the per-record collection tools.
- **V3 platform spec audit pass** — `docs/specs/v3-platform-enhancements.md` revised with revision log, WHOOP API rate-limit assumptions section (#149), and tradeoffs / open decisions section (TD-1 webhook vs read-only #128, TD-2 self-issued JWT vs SDK ProxyOAuthServerProvider #150). 24 other spec-review issues verified already encoded.

### Test count
- 691 → **716** (+25 across 35 test files). Lint, typecheck, build clean.

## [0.5.1] - 2026-06-03

### Added
- **Setup wizard credential precedence** — `npx whoop-ai-mcp setup` now resolves WHOOP credentials from (1) `--client-id` / `--client-secret` flags, then (2) an existing `whoop` entry in the target Claude Desktop config (no rewrite, no `.bak`), then (3) `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` env vars, then (4) interactive prompts. With `--verify` and an existing config the wizard runs OAuth + profile fetch against the stored creds and prints `Existing config verified — no changes made` without touching the file.

## [0.5.0] - 2026-06-03

### Added
- **HTTP transport** — new `MCP_TRANSPORT=http` (or `both`) mode powered by the SDK's `StreamableHTTPServerTransport`. Bearer-auth via `MCP_AUTH_TOKEN`, `/health` endpoint with optional upstream WHOOP API status (`whoopApi: "ok"|"error"|"unknown"`), CORS via `MCP_ALLOWED_ORIGINS`, per-IP `/mcp` rate limit (default 100 req/60 s), SSE periodic re-validation (default 5 min), `MCP_TRUST_PROXY=1` for `X-Forwarded-For` parsing behind reverse proxies, and graceful SIGTERM/SIGINT shutdown.
- **OAuth 2.1 connector** — claude.ai web/mobile can now connect via PKCE S256. Set `MCP_CONNECTOR_PASSWORD` (≥12 chars) + `PUBLIC_URL` + `ALLOWED_REDIRECT_URIS` and the connector mounts on the same HTTP port. JWT signing key derived via HKDF from `MCP_AUTH_TOKEN` (or override with `MCP_JWT_SECRET`).
- **Docker image** — multi-stage `node:22-alpine` Dockerfile, runs as non-root, tini PID 1, native-fetch healthcheck. **58 MB compressed** (registry pull). Fly.io and Railway deployment guides in README.
- **CLI setup wizard** — `npx whoop-ai-mcp setup` walks through credential entry, writes/merges Claude Desktop config (with atomic `.bak` backup), or prints the equivalent `claude mcp add` command for Claude Code. Optional `--verify` flag runs OAuth + profile fetch end-to-end. Zero new runtime deps.
- **Structured logging** — JSON-lines logger to stderr with `LOG_LEVEL` (`debug`/`info`/`warn`/`error`) and `LOG_FORMAT` (`json`/`pretty`). Request correlation IDs flow through the WHOOP API client; 429s log at `warn` with `retryAfterMs`, timeouts at `error`, token refreshes at `info`, successes at `debug` with `durationMs`.
- **Hardening** — OAuth callback responses now include `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`. `openBrowser` uses `spawn` with arg arrays (no shell injection) and handles async error events gracefully in headless containers.

### Changed
- Test count: 502 → **687** (34 test files; coverage on new code: `src/cli` 90.93%, `src/logging` 100%, `src/transport` 94.63%).
- Node engine bumped to **>=20.0.0** (was >=18) — required for `AbortSignal.timeout` and modern `fetch` semantics.
- `src/index.ts` refactored to dispatch on `MCP_TRANSPORT` (`stdio` | `http` | `both`); the legacy stdio-only path is preserved as the default for backward compatibility.

## [0.4.0] - 2026-05-31

### Added
- **`get_today` composite tool** — single call returns today's recovery, last night's sleep, current strain, and last workout with a human-readable summary. Uses `Promise.allSettled` for parallel-with-partial-failure.
- **`get_calendar` grid tool** — day-by-day view of recovery scores, sleep hours, and strain for 1–90 day ranges. Includes recovery zones (green/yellow/red), averages, and sleep alignment to wake-up day.
- **6 new date expressions** — `"last N weeks"` (1–52), `"last N months"` (1–12), `"this quarter"`, `"last quarter"`, `"last year"`, and `"YYYY-MM"` month literals. All case-insensitive with proper edge case handling (Feb overflow, year wrap).

### Changed
- Tool count: 12 → 14
- Test count: 466 → 502
- All collection tools now accept the extended date expressions

## [0.3.1] - 2026-05-30

### Fixed
- Hardened OAuth callback responses with security headers (`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`).
- Hardened Windows browser launch by adding the `start "" <url>` title guard in `openBrowser()`.

## [0.3.0] - 2026-05-29

### Added
- **3 Analytical Tools** — `get_weekly_summary`, `compare_periods`, `get_trend` for pre-computed health insights
- **3 Individual Record Lookup Tools** — `get_sleep_by_id`, `get_workout_by_id`, `get_cycle_by_id`
- **4 MCP Resources** — ambient health context (`whoop://v2/user/recovery/latest`, sleep, cycle, profile) with in-memory cache and TTL
- **5 MCP Prompts** — guided conversation starters (`weekly_health_review`, `sleep_analysis`, `recovery_trend`, `workout_recap`, `health_check`)
- **Auto-pagination utility** — `fetchAllPages` with safety caps (500 records, 20 pages max, inter-page delay)
- **Enhanced date handling** — all collection tools accept relative expressions ("today", "last 7 days", "this week", "last month")
- **Statistics utility** — mean, median, std deviation, linear regression, anomaly detection (pure TypeScript, no deps)

### Changed
- Collection tool descriptions updated to document relative date expression support
- Tool count: 6 → 12
- Resource count: 0 → 4
- Prompt count: 0 → 5
- Test count: 217 → 430+

## [0.2.0] - 2026-04-14

### Fixed
- **OAuth refresh tokens now work** — added `offline` scope to OAuth authorization request, enabling persistent refresh tokens across sessions (thanks [@efdavis](https://github.com/efdavis) — PR #34)
- **Tokens persist across Claude Desktop restarts** — fixed token storage so cached tokens survive server restarts without re-authentication
- **Hardened token validation** — improved shape validation for stored tokens and redacted file paths in log messages to avoid leaking usernames
- **Dropped Node 18.x from CI** — Node 18 reached EOL; CI now tests on Node 20 and 22
- **Fixed IPv6 test failures** — callback server tests now work correctly in IPv6 environments

### Changed
- Formatted all source and test files with Prettier (style-only, no behavior changes)
- 217 tests passing (up from 212)

### Added
- Security audit report #2 (`docs/security-audits/security-audit-2.md`)
- "Get a WHOOP" section in README with referral links

## [0.1.2] - 2026-04-12

### Added
- `SECURITY.md` — vulnerability reporting process, OAuth/token/API security design, known limitations
- `CODE_OF_CONDUCT.md` — Contributor Covenant v2.1
- `.github/workflows/ci.yml` — GitHub Actions CI pipeline (typecheck, lint, test, coverage, build) on Node 18/20/22

## [0.1.1] - 2026-04-12

### Changed
- Added Claude Desktop integration screenshots to README (server connected + live chat)
- Added MCP Inspector testing screenshots to README (OAuth grant flow + `get_profile` result)

## [0.1.0] - 2026-04-12

### Added

- **MCP server** with stdio transport for Claude Desktop and other MCP-compatible clients
- **OAuth2 Authorization Code flow** — browser-based authentication with automatic token refresh
- **Secure token storage** at `~/.whoop-mcp/tokens.json` with `0600` file permissions
- **6 MCP tools** for querying WHOOP health and fitness data:
  - `get_profile` — user's basic profile (name, email)
  - `get_body_measurement` — height, weight, max heart rate
  - `get_recovery_collection` — HRV, resting heart rate, SpO2, skin temp
  - `get_sleep_collection` — sleep stages, duration, respiratory rate
  - `get_workout_collection` — strain, heart rate zones, calories, sport type
  - `get_cycle_collection` — physiological cycles with strain and calorie data
- **Resilient error handling:**
  - Automatic retry with exponential backoff for rate limits (429)
  - Automatic token refresh on auth failures (401)
  - Clear, user-friendly messages for network errors
  - MCP-formatted error responses (tools never crash the server)
- **CLI entry point** — `npx whoop-mcp` with environment variable configuration
- **202 tests** with full coverage of auth, API client, tools, and error handling

[Unreleased]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.5.2...v0.6.0
[0.2.0]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.1.1...v0.2.0
[0.1.2]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/shashankswe2020-ux/whoop-mcp/releases/tag/v0.1.0
