# Task 8: Error Handling

> **Spec:** `docs/specs/whoop-mcp-server.md`
> **Depends on:** Tasks 1–7 (all complete, 147 tests passing)
> **Created:** 2026-04-11

---

## Overview

Add resilient error handling to the API client: automatic retry with backoff for rate limits (429), token refresh on auth failures (401), and clear error messages for network errors. Currently the client throws `WhoopApiError` on any non-2xx response and lets `TypeError` propagate on network failure — this task wraps those raw errors in retry/recovery logic.

## Architecture Decisions

1. **Retry logic lives in the client factory, not in tool handlers** — The `createWhoopClient` factory gains retry/re-auth behavior. Tool handlers (`src/tools/*.ts`) remain unchanged — they call `client.get()` and the client handles transient failures transparently.

2. **New `WhoopClientOptions` fields for refresh/re-auth callbacks** — The client is a pure HTTP wrapper. It does not import OAuth directly. Instead, `createWhoopClient` accepts optional callbacks: `onTokenRefresh` (returns new access token) and `onAuthRequired` (triggers full re-auth). This keeps the client testable without mocking the OAuth module.

3. **Exponential backoff with `Retry-After` header support** — On 429, read the `Retry-After` header (seconds). If present, wait that long. If absent, use exponential backoff (1s, 2s, 4s). Max 3 retries per request.

4. **401 triggers exactly one token refresh attempt** — On 401, call `onTokenRefresh`. If that succeeds, retry the request with the new token. If it fails (or a second 401 occurs), call `onAuthRequired` and throw a descriptive error. No infinite refresh loops.

5. **Network errors get wrapped in a `WhoopNetworkError`** — `TypeError: fetch failed` is not helpful to Claude. Wrap it: "Network error: Unable to reach WHOOP API. Check your internet connection."

6. **Server-level error handler in `server.ts`** — Tool handlers currently let errors propagate. Add a try/catch wrapper so the MCP tool returns `{ isError: true, content: [{ type: "text", text: <message> }] }` instead of crashing the server.

## Task List

### Task 8a: `WhoopNetworkError` class + network error wrapping

**Description:** Add a new error class for network-level failures and wrap `fetch` errors in the client.

**Acceptance criteria:**
- [ ] `WhoopNetworkError` extends `Error` with `name = "WhoopNetworkError"` and `cause` property
- [ ] Network errors from `fetch` (e.g., `TypeError: fetch failed`) are caught and rethrown as `WhoopNetworkError`
- [ ] Error message is user-friendly: "Network error: Unable to reach the WHOOP API. Check your internet connection."
- [ ] Original error preserved as `.cause`
- [ ] Tests verify wrapping behavior

**Verification:** `npm test -- tests/api/client.test.ts`

**Dependencies:** None (first task, isolated)

**Files:**
- `src/api/client.ts` (modify — add `WhoopNetworkError`, wrap fetch errors)
- `tests/api/client.test.ts` (modify — add network error wrapping tests)

**Estimated scope:** Small (2 files)

---

### Task 8b: Retry logic for 429 rate limits

**Description:** Add automatic retry with backoff when the WHOOP API returns 429 Too Many Requests.

**Acceptance criteria:**
- [ ] On 429 response, client retries up to `MAX_RETRIES` (3) times
- [ ] If `Retry-After` header is present (seconds), wait that duration before retrying
- [ ] If `Retry-After` header is absent, use exponential backoff: 1s, 2s, 4s
- [ ] After max retries exhausted, throw the original `WhoopApiError` (429)
- [ ] Non-429 errors are NOT retried (pass through immediately)
- [ ] Successful retry returns the response as if no error occurred
- [ ] Tests cover: retry succeeds on 2nd attempt, retry succeeds on 3rd, all retries exhausted, `Retry-After` header respected

**Verification:** `npm test -- tests/api/client.test.ts`

**Dependencies:** Task 8a (network error wrapping in place)

**Files:**
- `src/api/client.ts` (modify — add retry loop around fetch)
- `tests/api/client.test.ts` (modify — add retry tests)

**Estimated scope:** Small (2 files)

---

### Task 8c: Token refresh on 401

**Description:** Add automatic token refresh when the WHOOP API returns 401 Unauthorized. The client calls an `onTokenRefresh` callback to get a new access token, then retries the request once.

**Acceptance criteria:**
- [ ] `WhoopClientOptions` gains optional `onTokenRefresh?: () => Promise<string>` callback
- [ ] On 401 response, if `onTokenRefresh` is provided, call it and retry with the new token
- [ ] If the retry also returns 401, throw `WhoopApiError` (no infinite loop)
- [ ] If `onTokenRefresh` is not provided, throw `WhoopApiError` immediately (current behavior)
- [ ] If `onTokenRefresh` itself throws, throw a descriptive `WhoopAuthError` wrapping the cause
- [ ] Tests cover: refresh succeeds → retry works, refresh fails → error thrown, second 401 → error thrown, no callback → original behavior

**Verification:** `npm test -- tests/api/client.test.ts`

**Dependencies:** Task 8b (retry logic framework in place)

**Files:**
- `src/api/client.ts` (modify — add `onTokenRefresh` to options, add 401 handling)
- `tests/api/client.test.ts` (modify — add 401/refresh tests)

**Estimated scope:** Small (2 files)

---

### Task 8d: Tool-level error handling in `server.ts`

**Description:** Wrap each tool handler in `server.ts` with a try/catch so that API errors return MCP-formatted error responses instead of crashing the server.

**Acceptance criteria:**
- [ ] `WhoopApiError` is caught and returned as `{ isError: true, content: [{ type: "text", text: <message> }] }`
- [ ] Error text includes status code and a user-friendly message (e.g., "WHOOP API returned 403 Forbidden")
- [ ] `WhoopNetworkError` is caught with a network-specific message
- [ ] Unknown errors are caught with a generic "Unexpected error" message
- [ ] Existing server tests still pass (happy path unchanged)
- [ ] New server tests verify error responses for each error type

**Verification:** `npm test -- tests/server.test.ts`

**Dependencies:** Tasks 8a–8c (error types exist)

**Files:**
- `src/server.ts` (modify — add error wrapper)
- `tests/server.test.ts` (modify — add error response tests)

**Estimated scope:** Small (2 files)

---

### Task 8e: Verification checkpoint

**Description:** Full test suite + typecheck + build + lint. Ensure all existing tests pass and nothing regressed.

**Acceptance criteria:**
- [ ] All tests pass (`npm test`)
- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] Build succeeds (`npm run build`)
- [ ] Lint clean (`npm run lint`)
- [ ] No `any` types introduced
- [ ] `WhoopClient` interface unchanged (tools don't need modification)
- [ ] All error classes have explicit `name` property and are exported

**Verification:** `npm test && npm run typecheck && npm run build && npm run lint`

**Dependencies:** Tasks 8a–8d

**Files:** None (verification only)

---

## Implementation Order

```
8a (WhoopNetworkError + wrapping)  ← new error class, simplest change
    │
8b (429 retry with backoff)        ← retry loop, depends on error handling
    │
8c (401 token refresh)             ← builds on retry pattern
    │
8d (server.ts error wrapper)       ← consumes the error types from 8a–8c
    │
8e (full verification checkpoint)
```

**Why this order:**
1. **8a first** — Adds the simplest error class and wrapping. All subsequent tasks need clean error types.
2. **8b second** — Retry logic is self-contained within the client's `get` method. No external dependencies.
3. **8c third** — Token refresh builds on the same request-retry pattern from 8b but adds the callback mechanism.
4. **8d fourth** — Server-level error handling consumes the error types created in 8a–8c. Must come after so the types exist.
5. **8e last** — Full verification after all changes are in place.

## Checkpoint: After Task 8e

- [ ] All tests pass (`npm test`)
- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] Build succeeds (`npm run build`)
- [ ] Lint clean (`npm run lint`)
- [ ] 429 responses retry automatically (up to 3 times, with backoff)
- [ ] 401 responses trigger token refresh callback (if provided)
- [ ] Network errors produce clear, user-friendly messages
- [ ] MCP tool errors return `{ isError: true }` instead of crashing
- [ ] No changes to `src/tools/*.ts` — error handling is transparent
- [ ] `WhoopClient` interface still has only `get<T>(path): Promise<T>`

## Design: Client `get` Method Flow After Task 8

```
get(path)
    │
    ▼
  fetch(url) ──────────────── network error? ──→ throw WhoopNetworkError
    │
    ▼
  response.ok? ──── yes ──→ return JSON
    │
    no
    │
    ├── 429? ──→ read Retry-After ──→ wait ──→ retry (up to 3x)
    │                                              │
    │                                     still 429? ──→ throw WhoopApiError
    │
    ├── 401? ──→ onTokenRefresh? ──→ call it ──→ retry once with new token
    │               │                                │
    │               no                      still 401? ──→ throw WhoopApiError
    │               │
    │               └──→ throw WhoopApiError
    │
    └── other ──→ throw WhoopApiError
```

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Retry tests are timing-sensitive (flaky) | 🟡 Medium | Use `vi.useFakeTimers()` to control `setTimeout`. Don't rely on real time. |
| `onTokenRefresh` callback creates circular dependency with OAuth | 🟢 Low | Callback is a plain function, not an import. Wiring happens in `index.ts` (Task 9). |
| Changing the `get` method signature breaks tool tests | 🟡 Medium | `WhoopClient` interface stays the same — only internal implementation changes. Tool tests mock the interface, not the implementation. |
| `Retry-After` header parsing edge cases | 🟢 Low | Parse as integer seconds. If missing or unparseable, fall back to exponential backoff. |

## Out of Scope

- Retry on 5xx server errors — WHOOP API docs don't indicate transient 5xx. Can be added later if needed.
- Circuit breaker pattern — overkill for a single-user MCP server.
- Request queuing / concurrency limiting — MCP tools are called sequentially by the AI assistant.
- Persistent error logging — `console.error` is sufficient; structured logging is a future enhancement.
