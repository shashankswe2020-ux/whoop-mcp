# Task 5 Plan: OAuth2 Flow

> **Parent spec:** `docs/specs/implementation-plan.md` → Task 5
> **Depends on:** Task 1 (scaffold) ✅, Task 2 (types) ✅, Task 3 (token store) ✅, Task 4 (API client) ✅
> **Consumed by:** Task 6 (MCP server shell — calls authenticate on startup), Task 9 (entry point — orchestrates auth before server start)
> **Created:** 2026-04-11

---

## Overview

Implement the OAuth2 Authorization Code flow for authenticating with the WHOOP API. This involves three main pieces:

1. **Callback server** (`callback-server.ts`) — A temporary local HTTP server that listens for the OAuth redirect, captures the authorization code, and shuts down.
2. **OAuth orchestrator** (`oauth.ts`) — Builds the authorization URL, opens the user's browser, waits for the code from the callback server, exchanges it for tokens via the WHOOP token endpoint, saves tokens to the token store, and handles token refresh when the access token expires.

This is the **highest-risk task** in the project — it involves a browser redirect, a local HTTP server, and real-time coordination between them. We mitigate risk by building the callback server in isolation first, then wiring it into the orchestrator.

## Architecture Decisions

- **Two files, not one** — `callback-server.ts` handles only the HTTP server lifecycle. `oauth.ts` orchestrates the full flow. This separation makes the callback server independently testable.
- **`node:http` for the callback server** — No express or other dependency. A minimal HTTP server that handles exactly one request (the OAuth redirect) and shuts down. Keeps the zero-dependency constraint.
- **`node:child_process.exec` for browser open** — Uses platform-specific commands (`open` on macOS, `xdg-open` on Linux, `start` on Windows) to open the authorization URL. This is a best-effort operation — if it fails, we log the URL for manual copy/paste.
- **State parameter for CSRF protection** — Generate a random `state` value, include it in the authorization URL, and validate it in the callback. Reject mismatched state values.
- **Token refresh is a separate function** — `refreshAccessToken()` takes a refresh token, calls the WHOOP token endpoint, and returns new tokens. Called by the orchestrator when `isTokenExpired()` returns true.
- **`authenticate()` is the main entry point** — Checks for existing tokens, refreshes if expired, starts full OAuth flow if no valid tokens exist. Returns a valid `access_token` string ready for the API client.
- **Environment variables for client credentials** — `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, and optionally `WHOOP_REDIRECT_URI` are read from `process.env`. Missing credentials throw a descriptive error.
- **Token exchange uses `application/x-www-form-urlencoded`** — Per OAuth2 spec, the token endpoint expects form-encoded POST bodies, not JSON.
- **Configurable port for callback server** — Defaults to 3000 but can be overridden for testing. The redirect URI is derived from the port.

## Dependency Graph

```
src/auth/callback-server.ts
  ├── imports: node:http (stdlib)
  └── imports: node:url (stdlib)

src/auth/oauth.ts
  ├── imports: callback-server.ts (startCallbackServer)
  ├── imports: token-store.ts (loadTokens, saveTokens, isTokenExpired)
  ├── imports: endpoints.ts (WHOOP_AUTH_URL, WHOOP_TOKEN_URL, WHOOP_REQUIRED_SCOPES, WHOOP_REDIRECT_URI)
  ├── imports: node:crypto (randomBytes for state)
  ├── imports: node:child_process (exec for browser open)
  └── uses: global fetch (token exchange POST)

tests/auth/oauth.test.ts
  ├── mocks: global fetch (token exchange)
  ├── mocks: callback-server (startCallbackServer)
  ├── mocks: token-store (loadTokens, saveTokens, isTokenExpired)
  ├── mocks: node:child_process (exec — browser open)
  └── imports: src/auth/oauth.ts

Consumed by:
  → src/index.ts (Task 9) — calls authenticate() on startup
  → src/server.ts (Task 6) — may call refresh during long-running session
```

## OAuth2 Flow Sequence

```
┌─────────┐     ┌──────────┐     ┌─────────┐     ┌──────────┐
│  User    │     │ oauth.ts │     │callback- │     │  WHOOP   │
│ (browser)│     │          │     │server.ts │     │  API     │
└────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │                 │
     │     authenticate()              │                 │
     │     ───────────>│               │                 │
     │                │  startCallbackServer()           │
     │                │───────────────>│                 │
     │                │  (listening on port 3000)        │
     │                │<───────────────│                 │
     │   open browser │                │                 │
     │<───────────────│                │                 │
     │                │                │                 │
     │  user authorizes on WHOOP       │                 │
     │────────────────────────────────>│                 │
     │                │  redirect: /callback?code=X&state=Y
     │                │                │                 │
     │                │  resolves with code              │
     │                │<───────────────│                 │
     │                │  (server shuts down)             │
     │                │                │                 │
     │                │  POST /oauth/oauth2/token        │
     │                │────────────────────────────────>│
     │                │  { access_token, refresh_token } │
     │                │<────────────────────────────────│
     │                │                │                 │
     │                │  saveTokens()  │                 │
     │                │                │                 │
     │  returns access_token           │                 │
     │<───────────────│                │                 │
```

## API Surface

### callback-server.ts

```typescript
/** Result from the callback server after receiving the OAuth redirect */
export interface CallbackResult {
  code: string;
  state: string;
}

/** Options for the callback server */
export interface CallbackServerOptions {
  port?: number;          // Default: 3000
  expectedState: string;  // State parameter to validate against
  timeoutMs?: number;     // How long to wait before timing out. Default: 120_000 (2 min)
}

/**
 * Start a temporary HTTP server that waits for the OAuth callback.
 * Returns a promise that resolves with the authorization code.
 * The server shuts down automatically after receiving the callback or timing out.
 */
export function startCallbackServer(options: CallbackServerOptions): Promise<CallbackResult>;
```

### oauth.ts

```typescript
/** Configuration for the OAuth flow */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;   // Default: WHOOP_REDIRECT_URI from endpoints.ts
  tokenDir?: string;      // Default: ~/.whoop-mcp/ (passed through to token store)
  port?: number;          // Default: 3000
}

/** Raw token response from the WHOOP token endpoint */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

/**
 * Main entry point. Returns a valid access token.
 * - If tokens exist and are valid → returns access_token
 * - If tokens exist but expired → refreshes and returns new access_token
 * - If no tokens or refresh fails → starts full OAuth flow
 */
export function authenticate(config: OAuthConfig): Promise<string>;

/**
 * Build the WHOOP authorization URL with all required parameters.
 */
export function buildAuthorizationUrl(config: OAuthConfig, state: string): string;

/**
 * Exchange an authorization code for tokens.
 */
export function exchangeCodeForTokens(
  code: string,
  config: OAuthConfig,
): Promise<TokenResponse>;

/**
 * Use the refresh token to obtain a new access token.
 */
export function refreshAccessToken(
  refreshToken: string,
  config: OAuthConfig,
): Promise<TokenResponse>;

/**
 * Convert the raw TokenResponse into our OAuthTokens shape for storage.
 */
export function toOAuthTokens(response: TokenResponse): OAuthTokens;

/**
 * Open a URL in the user's default browser (best-effort).
 */
export function openBrowser(url: string): void;
```

## Task List

### Task 5a: Callback server — successful flow

**Description:** Implement the temporary HTTP callback server that listens for the OAuth redirect and captures the authorization code. Handles the happy path: redirect arrives with `code` and matching `state`.

**Acceptance criteria:**
- [ ] `startCallbackServer()` starts an HTTP server on the specified port (default 3000)
- [ ] Server responds to `GET /callback?code=X&state=Y` with an HTML success page
- [ ] Promise resolves with `{ code, state }` from the query parameters
- [ ] Server shuts down after receiving the callback
- [ ] Tests use a random high port to avoid conflicts

**Verification:** `npm test -- tests/auth/oauth.test.ts`

**Dependencies:** None (standalone module)

**Files:**
- `src/auth/callback-server.ts`
- `tests/auth/oauth.test.ts` (partial — callback server tests)

**Estimated scope:** S (1 file, ~50 lines of code + ~40 lines of test)

---

### Task 5b: Callback server — error cases

**Description:** Handle error cases in the callback server: state mismatch, missing code, OAuth error response from WHOOP, and timeout.

**Acceptance criteria:**
- [ ] Rejects with an error if `state` in callback doesn't match `expectedState`
- [ ] Rejects with an error if `code` is missing from the callback query
- [ ] Rejects with an error if WHOOP sends `error` and `error_description` in the callback
- [ ] Rejects with a timeout error if no callback arrives within `timeoutMs`
- [ ] Server is cleaned up (closed) in all error cases
- [ ] Server responds with an appropriate HTML error page to the browser in error cases

**Verification:** `npm test -- tests/auth/oauth.test.ts`

**Dependencies:** Task 5a

**Files:**
- `src/auth/callback-server.ts` (modify — add error handling)
- `tests/auth/oauth.test.ts` (add error case tests)

**Estimated scope:** S (same files, ~30 lines of code + ~50 lines of test)

---

### Task 5c: Build authorization URL

**Description:** Implement `buildAuthorizationUrl()` that constructs the WHOOP OAuth authorization URL with all required parameters.

**Acceptance criteria:**
- [ ] URL base is `WHOOP_AUTH_URL` from endpoints
- [ ] Includes `response_type=code`
- [ ] Includes `client_id` from config
- [ ] Includes `redirect_uri` (defaults to `WHOOP_REDIRECT_URI`)
- [ ] Includes `scope` with all required scopes from `WHOOP_REQUIRED_SCOPES`
- [ ] Includes `state` parameter for CSRF protection
- [ ] URL is properly encoded

**Verification:** `npm test -- tests/auth/oauth.test.ts`

**Dependencies:** None (pure function using constants from endpoints.ts)

**Files:**
- `src/auth/oauth.ts` (partial — buildAuthorizationUrl + config types)
- `tests/auth/oauth.test.ts` (add URL builder tests)

**Estimated scope:** XS (1 function, ~15 lines of code + ~30 lines of test)

---

### Task 5d: Token exchange — code for tokens

**Description:** Implement `exchangeCodeForTokens()` that POSTs to the WHOOP token endpoint with the authorization code and returns the token response.

**Acceptance criteria:**
- [ ] POSTs to `WHOOP_TOKEN_URL` with `application/x-www-form-urlencoded` content type
- [ ] Body includes `grant_type=authorization_code`, `code`, `client_id`, `client_secret`, `redirect_uri`
- [ ] Successful response is parsed and returned as `TokenResponse`
- [ ] Non-2xx response throws a descriptive error (e.g., invalid code)
- [ ] Tests mock `fetch` — no real API calls

**Verification:** `npm test -- tests/auth/oauth.test.ts`

**Dependencies:** Task 5c (needs OAuthConfig type)

**Files:**
- `src/auth/oauth.ts` (add exchangeCodeForTokens + TokenResponse type)
- `tests/auth/oauth.test.ts` (add token exchange tests)

**Estimated scope:** S (1 function, ~25 lines of code + ~40 lines of test)

---

### Task 5e: Token refresh

**Description:** Implement `refreshAccessToken()` that uses the refresh token to obtain a new access token from the WHOOP token endpoint.

**Acceptance criteria:**
- [ ] POSTs to `WHOOP_TOKEN_URL` with `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`
- [ ] Uses `application/x-www-form-urlencoded` content type
- [ ] Successful response is parsed and returned as `TokenResponse`
- [ ] Non-2xx response throws a descriptive error (e.g., invalid/expired refresh token)
- [ ] Tests mock `fetch` — no real API calls

**Verification:** `npm test -- tests/auth/oauth.test.ts`

**Dependencies:** Task 5d (shares TokenResponse type, same pattern)

**Files:**
- `src/auth/oauth.ts` (add refreshAccessToken)
- `tests/auth/oauth.test.ts` (add refresh tests)

**Estimated scope:** XS (1 function, ~20 lines of code + ~30 lines of test)

---

### Task 5f: Token conversion helper

**Description:** Implement `toOAuthTokens()` that converts the raw `TokenResponse` from the WHOOP API into our `OAuthTokens` shape for storage (computing `expires_at` from `expires_in`).

**Acceptance criteria:**
- [ ] Converts `expires_in` (seconds) to `expires_at` (epoch ms): `Date.now() + expires_in * 1000`
- [ ] Copies `access_token`, `refresh_token`, `token_type` directly
- [ ] Tests use a fixed `Date.now()` mock for deterministic assertions

**Verification:** `npm test -- tests/auth/oauth.test.ts`

**Dependencies:** Task 3 (uses `OAuthTokens` type from token-store)

**Files:**
- `src/auth/oauth.ts` (add toOAuthTokens)
- `tests/auth/oauth.test.ts` (add conversion tests)

**Estimated scope:** XS (1 function, ~10 lines of code + ~15 lines of test)

---

### Task 5g: Open browser helper

**Description:** Implement `openBrowser()` that opens a URL in the user's default browser. Best-effort — failure is logged, not thrown.

**Acceptance criteria:**
- [ ] On macOS, calls `open <url>`
- [ ] On Linux, calls `xdg-open <url>`
- [ ] On Windows, calls `start <url>`
- [ ] Does not throw if the open command fails (logs the URL for manual copy/paste instead)
- [ ] Tests mock `child_process.exec` — no real browser opens

**Verification:** `npm test -- tests/auth/oauth.test.ts`

**Dependencies:** None

**Files:**
- `src/auth/oauth.ts` (add openBrowser)
- `tests/auth/oauth.test.ts` (add browser tests)

**Estimated scope:** XS (1 function, ~15 lines of code + ~20 lines of test)

---

### Task 5h: authenticate() orchestrator — happy paths

**Description:** Implement the main `authenticate()` function that orchestrates the full flow: check existing tokens → refresh if expired → full OAuth flow if needed.

**Acceptance criteria:**
- [ ] If valid (non-expired) tokens exist on disk, returns the `access_token` without any network calls
- [ ] If tokens exist but are expired, calls `refreshAccessToken()`, saves new tokens, returns new `access_token`
- [ ] If no tokens exist, runs the full OAuth flow: starts callback server → opens browser → waits for code → exchanges code → saves tokens → returns `access_token`
- [ ] If refresh fails (e.g., refresh token also expired), falls back to full OAuth flow
- [ ] Client credentials (`WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`) are required — throws a clear error if missing
- [ ] All interactions with token store, callback server, and fetch are mocked in tests

**Verification:** `npm test -- tests/auth/oauth.test.ts`

**Dependencies:** Tasks 5a–5g (uses all sub-functions)

**Files:**
- `src/auth/oauth.ts` (add authenticate)
- `tests/auth/oauth.test.ts` (add orchestrator tests)

**Estimated scope:** M (1 function ~40 lines, but ~80 lines of test covering 4 scenarios)

---

### Task 5i: Final verification

**Description:** Full pipeline check. Confirm all tests pass, typecheck clean, lint clean, build clean. No regressions in Tasks 1–4.

**Acceptance criteria:**
- [ ] All OAuth tests pass: `npm test -- tests/auth/oauth.test.ts`
- [ ] All token store tests still pass: `npm test -- tests/auth/token-store.test.ts`
- [ ] Full suite passes: `npm test`
- [ ] Build clean: `npm run build`
- [ ] Typecheck clean: `npm run typecheck`
- [ ] Lint clean: `npm run lint`

**Verification:** `npm test && npm run typecheck && npm run lint && npm run build`

**Dependencies:** Tasks 5a–5h

**Files:** None (verification only)

**Estimated scope:** XS (no code changes)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| OAuth callback server port 3000 is in use | 🟡 Medium | Make port configurable. Tests use random high ports. Document the default port. |
| Browser open fails silently in headless/CI environments | 🟢 Low | `openBrowser()` is best-effort. Log the authorization URL so user can copy/paste. |
| WHOOP token endpoint requires PKCE (Proof Key for Code Exchange) | 🟡 Medium | Start without PKCE. If WHOOP returns errors, add `code_verifier`/`code_challenge` in a follow-up. The architecture supports adding PKCE without restructuring. |
| State parameter race condition — user opens two auth flows simultaneously | 🟢 Low | Out of scope for MVP. Single-user, single-process assumption. |
| Token exchange fails with vague WHOOP error | 🟡 Medium | Parse error body from WHOOP response. Include `error` and `error_description` in thrown error message for debugging. |
| Callback server doesn't shut down cleanly on error | 🟡 Medium | Use `finally` block / timeout to ensure `server.close()` is always called. Tested in 5b. |
| `node:child_process` import may need special handling in tests | 🟢 Low | Mock with `vi.mock("node:child_process")`. Vitest supports this natively. |

## Open Questions

- Does WHOOP require PKCE? The spec's open questions mention this. Start without it; add if needed.
- What are the exact token lifetimes? Affects how often refresh is needed. The 60s buffer in `isTokenExpired()` should handle reasonable lifetimes.
- Does the WHOOP token endpoint return `scope` in the response? If so, validate it matches required scopes.

## Checkpoint: After Task 5i

- [ ] All OAuth tests pass: `npm test -- tests/auth/oauth.test.ts`
- [ ] All token store tests pass: `npm test -- tests/auth/token-store.test.ts`
- [ ] All API client tests pass: `npm test -- tests/api/client.test.ts`
- [ ] Full suite passes: `npm test`
- [ ] Build clean: `npm run build`
- [ ] Typecheck clean: `npm run typecheck`
- [ ] Lint clean: `npm run lint`
- [ ] Exports: `authenticate`, `buildAuthorizationUrl`, `exchangeCodeForTokens`, `refreshAccessToken`, `toOAuthTokens`, `openBrowser`, `startCallbackServer`, `CallbackResult`, `CallbackServerOptions`, `OAuthConfig`, `TokenResponse`
- [ ] No secrets committed
- [ ] **Manual test ready:** After Task 5i, can manually test the full OAuth flow with real WHOOP credentials (separate from automated tests)
