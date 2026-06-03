# Security Audit Report #8

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-06-03
> **Scope:** Task 13c — OAuth 2.1 connector for claude.ai web/mobile login
> Files audited:
> - `src/transport/oauth-helpers.ts`
> - `src/transport/oauth-jwt.ts`
> - `src/transport/oauth-connector.ts`
> **Dependencies:** Not re-run for this targeted audit (last clean: audit #7).

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| Important | 4 |
| Minor | 4 |
| Informational | 3 |

**Overall Assessment: PASS WITH RECOMMENDATIONS**

The OAuth 2.1 connector implementation gets the high-risk primitives right: PKCE
S256 is required, redirect URIs are exact-match allowlisted on both `/authorize`
and `/token`, authorization codes are 256-bit and consumed exactly once with a
60-second TTL, JWT signing keys are HKDF-derived (not the bearer token directly),
algorithms are pinned to HS256, token type discrimination prevents access/refresh
confusion, the connector password compare is constant-time and length-blinded,
all OAuth-param HTML output is escaped, the password is stripped from the body
before forwarding, startup validation enforces HTTPS + minimum password length,
and per-endpoint rate limits are tight.

The Important findings are best-practice gaps rather than break-glass bugs:
clickjacking protection is missing on the password page, refresh tokens are
stateless JWTs without rotation/reuse-detection (so a stolen refresh token works
for its full 30-day TTL), the resource indicator on refresh can be silently
overwritten by the client, and the Express app does not configure `trust proxy`
which will misbehave under typical claude.ai-facing reverse-proxy deployments.

---

## Previous Audit Findings Status

| Finding | Status |
|---------|--------|
| Audit #7 MEDIUM-1 (`openBrowser` Windows URL validation) | Out of scope (stdio path) |
| Audit #7 LOW findings (`get_calendar` pagination) | Out of scope |

No previously-identified findings overlap this scope.

---

## Findings

### [IMPORTANT-1] No clickjacking protection on the connector password page

- **Location:** `src/transport/oauth-connector.ts:466-485` (`GET /authorize`),
  `src/transport/oauth-connector.ts:494-510` (`POST /authorize` 401 re-render),
  `renderPasswordPage()` at `oauth-connector.ts:355-403`
- **Description:** The HTML page that prompts the user for the connector
  password is served with only `Cache-Control: no-store` and `Content-Type`
  headers. There is no `X-Frame-Options: DENY`, no `Content-Security-Policy:
  frame-ancestors 'none'`, and no other anti-framing control. The form posts
  back to the same origin, so a frame-aware UI redress (clickjacking) attack
  is straightforward to mount once a victim is lured to an attacker-controlled
  page.
- **Impact:** An attacker who can phish a victim into visiting a malicious
  page can iframe the connector login at the victim's `PUBLIC_URL`, overlay
  fake UI that captures keystrokes via a transparent input, or trick the
  victim into clicking "Authorize" with attacker-supplied OAuth params (via
  the `GET /authorize` query string controlling the hidden form fields). The
  authorization flow is gated by `redirect_uri` allowlisting and PKCE so the
  resulting code is unusable to the attacker, but the **connector password
  itself can be captured** through the framed form.
- **Attack scenario:**
  1. Attacker hosts `evil.example` with a fullscreen iframe pointing at
     `https://<public-url>/authorize?client_id=...&redirect_uri=<allowed>...`.
  2. Attacker overlays a transparent click target, or uses keystroke logging
     via a sibling iframe + same-origin tricks where applicable.
  3. Victim, who is already comfortable seeing the WHOOP-MCP login, types
     the connector password.
  4. Attacker now holds the connector password and can authenticate any
     allowlisted client themselves.
- **Recommended fix:** Set anti-framing and a tight CSP on both the GET and
  the 401 re-render path. Adding the headers in `renderPasswordPage` callers
  or in a small middleware:
  ```ts
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  );
  res.setHeader("Referrer-Policy", "no-referrer");
  ```
  (`style-src 'unsafe-inline'` is needed because the page uses an inline
  `<style>` block; alternatively move the styles to an external file and drop
  `unsafe-inline`.)

---

### [IMPORTANT-2] Refresh tokens are stateless JWTs with no rotation reuse detection

- **Location:** `src/transport/oauth-connector.ts:218-246`
  (`exchangeRefreshToken`), `src/transport/oauth-jwt.ts` (no revocation store)
- **Description:** Refresh tokens are 30-day, stateless, signed JWTs. Each
  call to `exchangeRefreshToken` mints a new refresh token but does **not**
  invalidate the one that was just presented — there is no `jti` blacklist,
  no `iat`/`exp` watermark per `client_id`, and no refresh-token store to
  detect replay. The `jti` field is declared in `TokenClaims` but never
  populated.
- **Impact:** OAuth 2.1 §4.14 / RFC 6819 §5.2.2 require either sender-
  constrained refresh tokens or refresh-token rotation **with reuse
  detection** for public clients. Today, if a refresh token is exfiltrated
  (e.g., leaked from claude.ai's storage, or captured at a TLS-terminating
  middlebox), the attacker can use it for the entire 30-day TTL — and the
  legitimate client's parallel use of its own refresh token will *not*
  reveal the compromise. There is also no logout / global revocation
  mechanism short of rotating `MCP_AUTH_TOKEN` (or `MCP_JWT_SECRET`), which
  will revoke *every* token system-wide.
- **Attack scenario:** Refresh token leaks via a downstream log, a backup,
  or an exploited browser. Attacker holds the token; both attacker and
  victim use it independently. Server cannot tell them apart and issues
  fresh access tokens to both for the next 30 days.
- **Recommended fix:** Add a refresh-token reuse-detection store (in-memory
  is acceptable for a single-process deployment; Redis for scale-out):
  - Populate a `jti` (random 128-bit) on every issued refresh token.
  - On `exchangeRefreshToken`, mark that `jti` consumed.
  - If a `jti` already marked consumed is presented again, reject the
    request **and** invalidate every refresh token currently outstanding
    for that `client_id` (e.g., bump a per-client epoch in claims).
  - Document operator workflow: rotate `MCP_AUTH_TOKEN` for global force-
    logout.

---

### [IMPORTANT-3] `exchangeRefreshToken` lets the caller overwrite the resource indicator

- **Location:** `src/transport/oauth-connector.ts:243-244`
  ```ts
  const resourceStr = resource?.toString() ?? verified.resource;
  return this._issueTokens(client.client_id, newScopes, resourceStr);
  ```
- **Description:** The resource indicator (RFC 8707) on a refresh exchange
  is taken from the request if present, otherwise from the original grant.
  There is no check that a request-supplied `resource` matches (or is a
  subset of) the one bound to the refresh token. Scopes are correctly
  narrowed-only; resource is not.
- **Impact:** In a single-resource deployment (today's MCP server) this is
  not exploitable end-to-end — `verifyAccessToken` does not enforce a
  resource match against the request URL, and downstream handlers do not
  branch on `info.resource`. It is, however, a deviation from RFC 8707
  §2.2, and it becomes exploitable the moment a future change either
  - serves more than one MCP resource per host, or
  - introduces a resource-aware authorization check.
  An attacker holding a refresh token bound to resource A could mint
  access tokens for resource B at will.
- **Attack scenario:** Future change adds a second resource (e.g.,
  admin-only endpoints) and gates it on `info.resource`. A token that was
  granted with `resource = data` is refreshed with `resource = admin`, and
  the new access token now passes the admin gate.
- **Recommended fix:** Either ignore caller-supplied `resource` on refresh
  (drop the parameter and always use `verified.resource`), or validate
  exact equality:
  ```ts
  if (resource !== undefined && resource.toString() !== verified.resource) {
    throw new Error("resource indicator does not match the original grant");
  }
  const resourceStr = verified.resource;
  ```

---

### [IMPORTANT-4] Express app is not configured with `trust proxy`; rate limits and IP attribution are unreliable behind a load balancer

- **Location:** `src/transport/oauth-connector.ts:444-465` (`createOAuthApp`),
  rate limiters at `oauth-connector.ts:451-462`
- **Description:** The OAuth Express app does not call `app.set("trust
  proxy", ...)`. `express-rate-limit` therefore keys on the socket peer IP.
  Any production deployment fronted by a reverse proxy (Render, Fly, Cloud
  Run, an ingress controller, Cloudflare, etc.) will see one socket peer
  for *every* request, with two consequences:
  1. **DoS amplification of the rate limit:** the global 3/min on
     `/authorize` and 10/min on `/token` is shared across all real clients,
     so a single user retrying — or any other tenant on shared infra — can
     trip the limit for everyone.
  2. **No real per-attacker rate limiting:** an attacker can iterate
     password attempts as fast as the proxy connection allows, because the
     limit is consumed by *all* tenants in lockstep.
  By contrast, `src/transport/http.ts` already exposes a `trustProxy`
  option for the bearer-token path; the OAuth path was not updated.
- **Impact:** Online password-guessing against the connector password is
  effectively unrate-limited from the attacker's perspective once
  legitimate traffic is also using the limiter, and legitimate retries can
  lock everyone out.
- **Attack scenario:** Attacker scripts continuous `POST /authorize` from a
  single IP. Behind a proxy, the rate limiter sees the proxy IP. After 3
  attempts in a window the limiter trips for everyone, but the attacker
  simply waits and re-tries — meanwhile every legitimate user is also
  blocked. In effect, the attacker DoSes the login while still getting
  attempts.
- **Recommended fix:** Plumb the existing `trustProxy` setting into
  `createOAuthApp`, and call `app.set("trust proxy", ...)` so
  `express-rate-limit` and `req.ip` use the leftmost untrusted forwarded
  hop. Use a precise value (number of hops or specific subnet) rather than
  `true`, to avoid spoofed `X-Forwarded-For` from untrusted networks. The
  rate limiter's `keyGenerator` should derive from `req.ip` after this is
  set.

---

### [MINOR-1] PKCE method not re-validated inside `provider.authorize`

- **Location:** `src/transport/oauth-connector.ts:128-147`
- **Description:** The provider checks that `params.codeChallenge` is
  present, but does not check `params.codeChallengeMethod`. The
  `AuthCodeStore` record is then written with `codeChallengeMethod: "S256"`
  hardcoded. The SDK's authorization router validates the method against
  its schema before this code runs, so today only `S256` reaches us — but
  if the SDK schema ever changed, plain PKCE would silently be accepted
  and stored as `S256`, defeating the PKCE check entirely.
- **Impact:** Defense-in-depth gap. No exploit on current SDK.
- **Recommended fix:** Add an explicit check:
  ```ts
  if (params.codeChallengeMethod !== "S256") {
    throw new Error("PKCE method must be S256");
  }
  ```
  (The `AuthorizationParams` type may need to be widened or narrowed
  accordingly.)

---

### [MINOR-2] No `aud` claim in issued JWTs

- **Location:** `src/transport/oauth-jwt.ts:60-78` (`signToken`),
  `oauth-jwt.ts:88-128` (`verifyToken`)
- **Description:** Tokens are issued with `iss = "whoop-mcp"` but no
  audience. `verifyToken` validates only the issuer and algorithm. With a
  single MCP deployment this is fine, but if `MCP_JWT_SECRET` is ever
  shared between two services (intentionally or accidentally) tokens
  become cross-trusted.
- **Impact:** No exploit today; foot-gun for future deployments.
- **Recommended fix:** Add `setAudience(JWT_ISSUER)` (or a more specific
  audience like the public URL) on sign, and `audience: <same>` on verify.

---

### [MINOR-3] No Content-Security-Policy on the password page (and uses inline `<style>`)

- **Location:** `src/transport/oauth-connector.ts:362-403`
  (`renderPasswordPage`)
- **Description:** The password page ships an inline `<style>` block and no
  CSP header. CSP is also called out in IMPORTANT-1 for `frame-ancestors`;
  this finding is the broader case (`script-src`, `default-src`, etc.).
  Currently no `<script>` tags are emitted, but a regression that
  introduces one would land without CSP coverage.
- **Impact:** Defense-in-depth gap; not directly exploitable.
- **Recommended fix:** Apply the CSP suggested in IMPORTANT-1, which
  covers both findings.

---

### [MINOR-4] AuthCodeStore has no per-client/per-IP cap

- **Location:** `src/transport/oauth-helpers.ts:144-180` (`AuthCodeStore.store`)
- **Description:** The in-memory `Map<string, AuthCodeRecord>` is unbounded.
  Each entry is small, and the 60s TTL plus the 3/min `authorizeLimiter`
  bound the steady-state size to roughly 3 entries per IP. In practice this
  is safe. However, if rate limiting is bypassed (see IMPORTANT-4) or the
  TTL is increased, a flood of `/authorize` requests could grow the map
  without bound until the next cleanup tick.
- **Impact:** Low — bounded today by the rate limiter.
- **Recommended fix:** Either enforce a hard cap (e.g., 10_000 codes total,
  reject + 503 above that), or move codes to a TTL cache with a global
  size bound. Additionally, run cleanup on every `store()` call (cheap O(N)
  walk where N is small) so the map cannot grow between cleanup intervals.

---

## Informational

### [INFO-1] `MCP_JWT_SECRET` rotation is the only global revocation lever

Because access and refresh tokens are stateless JWTs, the only way to
force a global logout is to rotate the JWT signing secret (which means
rotating `MCP_AUTH_TOKEN` if no explicit `MCP_JWT_SECRET` is set, given
the HKDF derivation). This is fine, but operators must know: changing
`MCP_AUTH_TOKEN` invalidates every outstanding access and refresh token.
Worth a one-line note in the operator docs for Task 13c.

### [INFO-2] Connector-password compare uses one round of SHA-256, not a slow KDF

`comparePassword` hashes both sides with SHA-256 and compares with
`timingSafeEqual`. This is constant-time and length-blinding, which is the
right shape. It is **not** brute-force-resistant the way bcrypt/argon2
would be — but the connector password is server-side configuration with
a 12-character minimum and 3-attempt-per-minute rate limiting, so online
guessing dominates and a slow KDF would buy little. Offline guessing is
not in the threat model (the password isn't stored anywhere offline-
reachable from the server). Acceptable as designed.

### [INFO-3] HKDF salt is a hardcoded constant

`HKDF_SALT = "whoop-mcp-jwt-v1"`. Per RFC 5869 §3.1, a fixed salt is
acceptable when the input keying material has high entropy, which is the
case here (`MCP_AUTH_TOKEN` is a server secret). The `v1` suffix gives
operators a clean migration path if the key derivation ever needs to
change. No action needed.

---

## Positive Observations

The following are notably done well:

1. **PKCE S256 enforced** on the SDK side, with a defense-in-depth
   `codeChallenge` presence check in `provider.authorize`.
2. **Authorization codes** are 256 bits of `randomBytes`, base64url-
   encoded, single-use (consumed flag never resets), and expire in 60
   seconds — well below OAuth 2.1's 10-minute ceiling.
3. **`exchangeAuthorizationCode` consumes the code first, then validates**
   `redirect_uri` and `client_id` against the stored record. A failed
   redirect/client check still burns the code, preventing enumeration via
   error-message timing or repeated guesses.
4. **`redirect_uri` is exact-string-matched** against
   `ALLOWED_REDIRECT_URIS` on both `/authorize` and `/token`, with no
   normalization, scheme rewriting, or path tricks.
5. **JWT signing key is HKDF-derived** from `MCP_AUTH_TOKEN`, ensuring
   cryptographic separation from the bearer token used on the `/mcp`
   path.
6. **Algorithm pinning:** `verifyToken` passes `algorithms: [JWT_ALG]`,
   blocking `alg: none` and HS/RS confusion attacks.
7. **Token-type discrimination:** `exchangeRefreshToken` rejects access
   tokens, `verifyAccessToken` rejects refresh tokens.
8. **Cross-client refresh use is rejected:** the JWT's `sub` is compared
   to the requesting `client.client_id`.
9. **Scope-narrowing-only on refresh:** every requested scope must already
   be present in the original grant.
10. **Connector password compare is constant-time and length-blinded**
    via SHA-256 + `timingSafeEqual`, with empty-string guards.
11. **`escapeHtml` covers the standard five characters** (`& < > " '`) and
    is applied to every OAuth param echoed back as a hidden input value
    or as the form key, plus the error message — though the only error
    string is a hardcoded literal, the defensive escape is correct.
12. **Connector password is stripped from `req.body` before `next()`**,
    so it does not reach the SDK router or any downstream logger.
13. **Startup validation fails fast** on weak passwords (<12 chars) and
    non-HTTPS public URLs, which are the two configuration mistakes most
    likely to yield catastrophic compromise.
14. **`x-powered-by` is disabled** to avoid version fingerprinting.
15. **Per-endpoint rate limits** (3/min `/authorize`, 10/min `/token`)
    are set and the SDK's built-in limiter is explicitly disabled to
    avoid double-counting.
16. **`AuthCodeStore` cleanup timer is `.unref()`-ed**, so it cannot
    keep the process alive at shutdown.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Important | Clickjacking on password page | Add `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` to GET/POST `/authorize` responses |
| 2 | Important | Refresh tokens not rotation-detected | Add `jti` + in-memory consumed-jti store; on replay, invalidate all refresh tokens for that `client_id` |
| 3 | Important | Resource indicator overwritable on refresh | Either ignore caller-supplied `resource` on refresh, or require exact match against `verified.resource` |
| 4 | Important | No `trust proxy` on Express app | Plumb the existing `trustProxy` config into `createOAuthApp`; key rate limits on real client IP |
| 5 | Minor | PKCE method not explicitly re-checked | Reject anything other than `"S256"` in `provider.authorize` |
| 6 | Minor | No `aud` claim | Add `setAudience(JWT_ISSUER)` on sign and `audience` option on verify |
| 7 | Minor | No CSP on password page | Covered by action item #1's CSP header |
| 8 | Minor | AuthCodeStore unbounded | Add a hard cap; run cleanup synchronously on `store()` |
| 9 | Info | Operator docs for global revocation | Document that rotating `MCP_AUTH_TOKEN` invalidates all tokens |
