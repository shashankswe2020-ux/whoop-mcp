# Task 15: v0.7.0 — Performance + Architecture (Cache + Write-Safety)

> **Spec:** `docs/specs/v3-platform-enhancements.md` (Features 9–10)
> **Depends on:** Task 14 complete (v0.6.0 shipped)
> **Created:** 2026-05-31

---

## Overview

Two features that improve performance and future-proof the architecture: a unified in-memory LRU cache (replacing the existing `ResourceCache`) and a write-safety preview pattern for eventual write operations. Both are lower-risk, self-contained improvements that don't touch the transport or security layers.

## Architecture Decisions

1. **Cache replaces existing `ResourceCache`** — Not a parallel system. The existing `ResourceCache` in `src/resources/index.ts` is removed and replaced by a unified `MemoryCache` class that serves both tools and resources.

2. **Cache key = endpoint + sorted query params** — Deterministic, reproducible. No tokens or auth headers in cache keys (single-user assumption; no cross-user leakage possible).

3. **Nuclear invalidation on token refresh** — `cache.clear()` called when tokens are refreshed. This is the simplest correct approach: token refresh implies a session boundary, and stale data is more likely after re-auth.

4. **LRU eviction with configurable max entries** — Default 100 entries. When exceeded, the least-recently-accessed entry is evicted. Simple `Map` with delete-and-re-insert for access tracking.

5. **Write-safety is a utility pattern, not a tool** — `withPreview()` is a generic function that wraps any write operation in a preview/confirm flow. No actual write tools are registered — just the pattern + tests + documentation.

6. **`idempotency_key` enables safe retries** — UUID v4 generated per preview, echoed in the receipt. If WHOOP ever adds write endpoints, this prevents duplicate mutations on network retry.

---

## Dependency Graph

```
┌────────────────────────────┐    ┌────────────────────────────┐
│ 15a. MemoryCache class     │    │ 15c. Write-safety pattern  │
│      (LRU, TTL, clear)     │    │      (withPreview utility) │
└──────────────┬─────────────┘    └──────────────┬─────────────┘
               │                                  │
┌──────────────▼─────────────┐                    │  ← Independent tracks
│ 15b. Replace ResourceCache │                    │
│      + wire cache.clear()  │                    │
│      on token refresh      │                    │
└──────────────┬─────────────┘                    │
               │                                  │
               └──────────────┬───────────────────┘
                              │
               ┌──────────────▼──────────────┐
               │ 15d. Full verification      │
               └─────────────────────────────┘
```

**Parallelism:** Tasks 15a–15b (cache) and 15c (write-safety) are fully independent and can be implemented in parallel.

---

## Task List

### Task 15a: MemoryCache Class

**Description:** Implement a generic in-memory LRU cache with TTL support. Standalone module with no dependencies on other parts of the system.

**Acceptance criteria:**
- [ ] `MemoryCache<T>` class with configurable `defaultTtlMs` and `maxEntries`
- [ ] `get(key)` returns cached value if within TTL, `undefined` if expired or missing
- [ ] `set(key, value, ttlMs?)` stores with optional custom TTL (overrides default)
- [ ] `has(key)` returns true only if entry exists AND is within TTL
- [ ] `clear()` removes all entries
- [ ] `size` property returns current entry count
- [ ] LRU eviction: when `maxEntries` exceeded, least-recently-accessed entry evicted
- [ ] Access (get) updates LRU position
- [ ] Cache key is string (endpoint + sorted params responsibility of caller)
- [ ] Expired entries cleaned up lazily on access (no background timer)
- [ ] No runtime dependencies
- [ ] Tests verify: TTL expiry, LRU eviction, clear(), size tracking

**Verification:** `npm test -- tests/cache/memory-cache.test.ts`

**Dependencies:** None

**Files:**
- `src/cache/memory-cache.ts` (create)
- `tests/cache/memory-cache.test.ts` (create)

**Estimated scope:** Small (2 new files, pure data structure)

---

### Task 15b: Replace ResourceCache + Wire Token Refresh

**Description:** Remove the existing `ResourceCache` from `src/resources/index.ts`, replace all cache usage with the new `MemoryCache`, and wire `cache.clear()` to trigger on token refresh.

> **Architecture decision:** Cache is integrated at the `WhoopClient.get()` level as opt-in middleware (a `cache` option on the client), not in individual tools. Tools inherit caching transparently.

**Acceptance criteria:**
- [ ] Existing `ResourceCache` class/logic removed from `src/resources/index.ts`
- [ ] `MemoryCache` instance created at application level (singleton per process)
- [ ] `WhoopClient.get()` accepts optional `{ cache: true, ttlMs?: number }` option
- [ ] Resources (`src/resources/index.ts`) use `MemoryCache` for latest recovery/sleep/cycle
- [ ] `get_today` tool uses cache transparently (3 fetches may hit cache → 0 API calls)
- [ ] Cache TTLs applied: Profile 1hr, Recovery/Sleep 5min, Cycle 2min, Collections uncached
- [ ] `cache.clear()` called on token refresh (in `src/auth/token-store.ts` or client)
- [ ] Cache key format: `GET:/v2/recovery?limit=1` (method:endpoint?sorted_params)
- [ ] No tokens or auth data in cache keys
- [ ] Cache stampede prevention: concurrent gets on expired key trigger 1 fetch (others await)
- [ ] Existing resource tests updated (mock cache behavior)
- [ ] No regression in resource behavior (same data, fewer API calls)
- [ ] HTTP transport tool calls benefit from cache (test via HTTP)

**Verification:** `npm test -- tests/resources/ tests/cache/`

**Dependencies:** Task 15a (MemoryCache class exists)

**Files:**
- `src/cache/memory-cache.ts` (no change — already created in 15a)
- `src/resources/index.ts` (modify — remove old cache, use MemoryCache)
- `src/api/client.ts` (modify — add optional cache parameter or middleware)
- `tests/resources/index.test.ts` (modify — update cache expectations)
- `tests/api/client.test.ts` (modify — verify cache integration)

**Estimated scope:** Medium (3 files modified, integration work)

---

### Task 15c: Write-Safety Preview Pattern

**Description:** Implement the `withPreview()` utility function and TypeScript types for the preview/confirm flow. Test with a mock write operation. Document in README.

**Acceptance criteria:**
- [ ] `WritePreview<T>` and `WriteReceipt<T>` interfaces exported
- [ ] `WriteResult<T>` discriminated union type (`preview: true | false`)
- [ ] `withPreview()` utility function: takes `confirm` boolean + async write function
- [ ] `confirm: false` → returns `WritePreview` with generated `idempotency_key` (UUID v4)
- [ ] `confirm: true` → executes write, returns `WriteReceipt` with same `idempotency_key`
- [ ] `idempotency_key` is unique per call (UUID v4 format)
- [ ] Type-safe: `if (result.preview) { ... }` narrows correctly
- [ ] Mock write tool in tests demonstrates the full flow
- [ ] No actual write tools registered on the server
- [ ] README documents the pattern as "future-ready for write operations"

**Verification:** `npm test -- tests/tools/write-safety.test.ts`

**Dependencies:** None (independent of cache work)

**Files:**
- `src/tools/write-safety.ts` (create)
- `tests/tools/write-safety.test.ts` (create)
- `README.md` (modify — add "Write Operations" section)

**Estimated scope:** Small (2 new files + README update)

---

### Task 15d: Full Verification

**Description:** Complete verification — all tests, typecheck, build, lint, verify cache improves performance, verify write-safety types are correct.

**Acceptance criteria:**
- [ ] All tests pass (`npm test`)
- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] Build succeeds (`npm run build`)
- [ ] Lint clean (`npm run lint`)
- [ ] Cache hit reduces API call count (verified via mock call assertions)
- [ ] `cache.clear()` on token refresh verified
- [ ] `withPreview()` type narrowing works at compile time
- [ ] No regression in any existing functionality
- [ ] Coverage: ≥ 90% on new files

**Verification:** `npm test && npm run typecheck && npm run build && npm run lint`

**Dependencies:** Tasks 15a, 15b, 15c

**Files:** None (verification only)

---

## Checkpoint: After Task 15d

- [ ] All tests pass
- [ ] Old `ResourceCache` fully removed
- [ ] `MemoryCache` serves tools + resources with correct TTLs
- [ ] Cache cleared on token refresh
- [ ] `get_today` with warm cache makes 0 API calls
- [ ] LRU eviction works at 100 entries
- [ ] `withPreview()` pattern tested and documented
- [ ] `idempotency_key` unique per preview
- [ ] No new runtime dependencies
- [ ] v0.7.0 ready for release

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Removing ResourceCache breaks resource tests | Medium | Refactor incrementally: make MemoryCache API-compatible first, then swap |
| Cache key collisions (different params → same key) | Low | Sort params alphabetically; include all query params in key |
| Token refresh doesn't propagate to cache.clear() | Medium | Wire at application level (index.ts), test with integration test |
| LRU eviction in wrong order | Low | Unit test with exactly maxEntries + 1 insertions, verify evicted key |
| `withPreview` idempotency_key not truly unique | Very Low | `crypto.randomUUID()` — collisions are astronomically unlikely |

---

## Files Delivered

| File | Action | Description |
|------|--------|-------------|
| `src/cache/memory-cache.ts` | Create | LRU cache with TTL |
| `src/tools/write-safety.ts` | Create | withPreview() + types |
| `src/resources/index.ts` | Modify | Remove old cache, use MemoryCache |
| `src/api/client.ts` | Modify | Optional cache integration |
| `README.md` | Modify | Write-safety documentation |
| `tests/cache/memory-cache.test.ts` | Create | TTL, LRU, clear, size |
| `tests/tools/write-safety.test.ts` | Create | Preview/confirm flow |
| `tests/resources/index.test.ts` | Modify | Updated cache expectations |
| `tests/api/client.test.ts` | Modify | Cache integration tests |

---

## Post-v0.7.0: V3 Complete

After this task, all V3 features are shipped:

| Version | Tools | Transport | Key Feature |
|---------|-------|-----------|-------------|
| v0.3.1 | 12 | stdio | Baseline |
| v0.4.0 | 14 | stdio | get_today + get_calendar |
| v0.5.0 | 14 | stdio + HTTP | Remote hosting + OAuth |
| v0.6.0 | 16 | stdio + HTTP | Correlations + webhooks |
| v0.7.0 | 16 | stdio + HTTP | Cache + write-safety |

**Final metrics:**
- 16 MCP tools, 4 resources, 5 prompts
- ~600 tests (est.)
- stdio + HTTP + OAuth transport
- Docker + Fly + Railway deployment
- Guided CLI setup
- Structured observability
