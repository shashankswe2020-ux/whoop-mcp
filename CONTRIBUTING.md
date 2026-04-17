# Contributing to whoop-mcp

Thanks for your interest in contributing! This guide covers the development setup, workflow, and conventions.

## Development Setup

```bash
git clone https://github.com/shashankswe2020-ux/whoop-mcp.git
cd whoop-mcp
npm install
```

### Verify everything works

```bash
npm test          # 202 tests passing
npm run build     # TypeScript compiles
npm run typecheck # No type errors
npm run lint      # No lint warnings
```

## Development Workflow

1. **Pick a task** — check `docs/specs/implementation-plan.md` for pending work
2. **Write failing tests first** (TDD) — place tests in `tests/` mirroring `src/` structure
3. **Implement the minimum code** to pass the tests
4. **Verify:** `npm test && npm run typecheck && npm run build && npm run lint`
5. **Commit** with a descriptive message: `feat: implement <component> — <brief description>`

### Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Build TypeScript |
| `npm test` | Run tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run typecheck` | Type check (`tsc --noEmit`) |
| `npm run lint` | Lint (ESLint) |
| `npm run lint:fix` | Lint + auto-fix |
| `npm run format` | Format (Prettier) |
| `npm run dev` | Run in dev mode (tsx) |

## Code Conventions

### Naming

| Element | Convention | Example |
|---------|-----------|---------|
| Files | `kebab-case.ts` | `token-store.ts` |
| Types/Interfaces | `PascalCase` | `RecoveryRecord` |
| Functions | `camelCase` | `getRecoveryCollection` |
| Constants | `SCREAMING_SNAKE_CASE` | `WHOOP_API_BASE_URL` |
| MCP tool names | `snake_case` | `get_recovery_collection` |

### Patterns

- **Named exports only** — no default exports
- **Explicit return types** on all exported functions
- **One tool per file** — handler + Zod schema co-located
- **Functional style** — no classes except where SDK requires
- **Strict TypeScript** — no `any`, strict mode enabled
- **Errors throw typed errors** — never return error codes

### Testing

- **TDD** — write tests before code
- **Prove-It pattern** for bugs — write a failing test first, then fix
- **Mock the WHOOP API** — never hit the real API in tests. Use `vi.fn()` for fetch.
- **Test hierarchy:** unit > integration > e2e (use the lowest level that captures the behavior)
- **Coverage target:** >80% on `src/auth/` and `src/api/`, >70% overall

## Boundaries

### Always

- Run `npm test` before every commit
- Validate all tool input with Zod schemas
- Store tokens securely (`0600` permissions)

### Ask First

- Adding any runtime dependency beyond `@modelcontextprotocol/sdk` and `zod`
- Changing the token storage location or format
- Adding new WHOOP API endpoints
- Changing the OAuth flow

### Never

- Commit secrets (`WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, or tokens)
- Use `any` in TypeScript
- Remove or skip failing tests without discussion
- Hit the real WHOOP API in tests

## Project References

| Document | Purpose |
|----------|---------|
| `docs/specs/whoop-mcp-server.md` | Full specification |
| `docs/specs/implementation-plan.md` | Task breakdown and dependency graph |
| `docs/github-governance.md` | Branch protection, dependency automation, and project backlog setup |
| `docs/plans/` | Detailed plans for each task |
| `docs/reviews/` | Code review checkpoints |
| `.github/copilot-instructions.md` | Project coding standards |

---

## GitHub Copilot Integration

This repository includes custom Copilot agents and skills for AI-assisted development. See [agent-usage-instructions.md](agent-usage-instructions.md) for the full guide, including all available agents, skills, and workflows.
