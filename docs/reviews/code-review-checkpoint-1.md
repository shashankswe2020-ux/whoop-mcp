# Code Review Checkpoint 1: Tasks 1–5

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-04-11
> **Scope:** Tasks 1–5 (Scaffold, API Types, Token Store, API Client, OAuth Flow)
> **Commit range:** `bd196ce` → `7a3e7fe`
> **Test suite:** 114 tests passing (7 files), typecheck clean, build clean, lint clean

---

## Verdict: ✅ APPROVE

**Overview:** Tasks 1–5 deliver a clean, well-structured foundation for the WHOOP MCP server. The code is consistent, idiomatic TypeScript with excellent test coverage, disciplined incremental commits, and a clear architectural separation between auth, API client, and token storage. The codebase is in strong shape for the next phase (tool implementations).

---

## Critical Issues

None.

---

## Important Issues

### 1. Callback server tests use random port range — flaky in CI

- **File:** `tests/auth/callback-server.test.ts:17`
- **Problem:** Tests use `49152 + Math.floor(Math.random() * 1000)` for port selection. This is a 1000-port range — in CI with parallel test runs, collisions can cause flaky failures.
- **Fix:** Use port `0` (OS-assigned) and extract the actual port from the listening server. Requires `startCallbackServer` to expose the resolved port.

### 2. Refresh failure silently swallowed in `authenticate()`

- **File:** `src/auth/oauth.ts:253`
- **Problem:** The `catch` block catches *all* errors from the refresh attempt (including network errors, malformed responses) and silently falls through to full OAuth. A network timeout during refresh shouldn't trigger a full re-auth.
- **Fix:** Catch only expected refresh failures (e.g., 401) and rethrow unexpected errors. Or at minimum log to `console.error`:
  ```typescript
  } catch (error) {
    console.error("Token refresh failed, starting full OAuth flow:", error);
  }
  ```

### 3. `openBrowser` has a shell injection vector

- **File:** `src/auth/oauth.ts:186`
- **Problem:** `exec(\`open "${url}"\`)` — if the URL contained double quotes or shell metacharacters, this would be exploitable. Risk is low (URL is constructed from constants + config) but violates defense-in-depth.
- **Fix:** Use `execFile` or `spawn` with argument arrays to avoid shell interpretation:
  ```typescript
  import { spawn } from "node:child_process";
  spawn("open", [url], { detached: true, stdio: "ignore" });
  ```

### 4. No request timeout on API client

- **File:** `src/api/client.ts`
- **Problem:** The `fetch` call has no `AbortSignal` / timeout. A slow or hung WHOOP API response blocks the MCP server indefinitely — critical since it runs inside Claude Desktop's process.
- **Fix:** Add `AbortSignal.timeout(30_000)` to fetch options. Can be deferred to Task 8 (Error Handling) if tracked.

### 5. Coverage dependency missing

- **File:** `vitest.config.ts` / `package.json`
- **Problem:** `@vitest/coverage-v8` is configured in vitest but not installed. `npm test -- --coverage` fails.
- **Fix:** `npm install -D @vitest/coverage-v8`

---

## Suggestions

### 1. `loadTokens` does no shape validation

- **File:** `src/auth/token-store.ts`
- `JSON.parse(raw) as OAuthTokens` trusts the file contents blindly. If the file is valid JSON but wrong shape, runtime errors surface later.
- **Consider:** Lightweight Zod validation or manual field check. Low priority — only this app writes the file.

### 2. Mixed ID types in Recovery type deserve a comment

- **File:** `src/api/types.ts`
- `Recovery.sleep_id` is `string` but `Recovery.cycle_id` is `number`. Matches WHOOP API, but a JSDoc comment would prevent future "fix" attempts.

### 3. Double-call pattern in error tests

- **File:** `tests/api/client.test.ts:159-171`
- Some error tests call `client.get()` twice — once via `rejects.toThrow()` and again in try/catch. This sends 2 fetch requests. Pick one assertion style.

### 4. No `server.on('error')` handler in callback server

- **File:** `src/auth/callback-server.ts`
- If port 3000 is in use, `server.listen(port)` emits an `'error'` event but nothing catches it. The promise hangs until timeout.
- **Consider:** Add `server.on('error', reject)` before `server.listen(port)`.

### 5. Placeholder scaffold test can be removed

- **File:** `tests/scaffold.test.ts`
- Useful during Task 1, but now there are 114 real tests. It adds no value.

---

## What's Done Well

- **Exemplary incremental commits.** Git log shows disciplined TDD cadence: type → test → implementation → verify. Each commit is a focused slice. History is easy to bisect.

- **Excellent separation of concerns.** `token-store.ts` is pure I/O, `callback-server.ts` handles only HTTP, `oauth.ts` orchestrates without implementing transport or storage. Single responsibility throughout.

- **Strong test quality.** Tests cover happy paths, edge cases (boundary expiry, malformed JSON, missing files, state mismatch), and error paths (401, 429, 500, network errors, timeout). Callback server tests verify shutdown after errors — a detail most skip.

- **Consistent naming conventions.** `kebab-case` files, `PascalCase` types, `SCREAMING_SNAKE_CASE` constants, `camelCase` functions. Zero deviations.

- **Security-conscious token storage.** `0700` directory, `0600` file permissions, tested. `.gitignore` excludes `tokens.json`, `.env`. No secrets in the codebase.

- **Clean TypeScript.** Strict mode, zero `any`, explicit return types, `noUncheckedIndexedAccess` enabled. One of the strictest `tsconfig.json` configurations.

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | All 7 test files (114 tests). Well-structured mocks, happy + error paths |
| Build verified | ✅ | `typecheck`, `build`, `lint` all pass |
| Security checked | ✅ | Token permissions, no secrets, `.gitignore` coverage. One shell injection concern (Important #3) |
| Coverage | ⚠️ | `@vitest/coverage-v8` not installed — cannot quantify. Qualitative review suggests >80% on auth/api modules |

---

## Action Items

| # | Priority | Issue | Owner | Target Task |
|---|----------|-------|-------|-------------|
| 1 | Important | Add `console.error` to refresh catch block | — | Hotfix or Task 8 |
| 2 | Important | Replace `exec` with `spawn` in `openBrowser` | — | Hotfix |
| 3 | Important | Add `AbortSignal.timeout` to API client fetch | — | Task 8 |
| 4 | Important | Install `@vitest/coverage-v8` | — | Hotfix |
| 5 | Important | Add `server.on('error')` to callback server | — | Hotfix or Task 8 |
| 6 | Suggestion | Validate token shape in `loadTokens` | — | Backlog |
| 7 | Suggestion | Remove `scaffold.test.ts` | — | Next commit |
