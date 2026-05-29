# Security Audit Report #5

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-05-29
> **Scope:** Full codebase audit for v0.3.0 release readiness — `src/auth/`, `src/api/`, `src/tools/`, `src/index.ts`, `src/server.ts`, `src/resources/`
> **Dependencies:** 0 known vulnerabilities (`npm audit` — clean)

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 3 |
| Info | 2 |

**Overall Assessment: PASS** — No release blockers. The codebase is well-hardened for a v0.3.0 release.

---

## Previous Audit Findings Status

Carried-over findings from Audit #4 (2026-05-29), #3, and #2:

| Finding | Status |
|---------|--------|
| Audit #4 HIGH-1: Auto-pagination memory/rate-limit risk | ✅ **RESOLVED** — `ABSOLUTE_MAX_RECORDS=500`, `maxPages=20`, `interPageDelayMs=200`, AbortSignal support all implemented in `src/api/pagination.ts` |
| Audit #4 MEDIUM-1: Date parsing injection | ✅ **RESOLVED** — `MAX_LAST_N_DAYS=365`, strict regex allowlist, `validateDateRange()` caps all ranges |
| Audit #4 MEDIUM-2: Resources ambient privacy | ✅ **RESOLVED** — `WHOOP_MCP_DISABLE_RESOURCES=1` env var opt-out implemented |
| Audit #4 MEDIUM-3: ID format validation | ✅ **RESOLVED** — `stringIdSchema` uses regex `/^[a-zA-Z0-9_-]+$/`; `numericIdSchema` uses `z.number().int().positive()` |
| Audit #3 MEDIUM-1: Empty-string refresh token | ✅ **RESOLVED** — `isValidTokenShape` now requires `record.refresh_token.length > 0` |
| Audit #2 LOW-1: Missing security headers on callback server | ⚠️ **OPEN** — see LOW-1 below |
| Audit #2 LOW-2: Windows `cmd /c start` lacks empty title guard | ⚠️ **OPEN** — see LOW-2 below |
| Audit #3 LOW-1: File path disclosure in diagnostics | ✅ **RESOLVED** — `redactHomePath()` replaces home dir with `~` in all logged paths |

---

## Findings

### [MEDIUM-1] Windows `cmd /c start` URL injection via crafted authorization URL

- **Location:** `src/auth/oauth.ts:205` — `openBrowser()` function
- **Description:** On Windows, the command executed is `cmd /c start <url>`. The `start` command interprets certain characters specially. While the URL is constructed by `buildAuthorizationUrl()` using `URLSearchParams` (which URL-encodes values), the URL itself contains unquoted query string characters. If a malicious WHOOP authorization server ever returned a redirect that included shell metacharacters, or if `config.redirectUri` is user-controlled and contains special characters, `cmd.exe` could interpret them.

  More concretely, Windows `cmd /c start` without an empty title argument (`""`) will misinterpret URLs containing spaces (e.g., if a future change introduces spaces in URL construction). The lack of `""` as the first argument after `start` is a known Windows quirk.

- **Impact:** Low probability — the URL is fully constructed from constants and URL-encoded params. However, this is a defense-in-depth gap on Windows. An attacker controlling the redirect URI parameter could potentially inject commands.
  
- **Proof of concept:**
  ```
  // If redirectUri somehow contained: 'http://evil.com" & calc.exe & "'
  // cmd /c start http://evil.com" & calc.exe & "
  // → would execute calc.exe on Windows
  ```
  This requires the attacker to control `config.redirectUri`, which currently comes from a hardcoded constant or the developer's own config. Not remotely exploitable in current code, but fails defense-in-depth.

- **Recommendation:**
  ```typescript
  // Add empty title argument for Windows:
  win32: ["cmd", ["/c", "start", '""', url]],
  ```

---

### [LOW-1] Callback server responses lack security headers

- **Location:** `src/auth/callback-server.ts:105-135` — HTTP responses from callback server
- **Description:** The temporary OAuth callback server (listening on 127.0.0.1) returns HTML responses without standard security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store`. While this server only listens on localhost for ~2 minutes and serves static HTML, missing headers allow:
  - The success/error page could be framed by a malicious page (clickjacking)
  - Browser might MIME-sniff the response
  - Browser might cache the callback URL (containing the auth code in query params)

- **Impact:** Minimal — localhost-only, ephemeral server. But `Cache-Control: no-store` is specifically important because the callback URL contains the authorization code, and browser caching could persist it.

- **Recommendation:**
  ```typescript
  const securityHeaders = {
    "Content-Type": "text/html",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
  };
  res.writeHead(200, securityHeaders);
  ```

---

### [LOW-2] Windows `cmd /c start` missing empty title guard (carried from Audit #2)

- **Location:** `src/auth/oauth.ts:205`
- **Description:** Same as MEDIUM-1 but the specific sub-issue: `start` without `""` as the first arg interprets the first quoted argument as a window title. This is a well-documented Windows pitfall.
- **Impact:** Cosmetic/potential failure on Windows when URL contains spaces.
- **Recommendation:** Already covered in MEDIUM-1 fix.

> **Note:** Merging LOW-2 with MEDIUM-1 for issue tracking. Only one issue should be created.

---

### [LOW-3] Token refresh error not differentiated in `authenticate()` logging

- **Location:** `src/auth/oauth.ts:255`
- **Description:** When token refresh fails, the error message is logged to stderr as `"Token refresh failed, starting full OAuth flow: {message}"`. This is good for diagnostics but loses the error type. If the failure is due to network issues (vs. invalid refresh token), the user might be prompted for a full re-auth unnecessarily. The error is caught generically.

- **Impact:** UX degradation — user forced through full OAuth flow when a network retry might suffice. Not a security vulnerability per se, but related to auth availability.

- **Recommendation:** Differentiate network errors from auth errors:
  ```typescript
  } catch (error: unknown) {
    if (error instanceof WhoopNetworkError) {
      console.error("Token refresh failed due to network error — will retry on next request.");
      // Could return existing token and let the client retry
    }
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Token refresh failed, starting full OAuth flow: ${message}`);
  }
  ```

---

### [INFO-1] All `console.error` calls are status/diagnostic messages — no secrets leaked

- **Location:** All 15 `console.error` calls across `src/`
- **Description:** Verified that no `console.error` call logs access tokens, refresh tokens, client secrets, or other sensitive data. All logging uses redacted paths (`~/.whoop-mcp/...`) and status messages only.
- **Status:** No action needed.

---

### [INFO-2] PKCE implementation is correct and complete

- **Location:** `src/auth/oauth.ts:300-305`
- **Description:** PKCE is properly implemented:
  - `codeVerifier`: 32 random bytes → base64url (43 chars, well above RFC 7636 minimum of 43)
  - `codeChallenge`: SHA-256 of verifier → base64url
  - `code_challenge_method`: "S256"
  - Verifier is sent only in the token exchange (POST), never in the authorization URL
  - State parameter is separate from PKCE (32 random hex bytes)
- **Status:** No action needed. This resolves the finding from Audit #2 LOW-3 / Audit #1 LOW-2.

---

## Positive Observations

1. **Token storage is properly secured** — `0700` directory permissions, `0600` file permissions, home directory path redacted in logs, shape validation rejects malformed files.

2. **PKCE + state parameter** — OAuth flow uses both PKCE (S256) and a separate cryptographic state parameter for CSRF protection. The callback server validates state before accepting the code.

3. **Input validation is comprehensive** — All tool inputs go through Zod schemas with appropriate constraints (regex patterns for IDs, min/max for numeric ranges, max 365 days for date expressions, max 90 days for compare_periods).

4. **Auto-pagination has proper safety guards** — `ABSOLUTE_MAX_RECORDS=500`, `maxPages=20`, inter-page delay, AbortSignal support. This addresses the denial-of-service vector from Audit #4.

5. **No secrets in source or git history** — `.env.example` contains only placeholder values, `.gitignore` covers `tokens.json`, `.env`, and `.env.local`. Git history is clean.

6. **Shell injection prevented** — `openBrowser()` uses `spawn` with argument arrays instead of string interpolation through a shell.

7. **API client has defense-in-depth** — 30s request timeout, 429 retry with exponential backoff (max 3 retries), Retry-After header capped at 60s, typed errors for all failure modes.

8. **XSS prevention in callback server** — `escapeHtml()` function properly escapes all 5 dangerous characters before embedding user-controlled values in HTML responses.

9. **Resource caching with invalidation** — Token refresh invalidates the resource cache (prevents stale data from a different user's session). Resources are opt-out via env var.

10. **Zero npm audit vulnerabilities** — All dependency CVEs resolved.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Medium | Windows `cmd /c start` URL injection | Add `""` title guard: `["cmd", ["/c", "start", '""', url]]` |
| 2 | Low | Missing security headers on callback server | Add `X-Content-Type-Options`, `X-Frame-Options`, `Cache-Control: no-store` |
| 3 | Low | Token refresh error not differentiated | Distinguish network errors from auth errors in retry logic |

---

## Release Readiness Verdict

**PASS** — The codebase is ready for v0.3.0 release. There are no critical or high-severity findings. The one medium finding (Windows `cmd /c start` title guard) is low-probability and only affects Windows users with a crafted redirect URI, which is currently hardcoded. All previous high/critical findings from Audits #1–4 have been resolved.

Recommended: Fix MEDIUM-1 and LOW-1 before release if time allows, but they are not blockers.
