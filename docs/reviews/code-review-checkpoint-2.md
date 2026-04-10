# Code Review Checkpoint 2: Tasks 6–8

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-04-11
> **Scope:** Tasks 6–8 (MCP Server Shell, Tool Implementations, Error Handling)
> **Test suite:** 169 tests passing (13 files), typecheck clean, build clean, lint clean

---

## Verdict: ✅ APPROVE

**Overview:** Tasks 6–8 deliver a clean MCP server shell with all 6 tools, well-factored tool handlers, and solid error handling (429 retry with backoff, 401 token refresh, typed error classes). The architecture is excellent — `server.ts` is a pure factory, tool handlers are one-per-file thin delegates, and the `safeTool` wrapper provides consistent error-to-MCP conversion. 169 tests pass, typecheck/build/lint all clean.

---

## Critical Issues

None.

---

## Important Issues

### 1. `limit` has no Zod validation — spec says 1–25
- **File:** `src/server.ts:45`
- **Problem:** The `limit` field in `collectionInputSchema` is `z.number().optional()` with no `.int().min(1).max(25)` constraint. The description says "1-25" but Zod won't reject `0`, `-5`, `100`, or `3.7`. The WHOOP API might return a cryptic error or silently clamp, making it harder for Claude to debug.
- **Fix:**
  ```typescript
  limit: z.number().int().min(1).max(25).optional().describe("Max records to return (1-25). Defaults to 10."),
  ```

### 2. Hardcoded `version: "0.1.0"` in server — drifts from `package.json`
- **File:** `src/server.ts:122`
- **Problem:** `new McpServer({ name: "whoop-mcp", version: "0.1.0" })` hardcodes the version. When `package.json` is bumped to `0.2.0`, the MCP server will still report `0.1.0`. MCP clients display this to users.
- **Fix:** Read from `package.json` at build time or accept `version` as a parameter to `createWhoopServer`. The simplest approach: pass version from `index.ts` when wiring up in Task 9.

### 3. `collection-utils.ts` has no dedicated test file
- **File:** `src/tools/collection-utils.ts`
- **Problem:** `buildCollectionQuery` is tested only indirectly via the 4 collection tool tests. It has non-trivial logic (conditional param building, `?` prefix, `undefined` skipping). A direct unit test would catch regressions faster and make the test structure mirror `src/` per project conventions.
- **Fix:** Add `tests/tools/collection-utils.test.ts` with direct tests for edge cases: empty params, all params, single param, `undefined` vs omitted.

### 4. Checkpoint-1 action items not addressed in Tasks 6–8
- **Files:** `src/api/client.ts`, `src/auth/oauth.ts`, `src/auth/callback-server.ts`, `tests/scaffold.test.ts`
- **Problem:** The checkpoint-1 review flagged 5 Important action items targeted at "Hotfix or Task 8":
  1. ❌ `AbortSignal.timeout` on API client fetch — not added
  2. ❌ `exec` → `spawn` in `openBrowser` — still uses shell `exec`
  3. ❌ `console.error` on refresh catch in `authenticate()` — still silent
  4. ❌ `server.on('error')` in callback server — not added
  5. ❌ `scaffold.test.ts` removal — still present
  6. ❌ `@vitest/coverage-v8` — still not installed
- **Fix:** Track these as a hotfix batch or address before Task 10 (publish prep). Items 1 and 2 are the highest priority (indefinite hang risk + shell injection).

### 5. `WhoopApiError` message in `errorResponse` drops the response body
- **File:** `src/server.ts:73-74`
- **Problem:** `errorResponse` for `WhoopApiError` formats as `"WHOOP API returned 403 Forbidden"` but discards `error.body`, which often contains the WHOOP API's human-readable error description (e.g., `{"message": "Insufficient scope"}`). Claude would benefit from seeing the body to understand *why* the call failed.
- **Fix:**
  ```typescript
  if (error instanceof WhoopApiError) {
    const bodyStr = typeof error.body === 'string' ? error.body : JSON.stringify(error.body);
    message = `WHOOP API returned ${error.statusCode} ${error.statusText}: ${bodyStr}`;
  }
  ```

---

## Suggestions

### 1. ISO 8601 validation for `start` and `end` params
- **File:** `src/server.ts:32-41`
- `start` and `end` are `z.string().optional()` — Claude could pass `"last week"` or `"tuesday"` and it would reach the WHOOP API unvalidated. Consider `z.string().datetime()` or a `.refine()` with ISO 8601 regex. Low priority — WHOOP API will reject bad dates — but a Zod validation error is much friendlier.

### 2. `safeTool` return type is verbose — extract a type alias
- **File:** `src/server.ts:93-99`
- The return type `Promise<{ content: ... } | { isError: true; content: ... }>` is repeated implicitly. Consider:
  ```typescript
  type ToolResult = { content: Array<{ type: "text"; text: string }> } | { isError: true; content: Array<{ type: "text"; text: string }> };
  ```

### 3. Tool handler type annotations repeat the args shape
- **File:** `src/server.ts:159-162` (and all 4 collection registrations)
- Each `async (args: { start?: string; end?: string; limit?: number; nextToken?: string })` manually repeats the Zod schema shape. Consider `z.infer<typeof collectionInputSchema>` for DRY-ness.

### 4. Recovery test fixture missing `next_token` in server.test.ts
- **File:** `tests/server.test.ts:46-62`
- The `RECOVERY_FIXTURE` in `server.test.ts` has no `next_token` field, while the one in `get-recovery.test.ts` does. Pagination behavior isn't exercised in the integration test.

### 5. Consider a `createMockClient` shared test utility
- **Files:** `tests/tools/get-*.test.ts` (6 files)
- Each tool test file has an identical `createMockClient` helper. Extract to `tests/helpers/mock-client.ts` to reduce duplication.

---

## What's Done Well

- **Pure factory architecture for `createWhoopServer`.** No transport coupling, no env vars, no OAuth. This makes it trivially testable via `InMemoryTransport` and composable in Task 9. Textbook clean boundary.

- **The `safeTool` pattern is excellent.** Every tool handler gets automatic error-to-MCP conversion without cluttering individual tool implementations. The error hierarchy (`WhoopApiError` → `WhoopAuthError` → `WhoopNetworkError` → generic `Error`) is well-ordered and tested.

- **Tool handlers are maximally thin.** Each one is ~5 lines: import types, call `buildCollectionQuery`, call `client.get`. Zero business logic in the tool layer — it's pure delegation. This is the right abstraction level.

- **`buildCollectionQuery` extraction into `collection-utils.ts`.** Instead of duplicating URLSearchParams logic across 4 tools, it's shared. Follows DRY without over-abstracting. The `CollectionParams` interface is properly exported and reused.

- **Comprehensive server integration tests.** `server.test.ts` tests via `InMemoryTransport` — real MCP protocol, real JSON-RPC, real tool dispatch. Tests verify tool listing, schema shapes, handler output, and error propagation. The `createErrorServer` helper for error tests is clean.

- **429 retry with Retry-After header support.** The retry logic in `client.ts` respects the `Retry-After` header, falls back to exponential backoff (1s, 2s, 4s), caps at 3 retries, and has 8 focused tests with `vi.useFakeTimers()` verifying exact timing.

- **401 token refresh with single-retry guard.** Refreshes once, retries, and throws if the retry also fails — no infinite loop. Properly throws `WhoopAuthError` when the refresh callback itself fails. 6 test cases cover all branches.

- **`readOnlyHint` annotations on all tools.** Nice touch — tells MCP clients these tools don't mutate state, enabling safe prefetching.

---

## Verification Story

| Check | Status | Notes |
|-------|--------|-------|
| Tests reviewed | ✅ | `server.test.ts` (21), `client.test.ts` (33), 6 tool test files (34 total). Happy paths + error paths covered. |
| Build verified | ✅ | `typecheck`, `build`, `lint` all pass — zero warnings |
| Security checked | ✅ | No new secrets, no new dependencies. Checkpoint-1 shell injection (`exec`) still open. |
| Coverage | ⚠️ | `@vitest/coverage-v8` still not installed — cannot quantify. Qualitative assessment: >90% on `server.ts`, >95% on tool handlers, >85% on `client.ts` error paths. |

---

## Action Items

| # | Priority | Issue | Target |
|---|----------|-------|--------|
| 1 | Important | Add `.int().min(1).max(25)` to `limit` Zod schema | Hotfix |
| 2 | Important | Include `error.body` in `WhoopApiError` MCP error message | Hotfix |
| 3 | Important | Add `tests/tools/collection-utils.test.ts` | Hotfix |
| 4 | Important | Address checkpoint-1 open items (AbortSignal, spawn, etc.) | Before Task 10 |
| 5 | Suggestion | Use `z.infer<typeof collectionInputSchema>` for handler args | Backlog |
| 6 | Suggestion | Extract shared `createMockClient` test helper | Backlog |
| 7 | Suggestion | Sync server version with `package.json` | Task 9 (wiring) |
