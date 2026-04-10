# Security Audit Report #1

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-04-11
> **Scope:** Full codebase — `src/auth/`, `src/api/`, `src/server.ts`, `src/tools/`, `src/index.ts`
> **Dependencies:** 0 known vulnerabilities (`npm audit` clean)

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Medium | 3 |
| Low | 3 |
| Info | 2 |

---

## Findings

### [HIGH-1] OS Command Injection via `exec()` in `openBrowser`

- **Location:** `src/auth/oauth.ts:193-199`
- **Description:** `openBrowser()` uses `exec()` with string interpolation to launch the browser:
  ```typescript
  const command = process.platform === "darwin"
    ? `open "${url}"`
    : ...
  exec(command);
  ```
  The URL is constructed from `WHOOP_AUTH_URL` (constant) + user-supplied `clientId` (from env var). While the URL is built via `new URL()` which provides some encoding, the double-quote escaping is insufficient. A malicious `clientId` env var containing `"; rm -rf / #` or backtick subshells would be passed through the shell.
- **Impact:** Arbitrary OS command execution. An attacker who controls the `WHOOP_CLIENT_ID` environment variable (e.g., via a compromised `.env` file, CI config injection, or supply chain attack on the MCP host) could execute arbitrary commands as the user.
- **Proof of concept:**
  ```bash
  WHOOP_CLIENT_ID='foo"; echo PWNED > /tmp/pwned; echo "' node dist/index.js
  ```
  The constructed URL embeds the client_id as a query parameter. When passed to `exec(open "https://...?client_id=foo"; echo PWNED > /tmp/pwned; echo "")`, the shell interprets the injected command.
- **Recommendation:** Replace `exec` with `spawn` (no shell interpretation):
  ```typescript
  import { spawn } from "node:child_process";

  export function openBrowser(url: string): void {
    try {
      const cmd = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "start"
        : "xdg-open";
      spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
    } catch {
      console.error(`\nCould not open browser. Please open this URL manually:\n${url}\n`);
    }
  }
  ```

### [HIGH-2] Reflected XSS in OAuth callback error page

- **Location:** `src/auth/callback-server.ts:43-49`
- **Description:** The `errorHtml()` function injects the `error_description` query parameter directly into HTML without encoding:
  ```typescript
  function errorHtml(message: string): string {
    return `...<p>${message}</p>...</html>`;
  }
  ```
  The `message` comes from `url.searchParams.get("error_description")` (line 87) — an attacker-controlled value in the OAuth redirect.
- **Impact:** An attacker can craft a malicious redirect URL to the callback server containing `<script>` tags in `error_description`, executing arbitrary JavaScript in the user's browser on `localhost:3000`. While localhost scope limits cookie theft, it could be used for phishing or social engineering during the auth flow.
- **Proof of concept:**
  ```
  http://localhost:3000/callback?error=access_denied&error_description=<script>alert('XSS')</script>
  ```
- **Recommendation:** HTML-encode the message before interpolation:
  ```typescript
  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function errorHtml(message: string): string {
    return `...<p>${escapeHtml(message)}</p>...</html>`;
  }
  ```

### [MEDIUM-1] No request timeout on API client — denial of service risk

- **Location:** `src/api/client.ts:128-135` (`doFetch` function)
- **Description:** The `fetch()` call has no `AbortSignal` or timeout. If the WHOOP API hangs (network issue, DNS stall, server not responding), the MCP server blocks indefinitely. This server runs inside Claude Desktop's process — a hung request freezes the entire MCP connection.
- **Impact:** Denial of service. A slow or unresponsive WHOOP API (or a MITM attacker performing a slow-loris style attack) can permanently hang the MCP server, requiring the user to restart Claude Desktop.
- **Recommendation:** Add `AbortSignal.timeout()`:
  ```typescript
  const REQUEST_TIMEOUT_MS = 30_000;

  return await fetch(url, {
    method: "GET",
    headers: { ... },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  ```

### [MEDIUM-2] Retry-After header not capped — server-induced sleep attack

- **Location:** `src/api/client.ts:97-104` (`parseRetryAfter`)
- **Description:** The `parseRetryAfter()` function accepts any non-negative number from the `Retry-After` header. A malicious or misconfigured server could return `Retry-After: 999999`, causing the client to sleep for ~11.5 days. The only check is `seconds < 0`.
- **Impact:** Denial of service. The MCP server becomes unresponsive for an arbitrary duration based on a server-controlled header value.
- **Recommendation:** Cap the Retry-After value:
  ```typescript
  const MAX_RETRY_AFTER_MS = 60_000; // 1 minute max

  function parseRetryAfter(response: Response): number | null {
    const header = response.headers.get("retry-after");
    if (header === null) return null;
    const seconds = Number(header);
    if (Number.isNaN(seconds) || seconds < 0) return null;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  ```

### [MEDIUM-3] Callback server binds to `0.0.0.0` — exposed on all network interfaces

- **Location:** `src/auth/callback-server.ts:159`
- **Description:** `server.listen(port)` with no host argument binds to `0.0.0.0` (all interfaces) by default in Node.js. This means any device on the local network can send requests to the callback server during the OAuth flow window (~2 minutes).
- **Impact:** An attacker on the same network could race to submit a crafted callback before the legitimate WHOOP redirect arrives, potentially injecting a malicious authorization code. The CSRF state parameter mitigates this, but defense-in-depth says bind to loopback only.
- **Recommendation:** Bind to `127.0.0.1` explicitly:
  ```typescript
  server.listen(port, "127.0.0.1");
  ```

### [LOW-1] No token shape validation on load — deserialization trust

- **Location:** `src/auth/token-store.ts:93-99`
- **Description:** `loadTokens()` does `JSON.parse(raw) as OAuthTokens` — a blind typecast. If the `tokens.json` file is corrupted, tampered with, or written by a different version of the tool, the code proceeds with arbitrary data. Missing fields cause runtime errors far from the source.
- **Impact:** Low — only this application writes the file. But a corrupted file or a symlink attack could cause confusing failures.
- **Recommendation:** Add lightweight shape validation:
  ```typescript
  function isValidTokenShape(data: unknown): data is OAuthTokens {
    return typeof data === "object" && data !== null
      && "access_token" in data && typeof (data as Record<string, unknown>).access_token === "string"
      && "refresh_token" in data && typeof (data as Record<string, unknown>).refresh_token === "string"
      && "expires_at" in data && typeof (data as Record<string, unknown>).expires_at === "number";
  }
  ```

### [LOW-2] OAuth flow does not use PKCE

- **Location:** `src/auth/oauth.ts:62-77` (`buildAuthorizationUrl`), `src/auth/oauth.ts:88-118` (`exchangeCodeForTokens`)
- **Description:** The OAuth flow uses plain Authorization Code flow without PKCE (Proof Key for Code Exchange). PKCE prevents authorization code interception attacks, where a malicious app on the same device intercepts the callback redirect and steals the code.
- **Impact:** Low for this specific use case — the callback server validates the `state` parameter and runs on localhost — but PKCE is an OWASP best practice for all public and native OAuth clients. Note: this depends on whether WHOOP's OAuth server supports PKCE.
- **Recommendation:** Add PKCE if supported by WHOOP:
  ```typescript
  import { createHash } from "node:crypto";

  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Include code_verifier in the token exchange
  ```

### [LOW-3] No `server.on('error')` handler — unhandled exception on port conflict

- **Location:** `src/auth/callback-server.ts:159`
- **Description:** If port 3000 is already in use, `server.listen(port)` emits an `'error'` event. Without a handler, this becomes an unhandled exception in Node.js, crashing the process with a confusing error instead of a clean message.
- **Impact:** Poor UX and potential crash. If another app occupies port 3000, the user gets a stack trace instead of "Port 3000 is in use, please close the other application."
- **Recommendation:**
  ```typescript
  server.on("error", (err: NodeJS.ErrnoException) => {
    cleanup();
    if (!settled) {
      settled = true;
      const msg = err.code === "EADDRINUSE"
        ? `Port ${port} is already in use. Close the other application and try again.`
        : `Callback server error: ${err.message}`;
      reject(new Error(msg));
    }
  });
  server.listen(port, "127.0.0.1");
  ```

### [INFO-1] Auth URL logged to stderr contains client_id

- **Location:** `src/auth/oauth.ts:277-279`
- **Description:** `console.error` logs the full authorization URL including `client_id` as a query parameter. While `client_id` is not secret (it's the public identifier), in some deployment contexts stderr is captured to log aggregation systems where it may be visible to operators.
- **Recommendation:** Acceptable for a local CLI tool. No action required, but document that stderr may contain the client ID.

### [INFO-2] Token file race condition on concurrent instances

- **Location:** `src/auth/token-store.ts:74-80`
- **Description:** `saveTokens` uses `writeFile` without file locking. If two instances of the MCP server run simultaneously (unlikely but possible), they could race on reading/writing `tokens.json`, causing one to read a partially-written file.
- **Recommendation:** Acceptable for the single-user CLI use case. If multi-instance support is ever needed, use `flock` or atomic write (write to temp file + rename).

---

## Positive Observations

- **CSRF protection implemented correctly.** The OAuth callback validates `state` against a cryptographically random value (`randomBytes(16)`). This is the correct defense against CSRF in OAuth flows.

- **Token file permissions are strict.** Directory created with `0700`, token file written with `0600` (user-only read/write). This follows the principle of least privilege for sensitive credential storage.

- **`.gitignore` covers all sensitive files.** `tokens.json`, `.env`, `.env.local` are all excluded from version control. `.env.example` contains only placeholder values.

- **No secrets in source code or git history.** Verified via `git log` — the only env-related file ever committed is `.env.example` with placeholder values.

- **0 known vulnerabilities in dependencies.** `npm audit` reports 0 findings. Minimal dependency tree (only `@modelcontextprotocol/sdk` + `zod` at runtime).

- **Token expiry buffer.** The 60-second buffer before expiry in `isTokenExpired()` prevents using tokens that are about to expire mid-request. Good defensive practice.

- **Read-only tools.** All 6 MCP tools are annotated `readOnlyHint: true` and only perform GET requests. No mutation surface to the WHOOP API.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | High | OS command injection in `openBrowser` | Replace `exec` with `spawn` — no shell |
| 2 | High | Reflected XSS in callback error page | HTML-encode `errorHtml` message |
| 3 | Medium | No fetch timeout — indefinite hang | Add `AbortSignal.timeout(30_000)` |
| 4 | Medium | Retry-After not capped | Cap at 60 seconds |
| 5 | Medium | Callback server binds `0.0.0.0` | Bind to `127.0.0.1` |
| 6 | Low | No token shape validation | Add lightweight field check |
| 7 | Low | No PKCE in OAuth flow | Add if WHOOP supports it |
| 8 | Low | No `server.on('error')` handler | Add error handler for port conflicts |
