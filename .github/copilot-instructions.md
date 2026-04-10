# Project: whoop-mcp

An MCP server wrapping the WHOOP REST API for AI assistant access to health/fitness data.

## Tech Stack
- TypeScript ~5.x (strict, no `any`), Node.js >= 18, native `fetch`
- `@modelcontextprotocol/sdk`, Zod, Vitest, ESLint, Prettier
- Build: `tsc` — no bundler. No runtime deps beyond SDK + Zod.

## Commands
```bash
npm run build       # Build TypeScript
npm test            # Run tests (Vitest)
npm run lint        # ESLint
npm run lint:fix    # ESLint + fix
npm run format      # Prettier
npm run typecheck   # tsc --noEmit
npm run dev         # Dev mode (tsx)
```

## Code Conventions
- Files: `kebab-case.ts` | Types: `PascalCase` | Functions: `camelCase` | Constants: `SCREAMING_SNAKE_CASE`
- MCP tool names: `snake_case` (MCP convention)
- Named exports only (no default exports)
- Explicit return types on all exported functions
- One tool per file — handler + Zod schema co-located
- Errors throw typed errors, never return error codes
- Tests mirror `src/` structure in `tests/` directory

## Testing
- Write tests before code (TDD)
- For bugs: write a failing test first, then fix (Prove-It pattern)
- Test hierarchy: unit > integration > e2e (use the lowest level that captures the behavior)
- Mock the WHOOP API — never hit real API in tests. Use `vi.fn()` for fetch.
- Coverage target: >80% on `src/auth/` and `src/api/`, >70% overall
- Run `npm test` after every change

## Code Quality
- Review across five axes: correctness, readability, architecture, security, performance
- Every PR must pass: lint, type check, tests, build
- No secrets in code or version control

## Implementation
- Build in small, verifiable increments
- Each increment: implement → test → verify → commit
- Never mix formatting changes with behavior changes

## Key References
- **Spec:** `docs/specs/whoop-mcp-server.md`
- **Implementation plan:** `docs/specs/implementation-plan.md`
- **Code review:** `docs/reviews/code-review-checkpoint-1.md` (Tasks 1–5 approved)
- **WHOOP API base:** `https://api.prod.whoop.com/developer` (v2 endpoints)
- **OAuth:** Authorization Code flow, tokens at `~/.whoop-mcp/tokens.json` (0600 perms)

## Implementation Status
- Tasks 1–8 complete (scaffold, types, token store, API client, OAuth, MCP server shell, tool implementations, error handling)
- 169 tests passing, typecheck clean, build clean, lint clean
- **Next:** Task 9 — Entry point + CLI (`src/index.ts`)
- After that: Task 10 (docs + publish prep)

## Task 9 Context — Entry Point + CLI

### Goal
Wire everything together in `src/index.ts`. Start OAuth if needed, create API client, create MCP server, connect stdio transport. Must work as `node dist/index.js` and `npx whoop-mcp`.

### Current `src/index.ts` (stub)
```typescript
#!/usr/bin/env node
async function main(): Promise<void> {
  // TODO: Initialize OAuth, create API client, start MCP server
}
main().catch((error: unknown) => { console.error("Fatal error:", error); process.exit(1); });
```

### What `main()` must do
1. Read `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` from `process.env`
2. Call `authenticate({ clientId, clientSecret })` → returns `accessToken`
3. Create `WhoopClient` via `createWhoopClient({ accessToken, onTokenRefresh })` — `onTokenRefresh` should call `refreshAccessToken` with stored refresh token
4. Call `createWhoopServer(client)` → returns `McpServer`
5. Connect server to `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`
6. Log startup to stderr (never stdout — stdout is the MCP stdio channel)

### Key APIs available
- `authenticate(config: OAuthConfig): Promise<string>` — from `src/auth/oauth.ts`
- `refreshAccessToken(refreshToken, config): Promise<TokenResponse>` — from `src/auth/oauth.ts`
- `loadTokens(tokenDir?): Promise<OAuthTokens | null>` — from `src/auth/token-store.ts`
- `saveTokens(tokens, tokenDir?): Promise<void>` — from `src/auth/token-store.ts`
- `toOAuthTokens(response: TokenResponse): OAuthTokens` — from `src/auth/oauth.ts`
- `createWhoopClient(options: WhoopClientOptions): WhoopClient` — from `src/api/client.ts`
- `createWhoopServer(client: WhoopClient): McpServer` — from `src/server.ts`
- `StdioServerTransport` — from `@modelcontextprotocol/sdk/server/stdio.js`

### Claude Desktop config example
```jsonc
{
  "mcpServers": {
    "whoop": {
      "command": "npx",
      "args": ["whoop-mcp"],
      "env": {
        "WHOOP_CLIENT_ID": "your_client_id",
        "WHOOP_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

### Acceptance Criteria
- `node dist/index.js` starts the MCP server on stdio
- `npx whoop-mcp` works after npm publish (bin field already set in package.json)
- All stderr logging, never stdout (stdout = MCP transport)
- Claude Desktop can connect and use all 6 tools
- Verify: `npm run build && node dist/index.js` + MCP Inspector test

### Package.json bin field (already configured)
```json
"bin": { "whoop-mcp": "dist/index.js" }
```

## Boundaries
- **Always:** Run tests before commits, validate input with Zod, store tokens securely (0600)
- **Ask first:** New runtime dependencies, token storage changes, new API endpoints, OAuth flow changes
- **Never:** Commit secrets, remove failing tests, skip verification, use `any`, hit real WHOOP API in tests
