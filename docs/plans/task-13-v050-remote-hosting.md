# Task 13: v0.5.0 — Remote Hosting (HTTP Transport, OAuth, Docker, CLI, Observability)

> **Spec:** `docs/specs/v3-platform-enhancements.md` (Features 4–6, Observability)
> **Depends on:** Task 12 complete (v0.4.0 shipped)
> **Created:** 2026-05-31

---

## Overview

Transform the server from local-only (stdio) to remotely accessible (HTTP + OAuth). This is the highest-complexity release — it introduces a new transport layer, security-critical OAuth connector, structured logging, Docker packaging, and guided setup CLI. The server becomes deployable to Fly.io/Railway and accessible from claude.ai web/mobile.

## Architecture Decisions

1. **Use SDK's `StreamableHTTPServerTransport` directly** — No custom HTTP server framework. SDK bundles Express 5 as a transitive dep; we use it for middleware (auth, rate limiting) but the transport itself is SDK-managed.

2. **Implement `OAuthServerProvider` interface from SDK** — Not hand-rolled OAuth. SDK's `mcpAuthRouter()` provides battle-tested metadata endpoints, PKCE validation, and token exchange. We implement the provider interface (storage + password verification).

3. **JWT signing via HKDF derivation** — Never use `MCP_AUTH_TOKEN` directly as JWT signing material. Derive a separate key using HKDF with a domain-specific salt. If `MCP_JWT_SECRET` is explicitly set, use that instead.

4. **SHA-256 hash comparison for bearer tokens** — Hash both provided and expected tokens before `timingSafeEqual`. This prevents length oracle attacks and ensures constant-time comparison regardless of token length.

5. **Observability is a foundational layer, not an afterthought** — Logger implemented immediately after HTTP transport (task 13b) since all subsequent tasks need request correlation IDs. JSON lines to stderr; `LOG_FORMAT=pretty` for local dev.

6. **`MCP_TRANSPORT=both` is a first-class mode** — Allows simultaneous stdio (Claude Desktop) and HTTP (claude.ai web) connections to the same server process.

7. **CLI uses `readline` only** — No new runtime dependencies. Config backup (`.bak`) before modification; auto-restore on merge failure.

---

## Dependency Graph

```
┌─────────────────────────────────┐
│ 13a. HTTP transport + auth      │  ← Foundation (no deps)
│      middleware                  │
└───────────────┬─────────────────┘
                │
┌───────────────▼─────────────────┐
│ 13b. Structured logging         │  ← Needs requestId from transport
└───────────────┬─────────────────┘
                │
┌───────────────▼─────────────────┐
│ 13c. OAuth 2.1 connector        │  ← Needs HTTP transport + logging
│      (OAuthServerProvider)       │
└───────────────┬─────────────────┘
                │
    ┌───────────┼───────────────────┐
    │           │                   │
┌───▼───┐  ┌───▼────────────┐  ┌───▼──────────────┐
│ 13d.  │  │ 13e. Docker +  │  │ 13f. CLI setup   │
│ Index │  │ deployment     │  │ wizard           │
│ update│  │                │  │                  │
└───────┘  └────────────────┘  └──────────────────┘
    │           │                   │
    └───────────┼───────────────────┘
                │
    ┌───────────▼───────────────────┐
    │ 13g. Full verification        │
    └───────────────────────────────┘
```

**Parallelism:** Tasks 13d, 13e, and 13f can be implemented in parallel after 13c.

---

## Task List

### Task 13a: HTTP Transport + Auth Middleware

**Description:** Add `StreamableHTTPServerTransport` support. Server starts an HTTP server when `MCP_TRANSPORT=http` or `both`. All `/mcp` routes require bearer token authentication with SHA-256 hash comparison.

> **Note from review:** This task is at the upper boundary of "Large". If any single area blocks (e.g., SDK transport API surprises), implement in two PRs: (1) transport + health check, (2) auth middleware + both mode.

**Acceptance criteria:**
- [ ] `MCP_TRANSPORT=http` starts Express server on `MCP_PORT` (default 3000)
- [ ] `MCP_TRANSPORT=both` starts HTTP AND accepts stdio simultaneously
- [ ] `MCP_TRANSPORT=stdio` (default) behaves exactly as before
- [ ] Bearer token required on all `/mcp` routes — 401 without it
- [ ] Token comparison uses SHA-256 hash (no length oracle)
- [ ] `safeTokenCompare()` exported and tested independently
- [ ] `/health` returns `{ status: "ok" }` for unauthenticated requests (no backend details)
- [ ] `/health` with valid bearer returns full `HealthResponse` (uptime, WHOOP API status)
- [ ] Missing `MCP_AUTH_TOKEN` when `MCP_TRANSPORT=http|both` → startup error
- [ ] Max 5 concurrent connections (global); connection N+1 gets `503 Service Unavailable`
- [ ] Graceful shutdown: SIGTERM → drain connections → exit
- [ ] All 14 tools + 4 resources + 5 prompts work identically over HTTP
- [ ] Express `trust proxy` set to `1` (correct IP behind Fly/Railway reverse proxy)
- [ ] CORS restricted to origins from `ALLOWED_REDIRECT_URIS` + `PUBLIC_URL`; default deny
- [ ] Port uses `0` in tests (dynamic assignment, no flaky CI)

**Verification:** `npm test -- tests/transport/http.test.ts`

**Dependencies:** None

**Files:**
- `src/transport/http.ts` (create — Express app, auth middleware, transport setup)
- `src/transport/stdio.ts` (create — extract from current `index.ts`)
- `tests/transport/http.test.ts` (create)

**Estimated scope:** Large (3 new files, `index.ts` refactored)

---

### Task 13b: Structured Logging

**Description:** Implement the structured logger (`src/logging/logger.ts`) with JSON output to stderr, log level filtering, and request correlation IDs.

**Acceptance criteria:**
- [ ] All logs are structured JSON to stderr (not stdout)
- [ ] `LogEntry` interface: `ts`, `level`, `msg`, `requestId?`, `tool?`, `durationMs?`, `error?`
- [ ] `LOG_LEVEL` env var controls verbosity (default: `info`)
- [ ] `LOG_FORMAT=pretty` outputs: `[2026-05-31T14:02:33Z] INFO  msg {key=val, ...}`
- [ ] `LOG_FORMAT=json` (default) outputs JSON lines
- [ ] `createRequestLogger(requestId)` returns scoped logger instance
- [ ] No tokens, secrets, or PII in log output (redaction by design)
- [ ] Zero runtime dependencies (just `JSON.stringify` + `process.stderr`)

**Verification:** `npm test -- tests/logging/logger.test.ts`

**Dependencies:** Task 13a (requestId concept from transport layer)

**Files:**
- `src/logging/logger.ts` (create)
- `tests/logging/logger.test.ts` (create)

**Estimated scope:** Small (2 new files)

---

### Task 13c: OAuth 2.1 Connector (OAuthServerProvider)

**Description:** Implement the SDK's `OAuthServerProvider` interface for claude.ai web/mobile connectivity. Includes PKCE S256, state parameter, auth code storage, JWT signing with HKDF derivation, rate limiting, and redirect_uri validation.

**Acceptance criteria:**
- [ ] Implements `OAuthServerProvider` interface from SDK
- [ ] `mcpAuthRouter()` mounted at app root
- [ ] OAuth 2.1 metadata at `/.well-known/oauth-authorization-server`
- [ ] PKCE S256 enforced — plain PKCE rejected
- [ ] `state` parameter required and echoed verbatim
- [ ] Auth codes: one-time use, 60-second expiry, consumed flag
- [ ] Auth codes generated with `crypto.randomBytes(32)` — 256-bit entropy
- [ ] `redirect_uri` exact string match against `ALLOWED_REDIRECT_URIS`
- [ ] `redirect_uri` checked on BOTH `/authorize` AND `/token`
- [ ] JWT signed with HKDF-derived key (not bearer token directly)
- [ ] `MCP_JWT_SECRET` overrides HKDF derivation if set
- [ ] Access tokens: 24h expiry. Refresh tokens: 30d expiry.
- [ ] Rate limits: `/authorize` 3/min, `/token` 10/min, `/mcp` 100/min
- [ ] `MCP_CONNECTOR_PASSWORD` < 12 chars → startup error
- [ ] `PUBLIC_URL` must start with `https://` — reject at startup otherwise
- [ ] SSE connections validate token every 5 min, close if invalid
- [ ] Periodic cleanup of expired auth codes
- [ ] Verify `express-rate-limit` in `node_modules`; if missing, implement `MapRateLimiter`
- [ ] Integration test: full authorize → callback → token exchange → tool call sequence

**Verification:** `npm test -- tests/transport/oauth-connector.test.ts`

**Dependencies:** Task 13a (HTTP transport), Task 13b (logging for auth events)

**Files:**
- `src/transport/oauth-connector.ts` (create)
- `tests/transport/oauth-connector.test.ts` (create)

**Estimated scope:** Large (complex security logic, many edge cases)

---

### Task 13d: Entry Point Refactor

**Description:** Refactor `src/index.ts` to support transport selection via `MCP_TRANSPORT` env var. Wire up logging, integrate OAuth connector when configured.

**Acceptance criteria:**
- [ ] `MCP_TRANSPORT` parsed: `stdio` | `http` | `both`
- [ ] Existing `tests/index.test.ts` passes WITHOUT modification first (no-regression proof)
- [ ] `stdio` mode unchanged from current behavior
- [ ] `http` mode starts HTTP server only (no stdin reading)
- [ ] `both` mode starts HTTP server AND stdio transport
- [ ] Logger initialized at startup, requestId assigned per request
- [ ] WHOOP API calls logged at `debug` level with requestId + durationMs
- [ ] 429 responses logged at `warn`, timeouts at `error`
- [ ] `/health` returns structured `HealthResponse` (status, uptime, WHOOP API health)
- [ ] Token refresh logged at `info`
- [ ] Startup logs: transport mode, port (if HTTP), configured features

**Verification:** `npm test -- tests/index.test.ts`

**Dependencies:** Tasks 13a, 13b, 13c

**Files:**
- `src/index.ts` (modify — transport selection + logging wiring)
- `tests/index.test.ts` (modify — add transport mode tests)

**Estimated scope:** Medium (1 file heavily refactored)

---

### Task 13e: Docker + Cloud Deployment

**Description:** Create production-ready Dockerfile (multi-stage, < 100MB, non-root) and deployment guides.

**Acceptance criteria:**
- [ ] Multi-stage Dockerfile produces < 100MB image
- [ ] Runs as non-root (`USER node`)
- [ ] Health check uses `node -e "fetch(...)"` (no wget/curl)
- [ ] All env vars configurable at runtime (not baked in)
- [ ] No secrets in image layers
- [ ] `docker build` succeeds from clean clone
- [ ] `.dockerignore` excludes: `node_modules/`, `tests/`, `.git/`, `*.md`, `docs/`
- [ ] README includes Fly.io + Railway deployment instructions

**Verification:** `docker build -t whoop-mcp . && docker run --rm whoop-mcp node -e "console.log('ok')"`

**Dependencies:** Task 13a (HTTP transport must exist for health check)

**Files:**
- `Dockerfile` (create)
- `.dockerignore` (create)
- `README.md` (modify — deployment section)

**Estimated scope:** Small (2 new files + README update)

---

### Task 13f: Guided CLI Setup Wizard

**Description:** Interactive `whoop-ai-mcp setup` command using Node's `readline`. Walks through credential input, OAuth verification, and MCP client config generation.

**Acceptance criteria:**
- [ ] `whoop-ai-mcp setup` starts interactive wizard
- [ ] Secrets masked during input (no echo to terminal)
- [ ] Creates `.bak` backup of existing config before modification
- [ ] If merge fails, original config restored from backup
- [ ] Claude Desktop config merged (not overwritten) — preserves other MCPs
- [ ] Claude Code prints correct `claude mcp add` command
- [ ] `--verify` performs OAuth + profile fetch
- [ ] Non-interactive mode: `--client-id=X --client-secret=Y --client=claude-desktop`
- [ ] Fails gracefully if credentials are wrong
- [ ] No new runtime dependencies

**Verification:** `npm test -- tests/cli/setup.test.ts`

**Dependencies:** None (independent of transport work)

**Files:**
- `src/cli/setup.ts` (create)
- `src/cli/config-generators.ts` (create)
- `tests/cli/setup.test.ts` (create)

**Estimated scope:** Medium (3 new files)

---

### Task 13g: Full Verification

**Description:** Complete verification checkpoint — all tests, typecheck, build, lint, Docker build, manual HTTP transport test.

**Acceptance criteria:**
- [ ] All tests pass (`npm test`)
- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] Build succeeds (`npm run build`)
- [ ] Lint clean (`npm run lint`)
- [ ] Docker image builds and starts successfully
- [ ] HTTP transport accepts tool calls with bearer token
- [ ] OAuth flow completes with test client
- [ ] Stdio transport still works (no regression)
- [ ] `/health` returns structured response
- [ ] Logs appear as JSON on stderr
- [ ] `whoop-ai-mcp setup --verify` works with valid credentials

**Verification:** `npm test && npm run typecheck && npm run build && npm run lint`

**Dependencies:** Tasks 13a–13f

**Files:** None (verification only)

---

## Checkpoint: After Task 13g

- [ ] All tests pass
- [ ] HTTP transport works with bearer auth
- [ ] OAuth connector passes PKCE + state + redirect_uri validation
- [ ] Docker image < 100MB, non-root
- [ ] CLI setup wizard functional
- [ ] Structured logging to stderr with request correlation
- [ ] `/health` returns WHOOP API health status
- [ ] Transport modes: stdio, http, both — all functional
- [ ] No regression in existing stdio-mode behavior
- [ ] Coverage: ≥ 90% on new `src/transport/`, `src/logging/`, `src/cli/`

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| SDK's `StreamableHTTPServerTransport` API changes | High | Pin SDK version; test against exact API shape early (task 13a) |
| `express-rate-limit` not actually in SDK transitive deps | Medium | Verify in `node_modules` before starting 13c; fallback: simple Map-based counter with same interface |
| OAuth connector security flaw | High | Security audit after 13c; test all OWASP OAuth threats |
| Docker image > 100MB | Low | Use `node:20-slim`, exclude devDeps, verify in CI |
| `readline` masking doesn't work on Windows | Low | Document Windows limitation; passwords still work, just visible |
| Stdio + HTTP race condition in "both" mode | Medium | Each transport gets its own MCP server instance sharing the same WHOOP client |
| Shared WHOOP client rate budget across transports | Medium | Document as known limitation for v0.5; global budget deferred to v0.8 |
| IP spoofing bypasses rate limits behind proxy | Medium | `trust proxy = 1`; document for multi-proxy setups |

---

## Files Delivered

| File | Action | Description |
|------|--------|-------------|
| `src/transport/http.ts` | Create | Express app + auth middleware + StreamableHTTP |
| `src/transport/stdio.ts` | Create | Extracted stdio setup |
| `src/transport/oauth-connector.ts` | Create | OAuthServerProvider implementation |
| `src/logging/logger.ts` | Create | Structured JSON logger |
| `src/cli/setup.ts` | Create | Interactive setup wizard |
| `src/cli/config-generators.ts` | Create | Config file generation |
| `src/index.ts` | Modify | Transport selection + logging wiring |
| `Dockerfile` | Create | Multi-stage production image |
| `.dockerignore` | Create | Exclude non-prod files |
| `README.md` | Modify | Deployment guides |
| `tests/transport/http.test.ts` | Create | Auth, rate limits, length oracle |
| `tests/transport/oauth-connector.test.ts` | Create | Full OAuth flow tests |
| `tests/logging/logger.test.ts` | Create | Format, levels, redaction |
| `tests/cli/setup.test.ts` | Create | Config gen + backup/restore |
| `tests/index.test.ts` | Modify | Transport mode tests |
