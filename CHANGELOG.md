# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.1.1...v0.2.0
[0.1.2]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/shashankswe2020-ux/whoop-mcp/releases/tag/v0.1.0
