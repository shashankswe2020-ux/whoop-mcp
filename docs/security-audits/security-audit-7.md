# Security Audit Report #7

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-05-31
> **Scope:** v0.4.0 release readiness — new composite tools (`get-today.ts`, `get-calendar.ts`), extended `date-utils.ts`, token handling (`token-store.ts`, `oauth.ts`), input validation (`server.ts`), `openBrowser`, `.gitignore`
> **Dependencies:** 0 known vulnerabilities (`npm audit` — clean)

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 2 |
| Info | 2 |

**Overall Assessment: PASS**

The v0.4.0 codebase is in strong security posture for release. The new composite tools (`get_today`, `get_calendar`) introduce no new attack surface — they are read-only aggregations over existing validated endpoints. The `openBrowser` shell injection issue from previous audits is fully resolved (uses `spawn` with arg arrays). Token handling remains correctly permissioned (0600/0700). All previous audit findings are resolved.

---

## Previous Audit Findings Status

| Finding | Status |
|---------|--------|
| Audit #5 MEDIUM-1: Windows `cmd /c start` URL injection | ✅ **RESOLVED** — `spawn` with arg arrays, empty title guard |
| Audit #5 LOW-1: Callback server security headers | ✅ **RESOLVED** — `SECURITY_HEADERS` applied to all responses |
| Audit #6 HIGH-1–3, MEDIUM-1–4, LOW-1–3: v3 spec findings | ⬜ **NOT APPLICABLE** — spec-only, v3 not yet implemented |

All findings relevant to shipped code are resolved. No carry-over.

---

## Findings

### [MEDIUM-1] `openBrowser` URL passed to Windows `cmd /c start` without URL validation

- **Location:** `src/auth/oauth.ts:202-206`
- **Description:** The `openBrowser` function correctly uses `spawn` with argument arrays (resolving the previous shell injection finding). However, on Windows the URL is passed as an argument to `cmd /c start "" <url>`. While `spawn` avoids shell interpretation on the command-line level, `cmd.exe`'s internal `start` command still interprets special characters in its arguments (e.g., `&`, `|`, `^`). A malicious URL constructed via a MITM on the auth URL construction path could embed `cmd.exe` metacharacters.

  The actual risk is **very low** because:
  1. The URL is constructed internally by `buildAuthorizationUrl()` from trusted constants
  2. It's never derived from user/tool input
  3. This only applies to Windows

  However, defense-in-depth would validate the URL before spawning.

- **Impact:** In a theoretical scenario where `buildAuthorizationUrl` is modified to accept external input, command injection on Windows via `cmd.exe` metacharacters.

- **Proof of concept:** Not practically exploitable in the current code path. The URL is always `https://api.prod.whoop.com/oauth/oauth2/auth?...` with URL-encoded parameters.

- **Recommendation:** Add URL validation before spawning:
  ```typescript
  export function openBrowser(url: string): void {
    // Validate URL scheme to prevent command injection via exotic protocols
    const parsed = new URL(url); // throws on invalid URL
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      console.error(`Refusing to open non-HTTP URL: ${url}`);
      return;
    }
    // ... existing spawn logic
  }
  ```

---

### [LOW-1] `get_calendar` maxRecords allows up to 180 records per stream without explicit bound documentation

- **Location:** `src/tools/get-calendar.ts:124-125`
- **Description:** The `get_calendar` tool passes `maxRecords: numDays * 2` to `fetchAllPages`, where `numDays` is capped at 90 by Zod schema validation. This means up to 180 records per stream (3 streams = 540 total API records per tool call). The `fetchAllPages` utility has an `ABSOLUTE_MAX_RECORDS = 500` hard cap, which would silently truncate at 500. This is a denial-of-service self-protection concern:
  - 90-day calendar request → 3 parallel paginated streams → up to 60 pages total
  - Each with `interPageDelayMs: 0` (no rate limiting protection between pages)

  The pagination utility already provides adequate safety (ABSOLUTE_MAX_RECORDS cap, maxPages cap), so this is informational. However, setting `interPageDelayMs: 0` on a tool that can fetch many pages bypasses the rate-limit safety buffer.

- **Impact:** Potential 429 rate limiting from WHOOP API when requesting 90-day calendars, causing degraded user experience. No security breach possible.

- **Recommendation:** Consider adding a minimum inter-page delay (e.g., 50ms) for calendar requests, or document that the 90-day max may hit API rate limits:
  ```typescript
  interPageDelayMs: numDays > 30 ? 100 : 0,
  ```

---

### [LOW-2] `compare_periods` tool input schema allows raw ISO strings without regex validation

- **Location:** `src/server.ts:345-352`
- **Description:** The `compare_periods` tool schema uses bare `z.string()` for all four date parameters (`period_a_start`, `period_a_end`, `period_b_start`, `period_b_end`). While the handler calls `validateDateRange()` which rejects NaN dates, passing a completely arbitrary string like `"not-a-date"` results in `NaN` comparison that is then caught by the validation function. This is correctly handled — but the error message could be confusing to the LLM client.

  In contrast, the `date-utils.ts` module has strict regex validation for all supported expressions. The collection tools benefit from this via `resolveDateExpression`. The `compare_periods` tool bypasses it by accepting raw strings directly.

- **Impact:** No security vulnerability. Malformed input is rejected at the `validateDateRange` boundary. However, the asymmetry between tools could confuse AI clients.

- **Recommendation:** Add a `.regex()` or `.refine()` to validate ISO 8601 format in the schema:
  ```typescript
  period_a_start: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, "Expected ISO 8601 date format")
    .describe("ISO 8601 start of the first period."),
  ```

---

### [INFO-1] Token refresh error message in `index.ts` could leak internal path

- **Location:** `src/index.ts:72-74`
- **Description:** When `loadTokens()` returns null during token refresh, the error message is:
  ```
  "Token refresh failed: no stored tokens found. Re-authentication may be required."
  ```
  This is appropriate and does not leak the token path. The `token-store.ts` module uses `redactHomePath()` to avoid leaking usernames in stderr logs. Good practice observed.

- **Note:** Positive observation recorded as Info — no action needed.

---

### [INFO-2] Date expression parsing uses `new Date()` for "now" — no clock injection for testing

- **Location:** `src/tools/date-utils.ts:148`
- **Description:** The `resolveDateExpression` function uses `new Date()` directly for the current time. This means date-based logic cannot be deterministically tested without mocking globals. This is a testability concern, not a security issue. It also means time-of-day changes within a request are unlikely to cause issues since the function is called once per tool invocation.

- **Note:** Purely an architectural observation. No security impact.

---

## Positive Observations

1. **Shell injection resolved:** `openBrowser` now uses `spawn` with argument arrays — the primary finding from earlier audits is fully fixed.
2. **PKCE implemented:** OAuth flow uses S256 code challenge, generated with `crypto.randomBytes(32)` — strong entropy, compliant with OAuth 2.1.
3. **State parameter validated:** Callback server validates the `state` parameter against `expectedState` (CSRF protection).
4. **Input validation thorough:** All MCP tools use Zod schemas with `.min()`, `.max()`, `.int()`, and `.regex()` constraints. ID parameters are restricted to `[a-zA-Z0-9_-]+`.
5. **No secrets in code:** No hardcoded API keys, tokens, or credentials. All sensitive values from environment variables.
6. **Token storage secure:** Directory 0700, file 0600, shape validation on load, `redactHomePath` for logs.
7. **XSS prevention:** Callback server uses `escapeHtml()` for reflected content. Security headers applied.
8. **No `console.log` in src/:** All logging correctly uses `stderr` to avoid polluting the MCP stdio channel.
9. **Pagination safety caps:** `ABSOLUTE_MAX_RECORDS = 500`, `DEFAULT_MAX_PAGES = 20`, `MAX_RETRY_AFTER_MS = 60000` — prevents runaway API usage.
10. **Date expressions use allowlist:** Strict regex patterns reject anything not explicitly supported — no arbitrary expression evaluation.
11. **Composite tools are read-only:** `get_today` and `get_calendar` only aggregate existing GET endpoint data — no write operations, no new attack surface.
12. **Error responses sanitized:** `safeTool` wrapper catches errors and converts them to structured MCP responses without stack traces.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Medium | `openBrowser` URL not validated before spawn on Windows | Add URL scheme validation (http/https only) |
| 2 | Low | `get_calendar` bypasses inter-page delay on large requests | Add delay for >30 day requests |
| 3 | Low | `compare_periods` date inputs lack regex validation in schema | Add ISO 8601 regex to Zod schema |

---

## Conclusion

**PASS for v0.4.0 release.** No Critical or High findings. The single Medium finding is defense-in-depth on a code path that currently only receives trusted internally-constructed URLs. The two Low findings are quality improvements with no exploitable security impact.
