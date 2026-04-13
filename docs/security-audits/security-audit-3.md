# Security Audit Report #3

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-04-13
> **Scope:** Incremental review of commit `76deb2d` (fix: persist OAuth tokens across Claude Desktop restarts) — `src/auth/oauth.ts`, `src/auth/token-store.ts`, `src/index.ts`, and associated test files
> **Dependencies:** 0 known vulnerabilities (`npm audit` clean)

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 2 |
| Info | 2 |

---

## Previous Audit Findings Status

Carried-over findings from Audit #2 (2026-04-12) relevant to this change scope:

| Finding | Status |
|---------|--------|
| Audit #2 LOW-1: Missing security response headers on callback server | ⚠️ **OPEN** — Not addressed by this commit |
| Audit #2 LOW-2: Windows `cmd /c start` lacks empty title guard | ⚠️ **OPEN** — Not addressed by this commit |
| Audit #2 LOW-3: PKCE not implemented (carried from Audit #1) | ⚠️ **OPEN** — Not addressed by this commit |
| Audit #2 INFO-1: State value in CSRF error message | ⚠️ **OPEN** — Not addressed by this commit |

---

## Findings

### [MEDIUM-1] Empty-string refresh token bypasses shape validation, creating a silent degraded-persistence state

- **Location:** `src/auth/oauth.ts:182` and `src/auth/token-store.ts:83-94`
- **Description:** When the WHOOP token endpoint omits `refresh_token` in the response AND no `existingRefreshToken` is available (edge case during initial authorization if the server omits it), the fallback chain `response.refresh_token || existingRefreshToken || ""` produces an empty string. This empty string is persisted to `tokens.json`. On subsequent loads, `isValidTokenShape()` accepts it because `typeof "" === "string"` is true. The file appears valid but contains a useless refresh token.

  This creates a degraded loop on every restart after access token expiry:
  1. `loadTokens()` succeeds — file has valid shape
  2. `isTokenExpired()` returns true — access token expired
  3. `refreshAccessToken("")` sends `refresh_token=` (empty) to WHOOP → server rejects → error
  4. Falls through to full OAuth flow — user must re-authenticate

  The net effect: a token file exists on disk that *looks* valid but can never be refreshed, causing a wasted network round-trip and a confusing diagnostic message ("Token refresh failed") on every startup until the user deletes the file or completes a fresh OAuth flow that returns a proper refresh token.

- **Impact:** No direct security breach, but the empty-string token is sent to the WHOOP token endpoint over HTTPS on every restart. This is a waste of a request and could trigger rate limiting or account monitoring on repeated failed refresh attempts. The primary concern is that it masks the real issue (missing refresh token) behind a misleading "refresh failed" error.

- **Proof of concept:**
  ```typescript
  // Simulate: server returns no refresh_token, no existing token
  const response = { access_token: "abc", refresh_token: "", expires_in: 3600, token_type: "Bearer", scope: "read:profile" };
  const tokens = toOAuthTokens(response);  // tokens.refresh_token === ""

  // tokens.json is saved with refresh_token: ""
  // On next load, isValidTokenShape passes (typeof "" === "string")
  // refreshAccessToken("") is called → POSTs refresh_token= to WHOOP → 400 error
  ```

- **Recommendation:** Add a non-empty check in `isValidTokenShape` for the refresh token, and/or guard the refresh path:
  ```typescript
  // Option A: Tighten shape validation (recommended)
  function isValidTokenShape(data: unknown): data is OAuthTokens {
    return (
      typeof data === "object" &&
      data !== null &&
      "access_token" in data &&
      typeof (data as Record<string, unknown>).access_token === "string" &&
      (data as Record<string, unknown>).access_token !== "" &&
      "refresh_token" in data &&
      typeof (data as Record<string, unknown>).refresh_token === "string" &&
      (data as Record<string, unknown>).refresh_token !== "" &&
      "expires_at" in data &&
      typeof (data as Record<string, unknown>).expires_at === "number"
    );
  }

  // Option B: Guard the refresh call site
  if (existing.refresh_token) {
    // Only attempt refresh if we actually have a refresh token
    try { ... } catch { ... }
  }
  ```

### [LOW-1] File path disclosure in diagnostic log messages reveals token file location

- **Location:** `src/auth/token-store.ts:112-113`, `src/auth/token-store.ts:125`, `src/auth/token-store.ts:127`
- **Description:** Three new `console.error` calls log the full resolved path to the token file:
  ```
  Token file /home/alice/.whoop-mcp/tokens.json exists but has invalid shape — ignoring.
  No token file found at /home/alice/.whoop-mcp/tokens.json.
  Failed to read token file at /home/alice/.whoop-mcp/tokens.json: [error]
  ```
  The path includes the user's home directory (`/home/alice`), revealing the OS username and the exact location of the credential file. In the MCP context, stderr is captured by the host application (Claude Desktop) and may be included in diagnostic logs, error reports, or telemetry.

- **Impact:** An attacker with access to the MCP host's diagnostic logs (e.g., via a log aggregation system, crash report, or a malicious MCP client that captures stderr) learns the exact path to the token file. The path is deterministic (`~/.whoop-mcp/tokens.json`) so this provides minimal incremental information, but it confirms the username and that the token file exists.

- **Recommendation:** Log a relative or redacted path instead of the full absolute path:
  ```typescript
  const displayPath = filePath.replace(homedir(), "~");
  console.error(`No token file found at ${displayPath}.`);
  ```
  This preserves diagnostic utility while avoiding username disclosure.

### [LOW-2] Unstructured error object logged verbatim on token refresh failure may include unexpected server response data

- **Location:** `src/auth/oauth.ts:264`
- **Description:** The line `console.error("Token refresh failed, starting full OAuth flow:", error)` logs the full `error` object. The error originates from `refreshAccessToken()`, which constructs it as:
  ```typescript
  throw new Error(`Token refresh failed (${response.status}): ${description}`);
  ```
  where `description` comes from the WHOOP server's `error_description` field. The full Error object logged includes:
  - The error message (status code + server error description)
  - The full stack trace (function names, file paths, line numbers)

  While the current `refreshAccessToken` implementation constructs clean error messages that don't contain token values, a future change or a wrapped error could inadvertently include sensitive data. Logging the raw `error` object (vs. `error.message`) is a defense-in-depth gap.

- **Impact:** Currently no token values are leaked. The risk is future regression: if `refreshAccessToken` is modified to include request/response details in the error (common debugging pattern), token values could appear in stderr logs.

- **Recommendation:** Log only the error message, not the full object:
  ```typescript
  console.error(
    "Token refresh failed, starting full OAuth flow:",
    error instanceof Error ? error.message : String(error),
  );
  ```

### [INFO-1] Diagnostic logging to stderr is appropriate for MCP but should be documented

- **Location:** `src/auth/oauth.ts:247,252,260,267`, `src/auth/token-store.ts:112,125,127`
- **Description:** This commit adds 7 new `console.error` calls for diagnostic logging. In the MCP protocol, stdout is reserved for the JSON-RPC channel and stderr is used for diagnostics — so `console.error` is the correct channel. However, the logging is not documented, and there's no log-level control. Users cannot suppress diagnostic messages if they want clean stderr output.
- **Recommendation:** Consider adding a `DEBUG` or `WHOOP_DEBUG` environment variable to gate diagnostic logging:
  ```typescript
  const DEBUG = process.env.WHOOP_DEBUG === "1";
  function debug(msg: string): void {
    if (DEBUG) console.error(`[whoop-mcp] ${msg}`);
  }
  ```
  Document in README that `WHOOP_DEBUG=1` enables verbose output.

### [INFO-2] Refresh token fallback logic is RFC 6749 §6 compliant and correctly implemented

- **Location:** `src/auth/oauth.ts:176-186`, `src/auth/oauth.ts:258`, `src/index.ts:71`
- **Description:** The `existingRefreshToken` fallback in `toOAuthTokens` correctly implements RFC 6749 §6, which states that the authorization server MAY issue a new refresh token on refresh but is not required to. Both call sites (`authenticate()` and `onTokenRefresh()`) correctly pass the existing refresh token from the in-memory loaded tokens, not from a re-read of the file. The `||` preference chain correctly prefers the server's new token over the existing one.

  Security analysis of the fallback:
  - **Token rotation scenario:** If WHOOP rotates refresh tokens, the new token is always preferred (first in `||` chain). The old token is kept only when the server omits the field entirely. ✅
  - **Stale token scenario:** A reused refresh token is only sent to the server that issued it. If the server has revoked it, the refresh fails and falls through to full OAuth flow. No amplification of compromise. ✅
  - **Concurrent refresh race:** Both `authenticate()` and `onTokenRefresh()` could theoretically race, but this pre-existed the change and is acknowledged as INFO-2 in Audit #1. ✅

- **Recommendation:** No action required. This is a positive observation — the implementation is correct.

---

## Positive Observations

- **Refresh token fallback correctly follows RFC 6749 §6.** The `existingRefreshToken` parameter preserves the current refresh token only when the server omits a new one, and correctly prefers the server-issued token when present. This is the standard pattern used by major OAuth libraries.

- **No token values are logged in any of the new diagnostic messages.** All 7 new `console.error` calls log only status descriptions ("expired", "successful", "not found"), file paths, or error messages — never the actual `access_token` or `refresh_token` values. This is good security hygiene.

- **Test coverage is thorough for the new logic.** Three new test cases cover the preference chain: (1) fallback when response omits refresh_token, (2) server token preferred over existing, (3) empty string when both missing. The `index.test.ts` assertion was updated to verify the existing token is passed through.

- **Token file permissions (0600/0700) remain correctly applied.** The `saveTokens` function was not modified by this commit, and the secure permissions are still enforced on every write.

- **Error handling is defensive.** The `loadTokens` function now differentiates ENOENT (expected on first run) from real errors, and the `authenticate` function logs the specific reason for each code path taken. This improves debuggability without compromising security.

- **No secrets in git history.** Verified via `git log --all -- '*.env' 'tokens.json'` — no sensitive files have ever been committed.

- **Zero dependency vulnerabilities.** `npm audit` reports 0 findings.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Medium | Empty-string refresh token passes shape validation | Add non-empty check in `isValidTokenShape` or guard refresh call site |
| 2 | Low | File path disclosure in diagnostic logs | Use `~` instead of full home directory in log messages |
| 3 | Low | Raw error object logged on refresh failure | Log `error.message` instead of full error object |
| 4 | Info | No log-level control for diagnostic messages | Add `WHOOP_DEBUG` env var to gate verbose logging |

### Carried-Over From Previous Audits

| # | Severity | Finding | Source |
|---|----------|---------|--------|
| 5 | Low | Missing security response headers on callback server | Audit #2, LOW-1 |
| 6 | Low | Windows `cmd /c start` lacks empty title guard | Audit #2, LOW-2 |
| 7 | Low | PKCE not implemented | Audit #1, LOW-2 / Audit #2, LOW-3 |
| 8 | Info | State value in CSRF error message | Audit #2, INFO-1 |

---

## GitHub Issues To Create

> **Note:** GitHub API was unavailable during this audit (403 — DNS monitoring proxy).
> The following issues should be created manually when access is restored.

### Issue 1
- **Title:** `[MEDIUM] Empty-string refresh token bypasses shape validation, creating degraded persistence loop`
- **Labels:** `security`, `issue-by-code-review`
- **Body:**
  - **Source:** Security Audit #3, MEDIUM-1
  - **Problem:** `toOAuthTokens` can produce `refresh_token: ""` which passes `isValidTokenShape` and is persisted. On reload, a doomed refresh is attempted with an empty token.
  - **Files:** `src/auth/oauth.ts:182`, `src/auth/token-store.ts:83-94`
  - **Fix:** Add `(data as Record<string, unknown>).refresh_token !== ""` to `isValidTokenShape`, or guard the refresh call with `if (existing.refresh_token)`.

### Issue 2
- **Title:** `[LOW] File path in diagnostic logs reveals home directory and token file location`
- **Labels:** `security`, `issue-by-code-review`
- **Body:**
  - **Source:** Security Audit #3, LOW-1
  - **Problem:** `console.error` in `loadTokens` logs the full absolute path including username.
  - **Files:** `src/auth/token-store.ts:112-113,125,127`
  - **Fix:** Replace `filePath` with `filePath.replace(homedir(), "~")` in log messages.

### Issue 3
- **Title:** `[LOW] Raw error object logged on token refresh failure — defense-in-depth gap`
- **Labels:** `security`, `issue-by-code-review`
- **Body:**
  - **Source:** Security Audit #3, LOW-2
  - **Problem:** `console.error("Token refresh failed...", error)` logs the full Error object including stack trace.
  - **Files:** `src/auth/oauth.ts:264`
  - **Fix:** Log `error instanceof Error ? error.message : String(error)` instead of the raw object.
