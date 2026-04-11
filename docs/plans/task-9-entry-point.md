# Task 9: Entry Point + CLI

> **Spec:** `docs/specs/whoop-mcp-server.md`
> **Depends on:** Tasks 1–8 (all complete, 188 tests passing)
> **Status:** ✅ Complete (committed `f61239e`)
> **Created:** 2026-04-12

---

## Overview

Wire everything together in `src/index.ts` — read OAuth credentials from environment variables, authenticate with WHOOP, create the API client with automatic token refresh, build the MCP server, and connect it to stdio transport. This is the last code task before docs + publish.

## Architecture Decisions

1. **Environment variables for credentials, not config files** — `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` are read from `process.env`. This matches Claude Desktop's `env` config pattern and avoids an extra config file.

2. **`getRequiredEnv()` helper with actionable errors** — Missing env vars throw immediately with a message that tells the user *where* to set them (Claude Desktop config or shell env) and links to the README.

3. **`onTokenRefresh` reads stored tokens from disk** — The callback doesn't capture the initial refresh token in a closure. Instead, it calls `loadTokens()` each time, ensuring it always uses the latest refresh token (in case it was rotated by a previous refresh).

4. **`import.meta.url` guard for auto-execution** — The module-level `main().catch(…)` only runs when the file is executed directly (`node dist/index.js`), not when imported in tests. This avoids unhandled rejection errors in the Vitest process.

5. **All logging to stderr** — `console.error()` for all human-readable output. `stdout` is exclusively the MCP stdio channel. If any code accidentally writes to `stdout`, the MCP protocol would break.

6. **`main()` is exported** — Allows tests to import and call `main()` directly with full control over mocks, without needing to spawn a child process.

## Dependency Graph (Subtasks)

```
9.1 (env vars)
  └──▶ 9.2 (authenticate)
         └──▶ 9.3 (client + onTokenRefresh)
                └──▶ 9.4 (server + stdio)
                       └──▶ 9.5 (error handling)

9.6 (tests) — written incrementally with each subtask
9.7 (build verification) — after all subtasks complete
```

## Task List

### Task 9.1: Environment Variable Validation

**Description:** Read `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` from `process.env` with clear error messages on missing values.

**Acceptance criteria:**
- [x] `getRequiredEnv(name)` helper reads from `process.env`, throws if missing/empty
- [x] Error message includes the variable name, where to set it, and a docs link
- [x] Missing `WHOOP_CLIENT_ID` → descriptive error
- [x] Missing `WHOOP_CLIENT_SECRET` → descriptive error

**Files:** `src/index.ts`

**Verification:** `npm test -- tests/index.test.ts`

**Estimated scope:** XS

---

### Task 9.2: Authentication Call

**Description:** Call `authenticate({ clientId, clientSecret })` to get a valid access token.

**Acceptance criteria:**
- [x] Builds `OAuthConfig` from env vars
- [x] Calls `authenticate(config)` → returns valid `accessToken`
- [x] Logs "Authenticating with WHOOP..." and "Authentication successful." to stderr
- [x] Auth errors propagate to `main()`'s catch handler

**Files:** `src/index.ts`

**Verification:** `npm test -- tests/index.test.ts`

**Estimated scope:** XS

---

### Task 9.3: WHOOP Client Creation with Token Refresh

**Description:** Create a `WhoopClient` with an `onTokenRefresh` callback that refreshes and persists tokens.

**Acceptance criteria:**
- [x] `onTokenRefresh` calls `loadTokens()` to get current refresh token from disk
- [x] Calls `refreshAccessToken(refreshToken, oauthConfig)` for new tokens
- [x] Calls `toOAuthTokens()` + `saveTokens()` to persist refreshed tokens
- [x] Returns new `access_token`
- [x] Throws clear error if `loadTokens()` returns `null` (no stored tokens)
- [x] Client created via `createWhoopClient({ accessToken, onTokenRefresh })`

**Files:** `src/index.ts`

**Verification:** `npm test -- tests/index.test.ts`

**Estimated scope:** S

---

### Task 9.4: MCP Server + Stdio Transport

**Description:** Create the MCP server and connect it to `StdioServerTransport`.

**Acceptance criteria:**
- [x] Calls `createWhoopServer(client)` → `McpServer`
- [x] Creates `new StdioServerTransport()` from SDK
- [x] Calls `await server.connect(transport)`
- [x] Logs "WHOOP MCP server started on stdio." to stderr after connection

**Files:** `src/index.ts`

**Verification:** `npm test -- tests/index.test.ts`

**Estimated scope:** XS

---

### Task 9.5: Graceful Error Handling + Auto-execution Guard

**Description:** Ensure `main()` catches fatal errors, exits cleanly, and doesn't auto-execute during test imports.

**Acceptance criteria:**
- [x] `main().catch()` logs error to stderr and calls `process.exit(1)`
- [x] Auto-execution guarded by `import.meta.url` check — only runs when file is the entry point
- [x] `main()` exported for direct test invocation
- [x] All error output to stderr, never stdout

**Files:** `src/index.ts`

**Verification:** `npm test -- tests/index.test.ts`

**Estimated scope:** XS

---

### Task 9.6: Integration Tests

**Description:** Write tests for `main()` with all dependencies mocked.

**Acceptance criteria:**
- [x] 14 tests covering all subtasks:
  - 4 env var validation tests (missing/empty for both vars)
  - 2 authentication tests (happy path + error propagation)
  - 2 client creation tests (access token + onTokenRefresh exists)
  - 2 token refresh tests (happy path + no stored tokens)
  - 3 server + transport tests (created, connected)
  - 1 stderr logging test
- [x] All deps mocked via `vi.mock()` — no real OAuth, fetch, or filesystem
- [x] No unhandled rejections from module-level auto-execution

**Files:** `tests/index.test.ts`

**Verification:** `npm test -- tests/index.test.ts`

**Estimated scope:** M

---

### Task 9.7: Build Verification + Smoke Test

**Description:** Full build + manual smoke test.

**Acceptance criteria:**
- [x] `npm run build` succeeds
- [x] `npm run typecheck` clean
- [x] `npm run lint` clean
- [x] `npm test` — 202 tests passing
- [x] `dist/index.js` starts with `#!/usr/bin/env node`
- [x] `node dist/index.js` without env vars → clear "Missing required environment variable" error, exit 1

**Verification:**
```bash
npm run build && npm run typecheck && npm run lint && npm test
node dist/index.js 2>&1 | head -5
```

**Estimated scope:** XS

---

## Checkpoint: Task 9 Complete ✅

All verified on 2026-04-12:

- [x] `npm test` — 202 tests passing (14 new)
- [x] `npm run build` — compiles clean
- [x] `npm run typecheck` — no errors
- [x] `npm run lint` — no warnings
- [x] `node dist/index.js` — clear env var error, exit 1
- [x] `dist/index.js` has shebang `#!/usr/bin/env node`
- [x] Committed: `f61239e`

## Files Delivered

| File | Purpose |
|------|---------|
| `src/index.ts` | Full entry point — env vars → auth → client → server → stdio |
| `tests/index.test.ts` | 14 tests covering all entry point behavior |

## Risk Mitigations Applied

| Risk | Mitigation |
|------|-----------|
| `StdioServerTransport` API change | Verified import path and constructor from SDK type defs |
| Module-level `main()` fires during test import | `import.meta.url` guard prevents auto-execution in tests |
| `onTokenRefresh` captures stale refresh token | Reads from disk via `loadTokens()` each time, not closure |
| Shebang stripped by `tsc` | Verified `dist/index.js` retains `#!/usr/bin/env node` after build |
