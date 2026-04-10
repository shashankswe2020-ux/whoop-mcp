# Task 3 Plan: Token Store

> **Parent spec:** `docs/specs/implementation-plan.md` → Task 3
> **Depends on:** Task 1 (scaffold) ✅, Task 2 (types) ✅
> **Consumed by:** Task 4 (API client), Task 5 (OAuth flow), Task 9 (entry point)
> **Created:** 2026-04-10

---

## Overview

Implement file-based OAuth token storage at `~/.whoop-mcp/tokens.json`. The token store is a pure I/O module: save tokens, load tokens, delete tokens, and check if a token is expired. It has no dependencies on the API client or OAuth flow — they depend on it.

## Architecture Decisions

- **Token shape is our own type** — We define `OAuthTokens` with `access_token`, `refresh_token`, `expires_at` (epoch ms), and `token_type`. The `expires_at` field is computed at save time from the OAuth response's `expires_in` (seconds).
- **File permissions are 0600** — User-only read/write. This is a security requirement (spec + security checklist).
- **Directory is created on first write** — `~/.whoop-mcp/` is created with `0700` permissions if it doesn't exist. Read operations return `null` if no file found.
- **Expiry check uses a buffer** — Tokens are considered expired 60 seconds before actual expiry to prevent edge-case auth failures mid-request.
- **Pure functions + thin I/O wrappers** — `isTokenExpired()` is a pure function (testable without mocks). File I/O functions are thin and testable with temp directories.
- **No classes** — Functional style per project conventions. Export individual functions.

## Dependency Graph

```
src/auth/token-store.ts  ← No dependencies (just fs + path + os)
tests/auth/token-store.test.ts  ← imports token-store.ts

Consumed by:
  → src/auth/oauth.ts (Task 5) — saves/reads tokens
  → src/api/client.ts (Task 4) — reads access_token for auth header
  → src/index.ts (Task 9) — checks if tokens exist on startup
```

## Token Shape

```typescript
interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;    // Unix epoch milliseconds
  token_type: string;    // Typically "Bearer"
}
```

Why `expires_at` (absolute) instead of `expires_in` (relative)?
- `expires_in` is what the OAuth server returns (seconds from now)
- We convert to `expires_at = Date.now() + expires_in * 1000` at save time
- This makes `isTokenExpired()` a simple comparison: `expires_at <= Date.now() + buffer`

## Task List

### Task 3a: Token types and expiry check (pure logic)

**Description:** Define the `OAuthTokens` interface and the `isTokenExpired()` pure function. No I/O — just types and logic.

**Acceptance criteria:**
- [ ] `OAuthTokens` interface defined with `access_token`, `refresh_token`, `expires_at`, `token_type`
- [ ] `isTokenExpired(tokens)` returns `true` when `expires_at` is within 60s of now
- [ ] `isTokenExpired(tokens)` returns `false` for tokens expiring in the future
- [ ] Tests use fixed timestamps (no flakiness)

**Verification:** `npm test -- tests/auth/token-store.test.ts`

**Dependencies:** None

**Files:**
- `src/auth/token-store.ts` (partial — types + pure function)
- `tests/auth/token-store.test.ts` (partial — expiry tests)

**Estimated scope:** XS (1 file, ~20 lines of code + ~30 lines of test)

---

### Task 3b: Save tokens to disk

**Description:** Implement `saveTokens(tokens)` — creates `~/.whoop-mcp/` directory (0700) if needed, writes `tokens.json` with 0600 permissions.

**Acceptance criteria:**
- [ ] `saveTokens()` writes valid JSON to the token file path
- [ ] Directory is created with `0700` permissions if it doesn't exist
- [ ] File is written with `0600` permissions (user-only read/write)
- [ ] Tests use a temp directory (not the real `~/.whoop-mcp/`)

**Verification:** `npm test -- tests/auth/token-store.test.ts`

**Dependencies:** Task 3a (needs `OAuthTokens` type)

**Files:**
- `src/auth/token-store.ts` (add `saveTokens`)
- `tests/auth/token-store.test.ts` (add save tests)

**Estimated scope:** S (same files, ~25 lines of code + ~40 lines of test)

---

### Task 3c: Load tokens from disk

**Description:** Implement `loadTokens()` — reads and parses `tokens.json`. Returns `null` if file doesn't exist or is malformed.

**Acceptance criteria:**
- [ ] `loadTokens()` returns parsed `OAuthTokens` when file exists with valid JSON
- [ ] `loadTokens()` returns `null` when file doesn't exist (no throw)
- [ ] `loadTokens()` returns `null` when file contains invalid JSON (no throw)
- [ ] Round-trip: `saveTokens()` → `loadTokens()` returns same data

**Verification:** `npm test -- tests/auth/token-store.test.ts`

**Dependencies:** Task 3b (needs save to test round-trip)

**Files:**
- `src/auth/token-store.ts` (add `loadTokens`)
- `tests/auth/token-store.test.ts` (add load tests)

**Estimated scope:** S (same files, ~20 lines of code + ~40 lines of test)

---

### Task 3d: Delete tokens from disk

**Description:** Implement `deleteTokens()` — removes `tokens.json`. No-op if file doesn't exist.

**Acceptance criteria:**
- [ ] `deleteTokens()` removes the token file
- [ ] `deleteTokens()` does not throw if file doesn't exist
- [ ] After delete, `loadTokens()` returns `null`

**Verification:** `npm test -- tests/auth/token-store.test.ts`

**Dependencies:** Task 3b, 3c

**Files:**
- `src/auth/token-store.ts` (add `deleteTokens`)
- `tests/auth/token-store.test.ts` (add delete tests)

**Estimated scope:** XS (same files, ~10 lines of code + ~20 lines of test)

---

### Task 3e: Configurable token path (testability)

**Description:** Make the token directory configurable via an optional parameter or internal constant so tests can use a temp directory. Ensure the default remains `~/.whoop-mcp/`. Final integration check: all tests pass, build clean, lint clean.

**Acceptance criteria:**
- [ ] All exported functions accept an optional `tokenDir` override for testing
- [ ] Default path resolves to `~/.whoop-mcp/tokens.json`
- [ ] All existing tests still pass using temp directories
- [ ] Full pipeline green: `npm test && npm run typecheck && npm run lint && npm run build`

**Verification:** `npm test && npm run typecheck && npm run lint && npm run build`

**Dependencies:** Tasks 3a-3d

**Files:**
- `src/auth/token-store.ts` (refactor path handling)
- `tests/auth/token-store.test.ts` (verify temp dirs work)

**Estimated scope:** XS (refactor, no new functionality)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| File permission tests may behave differently in CI vs local | 🟡 Medium | Test permissions with `fs.stat()` on the created file; skip on Windows if needed |
| Temp directory cleanup failure leaks test artifacts | 🟢 Low | Use `afterEach` cleanup with `fs.rm(dir, { recursive: true })` |
| Token file race conditions if multiple processes write | 🟢 Low | Out of scope for MVP — single process assumed |

## Checkpoint: After Task 3e

- [ ] All token store tests pass: `npm test -- tests/auth/token-store.test.ts`
- [ ] Full suite passes: `npm test`
- [ ] Build clean: `npm run build`
- [ ] Typecheck clean: `npm run typecheck`
- [ ] Lint clean: `npm run lint`
- [ ] No secrets committed
- [ ] Token file uses 0600 permissions
