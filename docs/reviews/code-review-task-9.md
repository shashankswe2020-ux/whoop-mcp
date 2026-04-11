# Code Review: Task 9 — Entry Point + CLI

> **Reviewer:** Review Agent (Staff Engineer)
> **Date:** 2026-04-12
> **Scope:** Task 9 — `src/index.ts` + `tests/index.test.ts` (commit `f61239e`)
> **Test suite:** 202 tests passing (14 files), typecheck clean, build clean, lint clean

---

## Verdict: ⚠️ CONDITIONAL APPROVE — 1 Critical fix required

**Overview:** Task 9 delivers a clean entry point that wires OAuth → client → server → stdio. The code is well-structured, follows project conventions, and has 14 tests covering all major paths. However, the `isMainModule` guard has a **critical symlink bug** that breaks `npx whoop-mcp` and `npm link` — the primary distribution mechanism. Must fix before Task 10 (publish prep).

---

## Critical Issues

### 1. `isMainModule` guard fails for symlinks — `npx whoop-mcp` silently does nothing

- **File:** `src/index.ts:93-95`
- **Problem:** The guard compares `resolve(process.argv[1])` against `fileURLToPath(import.meta.url)`. When Node.js runs a symlinked binary (as `npx`, `npm link`, and Claude Desktop all do), `argv[1]` is the symlink path (e.g., `/opt/homebrew/bin/whoop-mcp`) while `import.meta.url` resolves to the real file path (`dist/index.js`). They never match, so `main()` never executes. The server silently exits 0 with no output.
- **Reproduced:**
  ```bash
  npm link && whoop-mcp   # exits 0, no output, no error
  ```
- **Impact:** This breaks the primary user-facing invocation: `npx whoop-mcp` and Claude Desktop's `{ "command": "npx", "args": ["whoop-mcp"] }`. The server appears to start but does nothing.
- **Fix:** Use `realpathSync` to resolve symlinks on `argv[1]` before comparing:
  ```typescript
  import { realpathSync } from "node:fs";

  function isMainModule(): boolean {
    if (!process.argv[1]) return false;
    try {
      return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
    } catch {
      return false;
    }
  }

  if (isMainModule()) {
    main().catch(…);
  }
  ```
  Or, simpler and more robust — just always auto-execute (the original pattern before the guard was added). The test import issue can be solved by mocking `process.exit` or using `vi.importActual` patterns instead:
  ```typescript
  main().catch((error: unknown) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
  ```
  With the test using a `vi.mock` for the auto-execution side-effect. Either approach works — the `realpathSync` approach is less invasive to the current test structure.

---

## Important Issues

### 2. `importMain()` comment claims module cache clearing that doesn't happen

- **File:** `tests/index.test.ts:62-66`
- **Problem:** The comment says "Clear module cache so env vars are re-read" but there's no cache clearing — ESM `import()` caches modules. It works because `main()` reads `process.env` at call time, not import time, but the comment is misleading to future maintainers.
- **Fix:** Remove the misleading comment:
  ```typescript
  async function importMain(): Promise<{ main: () => Promise<void> }> {
    const mod = await import("../src/index.js");
    return mod;
  }
  ```

### 3. `src/index.ts` excluded from coverage — tests can't verify coverage target

- **File:** `vitest.config.ts:12`
- **Problem:** `src/index.ts` is in the coverage `exclude` list (added during Task 1 when it was a stub). Now that it has real logic (env validation, auth wiring, token refresh callback), it should be included in coverage measurement. The 14 tests achieve high coverage but this isn't being tracked.
- **Fix:** Remove `src/index.ts` from the exclude list:
  ```typescript
  exclude: [],  // was: ["src/index.ts"]
  ```
  Note: This requires fixing the `@vitest/coverage-v8` version incompatibility first (known from checkpoint-2).

### 4. `mockGet` declared but never used in tests

- **File:** `tests/index.test.ts:38`
- **Problem:** `const mockGet = vi.fn()` is declared at module scope and referenced in `setupHappyPath` (`{ get: mockGet }`) but no test ever asserts on `mockGet`. It's mock infrastructure that's wired up but not verified. If a future refactor removes the `get` property from the mock client, no test would catch it.
- **Fix:** Either remove `mockGet` (the entry point doesn't call `client.get` directly — that's the tools' job) and simplify the mock client, or add a comment explaining it's structural scaffolding.

### 5. Checkpoint-2 action items still open

- **Files:** Multiple
- **Problem:** Checkpoint-2 flagged 4 Important items for "before Task 10":
  1. ✅ `limit` Zod validation — fixed (`.int().min(1).max(25)`)
  2. ✅ `error.body` in WhoopApiError message — fixed
  3. ✅ `collection-utils.test.ts` — added (10 tests)
  4. ❌ Checkpoint-1 open items (AbortSignal timeout, `@vitest/coverage-v8` compat) — still open
- **Fix:** Track these for a pre-Task-10 hotfix batch.

---

## Suggestions

### 1. Consider `process.env.NODE_ENV` or a dedicated flag for test detection

- **File:** `src/index.ts:93-95`
- Instead of comparing file paths (fragile with symlinks), you could use `process.env.VITEST` or `process.env.NODE_ENV === "test"` as a simpler guard. Vitest sets `process.env.VITEST = "true"` automatically. However, the `realpathSync` fix is more principled.

### 2. Token refresh error could trigger re-authentication

- **File:** `src/index.ts:65-69`
- When `loadTokens()` returns `null`, the current code throws. An alternative is to trigger `authenticate(oauthConfig)` to start a fresh OAuth flow. This would be more resilient but changes the behavior contract — flag for V2.

### 3. Error message links could use a shorter URL

- **File:** `src/index.ts:39`
- The URL `https://github.com/shashankswe2020-ux/whoop-mcp#configuration` will 404 until the README has a `#configuration` anchor. Ensure Task 10 creates this anchor.

---

## What's Done Well

- **Clean 5-step sequential flow.** `main()` reads like a recipe: env → auth → client → server → transport. Each step is one line with a descriptive comment. Zero nesting, zero branching in the happy path.

- **`onTokenRefresh` reads from disk, not closure.** This is the correct design — if the refresh token was rotated by a previous refresh, the next call picks up the new one. The test verifies this explicitly.

- **Descriptive error messages with actionable guidance.** `getRequiredEnv` doesn't just say "missing env var" — it tells the user to set it in Claude Desktop config and links to docs. This is excellent UX for a CLI tool.

- **Comprehensive test suite for an entry point.** 14 tests covering env vars, auth, client wiring, token refresh callback internals, transport connection, and logging. The `setupHappyPath()` helper keeps tests readable. Mock structure is clean.

- **All logging to stderr.** Every `console.error()` call is intentional. No accidental `console.log()` that would corrupt the MCP stdio channel.

- **`export async function main()`** — Exporting `main()` enables direct testing without child process spawning, while the guard keeps production behavior correct (once the symlink bug is fixed).

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests pass | ✅ | 202 tests, 14 files, 0 failures |
| Typecheck | ✅ | Clean |
| Build | ✅ | Clean, shebang preserved in `dist/index.js` |
| Lint | ✅ | Clean |
| `node dist/index.js` | ✅ | Shows clear env var error |
| `npm link && whoop-mcp` | ❌ | **Silent exit — isMainModule guard fails** |
| Coverage | ⚠️ | `@vitest/coverage-v8` incompatible (pre-existing) |

---

## Action Items

| # | Priority | Issue | Target | GitHub |
|---|----------|-------|--------|--------|
| 1 | **Critical** | Fix `isMainModule` symlink bug — use `realpathSync` | Hotfix before Task 10 | ✅ Fixed in `7236b13` |
| 2 | Important | Remove misleading "cache clearing" comment in test | With fix #1 | ✅ Fixed in `7236b13` |
| 3 | Important | Re-include `src/index.ts` in coverage (after fixing v8 compat) | Task 10 | [#25](https://github.com/shashankswe2020-ux/whoop-mcp/issues/25) |
| 4 | Important | Remove unused `mockGet` or document its purpose | With fix #1 | ✅ Fixed in `7236b13` |
| 5 | Important | Resolve remaining checkpoint-1/2 items before publish | Before Task 10 | [#27](https://github.com/shashankswe2020-ux/whoop-mcp/issues/27) |
| 6 | Important | Fix `@vitest/coverage-v8` version incompatibility | Before Task 10 | [#26](https://github.com/shashankswe2020-ux/whoop-mcp/issues/26) |
| 7 | Suggestion | Ensure README `#configuration` anchor exists | Task 10 | [#28](https://github.com/shashankswe2020-ux/whoop-mcp/issues/28) |
| 8 | Suggestion | Consider re-auth fallback when `loadTokens()` returns null | V2 backlog | — |
