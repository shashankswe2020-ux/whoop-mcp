# Project: whoop-mcp

An MCP (Model Context Protocol) server that wraps the WHOOP REST API, enabling AI assistants to query health and fitness data through natural conversation.

## Tech Stack

- **Language:** TypeScript ~5.x (strict mode, no `any`)
- **Runtime:** Node.js >= 18 (native `fetch`)
- **MCP SDK:** `@modelcontextprotocol/sdk` (latest)
- **Validation:** Zod (for MCP tool input schemas)
- **Test Framework:** Vitest
- **Lint:** ESLint + `@typescript-eslint`
- **Formatter:** Prettier
- **Build:** `tsc` (no bundler)
- **Package Manager:** npm
- **No other runtime dependencies.** Keep the dependency tree minimal.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript
npm run dev          # Run in development (tsx)
npm test             # Run tests
npm test -- --coverage  # Tests with coverage
npm run lint         # Lint
npm run lint:fix     # Lint + fix
npm run format       # Format with Prettier
npm run typecheck    # Type check (no emit)
node dist/index.js   # Run MCP server (production)
```

## Project Structure

```
src/
├── index.ts                    # Entry point — creates MCP server, authenticates, starts stdio
├── server.ts                   # MCP server setup and tool registration
├── auth/
│   ├── oauth.ts                # OAuth2 Authorization Code flow
│   ├── token-store.ts          # Read/write/refresh tokens (~/.whoop-mcp/tokens.json)
│   └── callback-server.ts      # Temporary local HTTP server for OAuth callback
├── api/
│   ├── client.ts               # WHOOP API HTTP client (fetch + auth headers + retry)
│   ├── types.ts                # TypeScript types for all WHOOP API responses
│   └── endpoints.ts            # Endpoint URL constants
└── tools/
    ├── get-profile.ts          # Tool: get_profile
    ├── get-recovery.ts         # Tool: get_recovery_collection
    ├── get-sleep.ts            # Tool: get_sleep_collection
    ├── get-workout.ts          # Tool: get_workout_collection
    ├── get-cycle.ts            # Tool: get_cycle_collection
    └── get-body-measurement.ts # Tool: get_body_measurement

tests/                          # Mirrors src/ structure
├── auth/
├── api/
└── tools/
```

## Code Conventions

### Naming
- **Files:** `kebab-case.ts`
- **Types/Interfaces:** `PascalCase` (e.g., `RecoveryRecord`, `SleepCollection`)
- **Functions:** `camelCase` (e.g., `getRecoveryCollection`)
- **Constants:** `SCREAMING_SNAKE_CASE` (e.g., `WHOOP_API_BASE_URL`)
- **MCP tool names:** `snake_case` (MCP convention, e.g., `get_recovery_collection`)

### Patterns
- Explicit return types on all exported functions
- Zod for tool input validation (MCP SDK convention)
- One tool per file — handler + schema co-located
- Functional style — no classes except where SDK requires
- Named exports (no default exports)
- Errors throw typed errors, never return error codes
- Tests co-located in `tests/` directory mirroring `src/`

### Example — Tool Implementation Pattern

```typescript
// src/tools/get-recovery.ts
import { z } from "zod";
import { WhoopClient } from "../api/client.js";
import type { RecoveryCollection } from "../api/types.js";

export const getRecoveryCollectionSchema = {
  name: "get_recovery_collection",
  description:
    "Get recovery scores for a date range. Returns HRV, resting heart rate, SpO2, and skin temp.",
  inputSchema: z.object({
    start: z.string().optional().describe("ISO 8601 start time (inclusive)"),
    end: z.string().optional().describe("ISO 8601 end time (exclusive)"),
    limit: z.number().optional().describe("Max records (1-25). Default 10."),
  }),
};

export async function getRecoveryCollection(
  client: WhoopClient,
  params: { start?: string; end?: string; limit?: number }
): Promise<RecoveryCollection> {
  const searchParams = new URLSearchParams();
  if (params.start) searchParams.set("start", params.start);
  if (params.end) searchParams.set("end", params.end);
  if (params.limit) searchParams.set("limit", String(params.limit));
  return client.get<RecoveryCollection>(`/v2/recovery?${searchParams.toString()}`);
}
```

## Testing

- **TDD:** Write tests before code (Prove-It pattern for bugs)
- **Mock the WHOOP API:** Never hit the real API in tests. Use `vi.fn()` to mock `fetch`.
- **Test hierarchy:** unit > integration > e2e (use the lowest level that captures the behavior)
- **Coverage target:** >80% on `src/auth/` and `src/api/`, >70% overall
- **Run `npm test` after every change**

## WHOOP API Reference

- **Base URL:** `https://api.prod.whoop.com/developer`
- **OAuth Auth URL:** `https://api.prod.whoop.com/oauth/oauth2/auth`
- **OAuth Token URL:** `https://api.prod.whoop.com/oauth/oauth2/token`
- **Required Scopes:** `read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement`
- **All endpoints use v2.** Date params use ISO 8601. Collections default `limit=10` (max 25).

| MCP Tool | Endpoint | Method |
|----------|----------|--------|
| `get_profile` | `/v2/user/profile/basic` | GET |
| `get_recovery_collection` | `/v2/recovery` | GET |
| `get_sleep_collection` | `/v2/activity/sleep` | GET |
| `get_workout_collection` | `/v2/activity/workout` | GET |
| `get_cycle_collection` | `/v2/cycle` | GET |
| `get_body_measurement` | `/v2/user/measurement/body` | GET |

## Boundaries

### Always
- Run `npm test` before every commit
- Validate all tool input with Zod schemas
- Store tokens in `~/.whoop-mcp/` with `0600` permissions
- Return helpful error messages (Claude needs to understand failures)
- Build in small, verifiable increments: implement → test → verify → commit

### Ask First
- Adding any runtime dependency beyond `@modelcontextprotocol/sdk` and `zod`
- Changing the token storage location or format
- Adding WHOOP API endpoints not in the MVP 6 tools
- Changing the OAuth flow
- Database schema changes

### Never
- Commit `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, or tokens
- Store tokens in a world-readable location
- Make real WHOOP API calls in automated tests
- Use `any` — strict TypeScript throughout
- Remove or skip failing tests without discussion
- Mix formatting changes with behavior changes

## Implementation Status

> **Current phase:** Tasks 1–4 complete — scaffold, API types, token store, and API client in place.
> **Next task:** Task 5 — OAuth2 Flow (`src/auth/oauth.ts`, `src/auth/callback-server.ts`)
> **Plan:** `docs/plans/task-5-oauth-flow.md`
> **Spec:** `docs/specs/whoop-mcp-server.md`
> **Implementation plan:** `docs/specs/implementation-plan.md`

## Active Task Context: Task 5 — OAuth2 Flow

### What We're Building
OAuth2 Authorization Code flow for WHOOP API authentication. Two files:
1. **`src/auth/callback-server.ts`** — temporary local HTTP server that captures the OAuth redirect code, then shuts down.
2. **`src/auth/oauth.ts`** — orchestrates the full flow: build auth URL → open browser → wait for code → exchange for tokens → save to store. Also handles token refresh.

This is the **highest-risk task** — browser redirect + local HTTP server + real-time coordination. We mitigate by building the callback server in isolation first, then wiring it into the orchestrator.

### API Surface — callback-server.ts
```typescript
interface CallbackResult { code: string; state: string; }

interface CallbackServerOptions {
  port?: number;           // Default: 3000
  expectedState: string;   // CSRF state to validate
  timeoutMs?: number;      // Default: 120_000 (2 min)
}

function startCallbackServer(options: CallbackServerOptions): Promise<CallbackResult>;
```

### API Surface — oauth.ts
```typescript
interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;    // Default: WHOOP_REDIRECT_URI from endpoints.ts
  tokenDir?: string;       // Default: ~/.whoop-mcp/
  port?: number;           // Default: 3000
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

function authenticate(config: OAuthConfig): Promise<string>;
function buildAuthorizationUrl(config: OAuthConfig, state: string): string;
function exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<TokenResponse>;
function refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<TokenResponse>;
function toOAuthTokens(response: TokenResponse): OAuthTokens;
function openBrowser(url: string): void;
```

### Files to Create
- `src/auth/callback-server.ts` — exports: `CallbackResult`, `CallbackServerOptions`, `startCallbackServer`
- `src/auth/oauth.ts` — exports: `OAuthConfig`, `TokenResponse`, `authenticate`, `buildAuthorizationUrl`, `exchangeCodeForTokens`, `refreshAccessToken`, `toOAuthTokens`, `openBrowser`
- `tests/auth/oauth.test.ts` — tests for all of the above

### Key Design Decisions
- **Two files, not one** — callback server is independently testable
- **`node:http` for callback server** — no Express. Handles exactly one request then shuts down. Zero deps.
- **`node:child_process.exec` for browser** — `open` (macOS), `xdg-open` (Linux), `start` (Windows). Best-effort, log URL on failure.
- **State parameter for CSRF** — random `state` via `node:crypto.randomBytes`, validated in callback
- **Token exchange uses `application/x-www-form-urlencoded`** — per OAuth2 spec, NOT JSON
- **`authenticate()` is the main entry point** — checks existing tokens → refreshes if expired → full flow if needed
- **Environment variables for client creds** — `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `WHOOP_REDIRECT_URI`
- **Configurable port** — defaults to 3000, tests use random high ports to avoid conflicts

### Subtask Order (TDD — tests first)
1. **5a:** Callback server happy path (start server, receive code+state, shut down)
2. **5b:** Callback server error cases (state mismatch, missing code, OAuth error, timeout)
3. **5c:** `buildAuthorizationUrl()` (pure function, URL construction)
4. **5d:** `exchangeCodeForTokens()` (POST to token endpoint, mock fetch)
5. **5e:** `refreshAccessToken()` (POST with refresh_token, mock fetch)
6. **5f:** `toOAuthTokens()` (convert TokenResponse → OAuthTokens, mock Date.now)
7. **5g:** `openBrowser()` (platform-specific exec, mock child_process)
8. **5h:** `authenticate()` orchestrator (4 scenarios: valid tokens, expired→refresh, no tokens→full flow, refresh fails→full flow)
9. **5i:** Final verification (all tests + typecheck + lint + build)

### Dependencies (already complete)
- `src/auth/token-store.ts` ✅ — `OAuthTokens`, `loadTokens`, `saveTokens`, `isTokenExpired`
- `src/api/endpoints.ts` ✅ — `WHOOP_AUTH_URL`, `WHOOP_TOKEN_URL`, `WHOOP_REQUIRED_SCOPES`, `WHOOP_REDIRECT_URI`
- `src/api/client.ts` ✅ — NOT imported by oauth.ts (oauth uses raw fetch for token exchange)

### Consumed By (don't build these yet)
- `src/index.ts` (Task 9) — calls `authenticate()` on startup
- `src/server.ts` (Task 6) — may call refresh during long-running session

### Gotchas
- Callback server tests: use random high ports (`0` for OS-assigned) to avoid port conflicts in CI
- Mock `fetch` with `vi.stubGlobal("fetch", vi.fn())` for token exchange
- Mock `node:child_process` with `vi.mock("node:child_process")` for browser open
- Mock `token-store` functions with `vi.mock("../auth/token-store.js")` in orchestrator tests
- Mock `callback-server` with `vi.mock("./callback-server.js")` in orchestrator tests
- Token exchange body is `application/x-www-form-urlencoded`, NOT JSON — use `URLSearchParams`
- `toOAuthTokens` needs `vi.spyOn(Date, "now")` for deterministic `expires_at` assertions
- Server must close in ALL cases (success, error, timeout) — use `try/finally`
- The callback HTML response should tell the user auth succeeded/failed (they see it in browser)

### Verification
```bash
npm test -- tests/auth/oauth.test.ts                           # After each subtask
npm test && npm run typecheck && npm run lint && npm run build  # After 5i (final)
```

## Implementation Order

1. Project scaffold (package.json, tsconfig, eslint, vitest)
2. WHOOP API types (`src/api/types.ts`, `src/api/endpoints.ts`)
3. Token store (`src/auth/token-store.ts`)
4. API client (`src/api/client.ts`)
5. OAuth flow (`src/auth/oauth.ts`, `src/auth/callback-server.ts`)
6. MCP server shell (`src/server.ts`)
7. Tool implementations (7a-7f, can be parallel after step 6)
8. Error handling (retry 429, re-auth 401)
9. Entry point + CLI (`src/index.ts`)
10. Docs + publish prep
