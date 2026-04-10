# Task 1 Plan: Project Scaffold

> **Parent spec:** `docs/specs/implementation-plan.md` → Task 1
> **Status:** ✅ Complete (committed `fe8f284`)
> **Created:** 2026-04-10 (retroactive — plan was executed inline)

---

## Overview

Initialize a buildable, testable, lintable TypeScript project with all tooling configured. This is the foundation every other task depends on. No business logic — just the skeleton that proves `build`, `test`, `typecheck`, `lint`, and `format` all work.

## Architecture Decisions

- **ESM-only (`"type": "module"`)** — Node 18+ supports ESM natively; aligns with `@modelcontextprotocol/sdk` which is ESM.
- **`NodeNext` module resolution** — required for `.js` extension imports in TypeScript ESM projects.
- **Flat ESLint config (`eslint.config.js`)** — ESLint 9 uses the new flat config format. No `.eslintrc.json`.
- **Strict TypeScript beyond `strict: true`** — added `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch` for maximum safety.
- **v8 coverage provider** — Vitest's built-in v8 provider (no extra dependency needed).
- **70% coverage thresholds** — matches the spec's "70% overall" floor in `vitest.config.ts`.
- **`bin` field set to `dist/index.js`** — enables `npx whoop-mcp` after npm publish.

## Task List

### Task 1a: Package identity + scripts (`package.json`)

**Description:** Create `package.json` with project metadata, all npm scripts, runtime dependencies (`@modelcontextprotocol/sdk`, `zod`), and dev dependencies (TypeScript, ESLint, Prettier, Vitest, tsx).

**Acceptance criteria:**
- [x] `name`, `version`, `description`, `license`, `engines` set
- [x] `"type": "module"` for ESM
- [x] `main`, `types`, `bin`, `files` configured for npm publish
- [x] All 10 scripts: `build`, `dev`, `test`, `test:watch`, `test:coverage`, `lint`, `lint:fix`, `format`, `format:check`, `typecheck`
- [x] Only 2 runtime deps: `@modelcontextprotocol/sdk`, `zod`
- [x] Dev deps: `@types/node`, `@typescript-eslint/*`, `eslint`, `prettier`, `tsx`, `typescript`, `vitest`

**Files:** `package.json`

**Estimated scope:** XS

---

### Task 1b: TypeScript config (`tsconfig.json`)

**Description:** Configure TypeScript compiler for strict ESM Node.js development with declaration output.

**Acceptance criteria:**
- [x] `target: ESNext`, `module: NodeNext`, `moduleResolution: NodeNext`
- [x] `strict: true` plus additional safety flags
- [x] `declaration: true`, `declarationMap: true`, `sourceMap: true`
- [x] `outDir: dist`, `rootDir: src`
- [x] Tests excluded from compilation (`exclude: ["tests"]`)

**Files:** `tsconfig.json`

**Estimated scope:** XS

---

### Task 1c: Linting + formatting (ESLint + Prettier)

**Description:** Configure ESLint with TypeScript rules (flat config) and Prettier for consistent formatting.

**Acceptance criteria:**
- [x] ESLint flat config (`eslint.config.js`) — not legacy `.eslintrc`
- [x] `no-explicit-any: error` — enforces the "no `any`" rule from the spec
- [x] `explicit-function-return-type: error` — enforces explicit return types on exports
- [x] `no-unused-vars` with `argsIgnorePattern: "^_"` — allows intentional unused params
- [x] `no-console: warn` (allows `console.warn` and `console.error`)
- [x] Prettier: double quotes, 2-space indent, 100 char width, trailing commas

**Files:** `eslint.config.js`, `.prettierrc`

**Estimated scope:** XS

---

### Task 1d: Test framework (`vitest.config.ts`)

**Description:** Configure Vitest for Node.js testing with coverage thresholds.

**Acceptance criteria:**
- [x] `environment: "node"`
- [x] Test pattern: `tests/**/*.test.ts`
- [x] v8 coverage on `src/**/*.ts` (excluding `src/index.ts`)
- [x] 70% threshold on lines, functions, branches, statements

**Files:** `vitest.config.ts`

**Estimated scope:** XS

---

### Task 1e: Project hygiene (`.gitignore`, `.env.example`)

**Description:** Set up gitignore for Node/TypeScript project and env example with WHOOP credential placeholders.

**Acceptance criteria:**
- [x] Ignores: `node_modules/`, `dist/`, `.env`, `*.tsbuildinfo`, `coverage/`, `tokens.json`
- [x] `.env.example` has `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `WHOOP_REDIRECT_URI`

**Files:** `.gitignore`, `.env.example`

**Estimated scope:** XS

---

### Task 1f: Placeholder entry point + test

**Description:** Create a minimal `src/index.ts` and `tests/scaffold.test.ts` so build and test commands pass.

**Acceptance criteria:**
- [x] `src/index.ts` has shebang (`#!/usr/bin/env node`), async `main()`, error handler
- [x] `tests/scaffold.test.ts` has one passing test
- [x] `npm run build` produces `dist/index.js`
- [x] `npm test` shows 1 passing test

**Files:** `src/index.ts`, `tests/scaffold.test.ts`

**Estimated scope:** XS

---

## Checkpoint: Task 1 Complete ✅

All verified on 2026-04-10:

- [x] `npm run build` — compiles clean
- [x] `npm test` — 1 test passed
- [x] `npm run typecheck` — no errors
- [x] `npm run lint` — no warnings
- [x] `npm run format:check` — all files formatted
- [x] Committed: `fe8f284`

## Files Delivered

| File | Purpose |
|------|---------|
| `package.json` | Project identity, scripts, deps (248 packages installed) |
| `package-lock.json` | Dependency lockfile |
| `tsconfig.json` | Strict TypeScript ESM config |
| `eslint.config.js` | ESLint 9 flat config with TS rules |
| `.prettierrc` | Formatting rules |
| `vitest.config.ts` | Test runner config with coverage thresholds |
| `.gitignore` | Ignores node_modules, dist, env, tokens |
| `.env.example` | WHOOP credential placeholders |
| `src/index.ts` | Placeholder entry point |
| `tests/scaffold.test.ts` | Placeholder test |

## Deviations from Original Spec

| Spec said | What we did | Why |
|-----------|-------------|-----|
| `.eslintrc.json` | `eslint.config.js` (flat config) | ESLint 9 uses flat config; `.eslintrc` is legacy |
| No `@types/node` mentioned | Added `@types/node` to devDeps | Required for `process`, `console` in Node.js TypeScript |
| No `format:check` script | Added `format:check` alongside `format` | Needed for CI — check without writing |
| No `test:watch` script | Added `test:watch` | Convenience for TDD workflow |
