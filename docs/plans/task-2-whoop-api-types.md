# Task 2 Plan: WHOOP API Types

> **Parent spec:** `docs/specs/implementation-plan.md` → Task 2
> **Source of truth:** WHOOP OpenAPI spec (`https://api.prod.whoop.com/developer/doc/openapi.json`)
> **Created:** 2026-04-10

---

## Overview

Define TypeScript types for all WHOOP API responses used by our 6 MCP tools, plus endpoint URL constants. These types are the shared contract consumed by the API client (Task 3), all 6 tool handlers (Tasks 7a-7f), and their tests.

## Architecture Decisions

- **Types match the OpenAPI spec exactly** — property names use `snake_case` to mirror the JSON responses (no casing transformation at the type level).
- **Score fields are optional** — The API returns scores only when `score_state === "SCORED"`. Types reflect this with optional `score` properties.
- **Paginated responses use a generic pattern** — All collection endpoints return `{ records: T[], next_token?: string }`. We define a `PaginatedResponse<T>` generic.
- **One file for types, one for endpoints** — keeps imports clean and matches the spec's project structure.
- **`ScoreState` as a union type** — `"SCORED" | "PENDING_SCORE" | "UNSCORABLE"` enforced across all scorable entities.

## Dependency Graph

```
src/api/endpoints.ts  ← No dependencies (just constants)
src/api/types.ts      ← No dependencies (just type definitions)

Both are consumed by:
  → src/api/client.ts (Task 3)
  → src/tools/*.ts (Tasks 7a-7f)
  → tests/**/*.test.ts
```

## Task List

### Task 2a: Endpoint constants (`src/api/endpoints.ts`)

**Description:** Define the WHOOP API base URL, OAuth URLs, required scopes, and all endpoint paths as typed constants.

**Acceptance criteria:**
- [ ] `WHOOP_API_BASE_URL` is `https://api.prod.whoop.com/developer`
- [ ] OAuth authorization and token URLs are defined
- [ ] All 6 endpoint paths are defined as constants
- [ ] Required scopes string is defined
- [ ] File compiles: `npm run typecheck`

**Verification:** `npm run typecheck`

**Dependencies:** None (Task 1 complete)

**Files:**
- `src/api/endpoints.ts`

**Estimated scope:** XS (1 file)

---

### Task 2b: Shared types — ScoreState, PaginatedResponse (`src/api/types.ts` — part 1)

**Description:** Define the shared type primitives reused across multiple response types: `ScoreState` union and `PaginatedResponse<T>` generic.

**Acceptance criteria:**
- [ ] `ScoreState` is `"SCORED" | "PENDING_SCORE" | "UNSCORABLE"`
- [ ] `PaginatedResponse<T>` has `records: T[]` and `next_token?: string`
- [ ] File compiles: `npm run typecheck`

**Verification:** `npm run typecheck`

**Dependencies:** None

**Files:**
- `src/api/types.ts`

**Estimated scope:** XS (1 file, ~10 lines)

---

### Task 2c: User types — Profile + BodyMeasurement (`src/api/types.ts` — part 2)

**Description:** Add types for the two user-related endpoints: `UserProfile` and `BodyMeasurement`.

**Acceptance criteria:**
- [ ] `UserProfile` has: `user_id` (number), `email` (string), `first_name` (string), `last_name` (string) — all required per OpenAPI
- [ ] `BodyMeasurement` has: `height_meter` (number), `weight_kilogram` (number), `max_heart_rate` (number) — all required per OpenAPI
- [ ] File compiles: `npm run typecheck`

**Verification:** `npm run typecheck`

**Dependencies:** Task 2b

**Files:**
- `src/api/types.ts`

**Estimated scope:** XS (same file, ~15 lines)

---

### Task 2d: Recovery types (`src/api/types.ts` — part 3)

**Description:** Add types for recovery responses: `RecoveryScore`, `Recovery`, and `RecoveryCollection` (paginated).

**Acceptance criteria:**
- [ ] `RecoveryScore` has: `user_calibrating` (boolean, required), `recovery_score` (number, required), `resting_heart_rate` (number, required), `hrv_rmssd_milli` (number, required), `spo2_percentage` (number, optional), `skin_temp_celsius` (number, optional)
- [ ] `Recovery` has: `cycle_id` (number), `sleep_id` (string), `user_id` (number), `created_at` (string), `updated_at` (string), `score_state` (ScoreState), `score` (RecoveryScore, optional)
- [ ] `RecoveryCollection` is `PaginatedResponse<Recovery>`
- [ ] File compiles: `npm run typecheck`

**Verification:** `npm run typecheck`

**Dependencies:** Task 2b

**Files:**
- `src/api/types.ts`

**Estimated scope:** XS (same file, ~25 lines)

---

### Task 2e: Sleep types (`src/api/types.ts` — part 4)

**Description:** Add types for sleep responses: `SleepStageSummary`, `SleepNeeded`, `SleepScore`, `Sleep`, and `SleepCollection`.

**Acceptance criteria:**
- [ ] `SleepStageSummary` has all 8 required fields: `total_in_bed_time_milli`, `total_awake_time_milli`, `total_no_data_time_milli`, `total_light_sleep_time_milli`, `total_slow_wave_sleep_time_milli`, `total_rem_sleep_time_milli`, `sleep_cycle_count`, `disturbance_count`
- [ ] `SleepNeeded` has: `baseline_milli`, `need_from_sleep_debt_milli`, `need_from_recent_strain_milli`, `need_from_recent_nap_milli` (all required numbers)
- [ ] `SleepScore` has: `stage_summary` (required), `sleep_needed` (required), `respiratory_rate?`, `sleep_performance_percentage?`, `sleep_consistency_percentage?`, `sleep_efficiency_percentage?`
- [ ] `Sleep` has all required fields: `id`, `cycle_id`, `user_id`, `created_at`, `updated_at`, `start`, `end`, `timezone_offset`, `nap`, `score_state`, plus optional `v1_id` and `score`
- [ ] `SleepCollection` is `PaginatedResponse<Sleep>`
- [ ] File compiles: `npm run typecheck`

**Verification:** `npm run typecheck`

**Dependencies:** Task 2b

**Files:**
- `src/api/types.ts`

**Estimated scope:** S (same file, ~50 lines)

---

### Task 2f: Cycle types (`src/api/types.ts` — part 5)

**Description:** Add types for cycle responses: `CycleScore`, `Cycle`, and `CycleCollection`.

**Acceptance criteria:**
- [ ] `CycleScore` has: `strain` (number, required), `kilojoule` (number, required), `average_heart_rate` (number, required), `max_heart_rate` (number, required)
- [ ] `Cycle` has all required fields: `id`, `user_id`, `created_at`, `updated_at`, `start`, `timezone_offset`, `score_state`, plus optional `end` and `score`
- [ ] `CycleCollection` is `PaginatedResponse<Cycle>`
- [ ] File compiles: `npm run typecheck`

**Verification:** `npm run typecheck`

**Dependencies:** Task 2b

**Files:**
- `src/api/types.ts`

**Estimated scope:** XS (same file, ~25 lines)

---

### Task 2g: Workout types (`src/api/types.ts` — part 6)

**Description:** Add types for workout responses: `ZoneDurations`, `WorkoutScore`, `Workout`, and `WorkoutCollection`.

**Acceptance criteria:**
- [ ] `ZoneDurations` has all 6 required fields: `zone_zero_milli` through `zone_five_milli`
- [ ] `WorkoutScore` has all required fields: `strain`, `average_heart_rate`, `max_heart_rate`, `kilojoule`, `percent_recorded`, `zone_durations`, plus optional `distance_meter`, `altitude_gain_meter`, `altitude_change_meter`
- [ ] `Workout` has all required fields: `id`, `user_id`, `created_at`, `updated_at`, `start`, `end`, `timezone_offset`, `sport_name`, `score_state`, plus optional `v1_id`, `score`, `sport_id`
- [ ] `WorkoutCollection` is `PaginatedResponse<Workout>`
- [ ] File compiles: `npm run typecheck`

**Verification:** `npm run typecheck`

**Dependencies:** Task 2b

**Files:**
- `src/api/types.ts`

**Estimated scope:** S (same file, ~40 lines)

---

### Task 2h: Type verification test (`tests/api/types.test.ts`)

**Description:** Write a compile-time verification test that imports all types and validates they accept correct fixture data and reject incorrect data (using `satisfies`).

**Acceptance criteria:**
- [ ] All types are importable from `src/api/types.ts`
- [ ] All endpoints are importable from `src/api/endpoints.ts`
- [ ] Fixture data matching real WHOOP API samples passes type checking
- [ ] Test passes: `npm test`

**Verification:** `npm test && npm run typecheck`

**Dependencies:** Tasks 2a-2g

**Files:**
- `tests/api/types.test.ts`

**Estimated scope:** S (1 file)

---

## Checkpoint: After Task 2h

- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `npm test` passes (scaffold + types tests)
- [ ] `npm run lint` passes
- [ ] All 6 response types + all sub-types defined
- [ ] All endpoint constants defined
- [ ] Commit with descriptive message

## Execution Order

Tasks 2b-2g can theoretically be written in any order since they all go in the same file, but writing them sequentially and running `typecheck` after each one catches errors early.

```
2a (endpoints) → 2b (shared) → 2c (user) → 2d (recovery) → 2e (sleep) → 2f (cycle) → 2g (workout) → 2h (test)
```

All tasks are XS-S, targeting a single focused session.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| OpenAPI spec has changed since we fetched it | 🟡 Medium | We downloaded the live spec today. Pin the types to what we see now; adjust if API calls fail in Task 4. |
| Optional vs required fields are wrong | 🟡 Medium | Cross-referenced every field against the `required` arrays in the OpenAPI `components/schemas`. |
| `v1_id` fields are being deprecated (09/01/2025) | 🟢 Low | Mark as optional — they may or may not be present. |

## Open Questions

None — the OpenAPI spec is authoritative for all type shapes.
