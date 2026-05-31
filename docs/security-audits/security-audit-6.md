# Security Audit Report #6

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-05-31
> **Scope:** Spec review of `docs/specs/v3-platform-enhancements.md` — HTTP transport, OAuth 2.1 connector, webhook SSRF, CLI credentials, Docker, caching, rate limiting
> **Type:** Pre-implementation threat model / design review
> **Dependencies:** 0 known vulnerabilities (`npm audit` — clean)

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 |
| Medium | 4 |
| Low | 3 |
| Info | 2 |

**Overall Assessment:** The spec has good security awareness (dedicated Security Considerations table) but several gaps require resolution before implementation. The three HIGH findings are design-level flaws that, if shipped as-is, would create exploitable vulnerabilities in a remotely-hosted server.

---

## Previous Audit Findings Status

| Finding | Status |
|---------|--------|
| Audit #5 MEDIUM-1: Windows `cmd /c start` URL injection | ✅ **RESOLVED** — `spawn` with arg arrays, empty title guard |
| Audit #5 LOW-1: Callback server security headers | ✅ **RESOLVED** — `SECURITY_HEADERS` constant applied to all responses |

All previous findings resolved. No carry-over.

---

## Findings

### [HIGH-1] OAuth 2.1 Connector: `MCP_AUTH_TOKEN` reused as JWT signing secret

- **Location:** Spec Feature 4, "OAuth 2.1 Connector" section — "`MCP_AUTH_TOKEN` used as JWT signing secret"
- **Description:** The spec proposes using `MCP_AUTH_TOKEN` (the bearer token for client authentication) as the HMAC secret for signing JWTs. This conflates two distinct security roles:
  1. A **shared secret** transmitted in every request's `Authorization` header (high exposure)
  2. A **signing key** that must never leave the server (low exposure)

  If `MCP_AUTH_TOKEN` leaks (log files, client-side storage, browser devtools, proxy logs), an attacker can forge arbitrary access tokens and refresh tokens, fully impersonating any authorized client. Bearer tokens are inherently high-exposure — they're sent on every request, copied to clipboard during setup, and stored in client configs.

- **Impact:** Full authentication bypass. Attacker with the bearer token (intended to be a shared password) can mint their own JWTs, bypass token expiry, and access all WHOOP data indefinitely.

- **Proof of concept:**
  ```
  1. User puts MCP_AUTH_TOKEN in Claude Desktop config (plaintext JSON)
  2. Claude Desktop config synced to iCloud/backup (common)
  3. Attacker obtains token from backup
  4. Expected impact: Can call MCP tools (auth bypass) — already bad
  5. Actual impact: Can ALSO forge JWTs with arbitrary expiry,
     create unlimited refresh tokens, never need the password again
  ```

- **Recommendation:** Use a separate, dedicated JWT signing secret:
  ```
  MCP_AUTH_TOKEN       — Bearer token for direct /mcp clients
  MCP_JWT_SECRET       — HMAC-SHA256 secret for signing connector tokens (never transmitted)
  MCP_CONNECTOR_PASSWORD — Password for the OAuth authorize page
  ```
  If only one env var is desired, derive the JWT secret from the auth token using HKDF:
  ```typescript
  import { hkdf } from "node:crypto";
  const jwtSecret = await hkdf("sha256", MCP_AUTH_TOKEN, "whoop-mcp-jwt", "jwt-signing", 32);
  ```
  This ensures the bearer token alone cannot forge JWTs.

---

### [HIGH-2] OAuth 2.1 Connector: No `redirect_uri` allowlist specification

- **Location:** Spec Feature 4 — "No open redirects — `redirect_uri` validated against allowlist"
- **Description:** The spec states `redirect_uri` must be validated against an allowlist but **never defines what the allowlist contains or how it's configured**. This is the most critical detail of open redirect prevention, and leaving it undefined risks:
  1. Implementer hard-coding a too-broad pattern (e.g., any URL on a domain)
  2. Dynamic allowlist that accepts attacker-controlled values
  3. Missing validation on the `/token` endpoint (classic OAuth vulnerability — validate on both `/authorize` AND `/token`)

  For an MCP connector serving claude.ai, the redirect URIs are known at registration time and should be immutable.

- **Impact:** Open redirect → authorization code theft → account compromise. An attacker crafts a malicious `redirect_uri`, the user authenticates, and the auth code is sent to the attacker's server.

- **Proof of concept:**
  ```
  GET /authorize?
    response_type=code&
    client_id=claude-web&
    redirect_uri=https://evil.com/steal&
    code_challenge=...&
    state=...

  If redirect_uri is not strictly validated:
  → User enters password → code sent to https://evil.com/steal
  → Attacker exchanges code for tokens
  ```

- **Recommendation:** Spec must define:
  1. **Registration-time binding:** The allowlist is the set of redirect URIs registered when the OAuth client is created. For claude.ai, this is exactly `https://claude.ai/oauth/callback` (or whatever Anthropic specifies).
  2. **Exact string match:** No pattern matching, no subdomain wildcards. RFC 6749 §3.1.2.3 requires exact match.
  3. **Validate on BOTH `/authorize` and `/token`:** The authorization code is bound to the redirect_uri used at authorization time; the token endpoint must verify the same URI was used.
  4. **Configuration:** `ALLOWED_REDIRECT_URIS` env var (comma-separated list) or hard-code the known claude.ai callback URL.

  ```typescript
  const ALLOWED_REDIRECT_URIS = (process.env.ALLOWED_REDIRECT_URIS ?? "").split(",").filter(Boolean);
  
  function validateRedirectUri(uri: string): boolean {
    return ALLOWED_REDIRECT_URIS.includes(uri); // Exact match only
  }
  ```

---

### [HIGH-3] Webhook SSRF prevention: Private IP check is insufficient as specified

- **Location:** Spec Feature 8, "Security Notes" — "No localhost/private IP URLs allowed (SSRF prevention)"
- **Description:** The spec only mentions rejecting "private/localhost URLs" but does not specify:
  1. **DNS rebinding attacks:** Attacker registers `evil.com` → resolves to `169.254.169.254` (cloud metadata). URL passes string validation (not a private IP literal), but the actual HTTP request hits the metadata service.
  2. **IPv6 private ranges:** `::1`, `fe80::`, `fd00::` — these must also be blocked.
  3. **Decimal/octal/hex IP encoding:** `0x7f000001`, `2130706433`, `0177.0.0.1` all resolve to 127.0.0.1.
  4. **Redirect-based SSRF:** Attacker URL returns 302 → `http://169.254.169.254/metadata`. If the server follows redirects, it hits internal endpoints.
  5. **Cloud metadata endpoints:** `169.254.169.254` (AWS/GCP), `169.254.170.2` (ECS), `100.100.100.200` (Alibaba).

  However — re-reading the spec, this validation is for webhook URLs **sent to the WHOOP API** (the server passes the URL to WHOOP's webhook registration endpoint). The SSRF risk is actually that WHOOP's servers will make requests to the attacker-chosen URL. The actual SSRF is on WHOOP's side, not ours. But we should still validate defensively because:
  - We're the interface between the user/AI and the WHOOP API
  - A malicious AI prompt could attempt to register webhooks pointing at internal infrastructure

- **Impact:** If the MCP server is deployed in a cloud VPC and processes webhook URLs without DNS resolution validation, an attacker (or prompt injection) could probe internal services via WHOOP's webhook delivery, or register webhooks to internal endpoints if the request goes through our server.

- **Recommendation:** Implement defense-in-depth webhook URL validation:
  ```typescript
  import { isIP } from "node:net";
  import { lookup } from "node:dns/promises";

  const PRIVATE_RANGES = [
    /^127\./,                    // Loopback
    /^10\./,                     // RFC 1918
    /^172\.(1[6-9]|2\d|3[01])\./, // RFC 1918
    /^192\.168\./,               // RFC 1918
    /^169\.254\./,               // Link-local + cloud metadata
    /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, // CGNAT
    /^0\./,                      // "This" network
  ];
  
  const PRIVATE_IPV6 = ["::1", "fe80::", "fd", "fc"];
  
  async function validateWebhookUrl(urlStr: string): Promise<void> {
    const url = new URL(urlStr);
    
    // 1. Must be HTTPS
    if (url.protocol !== "https:") throw new Error("Webhook URL must use HTTPS");
    
    // 2. No IP literals in hostname
    if (isIP(url.hostname)) throw new Error("Webhook URL must use a domain name, not an IP");
    
    // 3. Resolve DNS and check resolved IP
    const { address } = await lookup(url.hostname);
    if (PRIVATE_RANGES.some(r => r.test(address))) {
      throw new Error("Webhook URL resolves to a private/reserved IP address");
    }
    
    // 4. No non-standard ports (limit attack surface)
    if (url.port && url.port !== "443") throw new Error("Webhook URL must use port 443");
  }
  ```

---

### [MEDIUM-1] OAuth connector: No CSRF `state` parameter enforcement specified

- **Location:** Spec Feature 4, OAuth 2.1 connector
- **Description:** The spec mentions "PKCE S256 enforced" but does not mention the `state` parameter for CSRF protection on the `/authorize` endpoint. While PKCE prevents authorization code interception, it does NOT prevent CSRF attacks where an attacker initiates an OAuth flow and tricks the user into completing it (login CSRF / session fixation).

  The OAuth 2.1 draft (RFC 9126) recommends using `state` alongside PKCE. For the connector pattern, the MCP client (e.g., claude.ai) generates `state` and validates it on the callback — but the spec should explicitly require the server to:
  1. Accept and echo back `state` unchanged
  2. Never modify or omit `state` from the redirect

- **Impact:** Login CSRF — attacker could force a victim to authenticate to the attacker's WHOOP account, potentially leaking the victim's subsequent queries to an attacker-controlled session.

- **Recommendation:** Add to acceptance criteria:
  - `state` parameter MUST be echoed verbatim on redirect to `redirect_uri`
  - If `state` is missing from the authorization request, reject with 400 (some OAuth specs make it optional; for security, make it required)

---

### [MEDIUM-2] Rate limiting on `/authorize` is insufficient; no rate limit on `/token`

- **Location:** Spec Feature 4 — "Rate limiting on `/authorize` (5 attempts per minute per IP)"
- **Description:** The spec only rate-limits `/authorize` (the password prompt page). The `/token` endpoint is unprotected. This allows:
  1. **Authorization code brute-force:** If codes are short or predictable, an attacker can spray `/token` with guessed codes. (Mitigated by PKCE, but defense-in-depth requires rate limiting.)
  2. **Refresh token brute-force:** If an attacker obtains a partial token, they can spray `/token` with `grant_type=refresh_token`.
  3. **No rate limit on bearer token middleware:** The main `/mcp` routes with bearer auth have no rate limiting. An attacker can brute-force `MCP_AUTH_TOKEN` (64-char hex = infeasible, but shorter tokens or leaked partial tokens reduce entropy).

  Additionally, "5 attempts per minute per IP" is too generous for a password endpoint on a single-user server. This allows 7,200 attempts per day — feasible for a weak password.

- **Impact:** Password brute-force on `/authorize`, potential token brute-force on `/token`.

- **Recommendation:**
  1. Rate-limit `/token` at 10 requests per minute per IP
  2. Reduce `/authorize` to 3 attempts per minute, with exponential backoff (lockout after 10 failed attempts for 15 minutes)
  3. Add rate limiting to `/mcp` bearer auth (100 requests/minute per IP — generous but prevents brute-force)
  4. Enforce minimum `MCP_CONNECTOR_PASSWORD` length (12+ characters) at startup
  5. Consider account lockout after N failed `/authorize` attempts

  ```typescript
  // Token bucket per IP — hand-rolled, no deps
  const buckets = new Map<string, { tokens: number; lastRefill: number }>();
  
  function rateLimit(ip: string, maxTokens: number, refillPerSec: number): boolean {
    const now = Date.now();
    const bucket = buckets.get(ip) ?? { tokens: maxTokens, lastRefill: now };
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * refillPerSec);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) return false; // rate limited
    bucket.tokens -= 1;
    buckets.set(ip, bucket);
    return true;
  }
  ```

---

### [MEDIUM-3] Cache key scheme does not prevent cross-user leakage in future multi-user scenarios

- **Location:** Spec Feature 9, "In-Memory Caching"
- **Description:** The spec states "Cache keys don't include tokens; token refresh invalidates cache" in the Security Considerations table. For the current **single-user, single-process** model, this is fine — there's only one user per process. However:

  1. The cache key is `endpoint + params` with no user/token identifier. If the architecture ever evolves to multi-user (spec explicitly defers this as "Non-Goal"), the cache would serve User A's data to User B.
  2. More immediately: the spec says "token refresh invalidates cache" but doesn't specify HOW. If the cache is a simple Map keyed by endpoint+params, a token refresh doesn't automatically invalidate it. The implementation must explicitly `cache.clear()` on token refresh.
  3. The statement "Cache keys don't include tokens" is presented as a security feature, but it's actually a **requirement** — tokens in cache keys would leak tokens into error messages, logs, and memory dumps.

- **Impact:** Low for V3 (single-user only), but architectural debt. If token refresh doesn't clear the cache, stale data from a revoked session could be served.

- **Recommendation:**
  1. Spec should explicitly state: "On token refresh, call `cache.clear()` to prevent serving data authorized under old credentials"
  2. Add a `userIdentifier` (hash of access token) to cache keys as future-proofing — even for single-user, it ensures cache invalidation on token rotation is automatic:
     ```typescript
     function cacheKey(endpoint: string, params: string, tokenHash: string): string {
       return `${tokenHash.slice(0, 8)}:${endpoint}:${params}`;
     }
     ```
  3. Document in code that the cache MUST NOT be shared across user sessions

---

### [MEDIUM-4] Bearer token timing-safe comparison: no specification of encoding handling

- **Location:** Spec Feature 4, `authMiddleware` pseudocode
- **Description:** The spec shows `timingSafeEqual(token, MCP_AUTH_TOKEN)` but `crypto.timingSafeEqual` requires both inputs to be the **same length** (Buffers). If they differ in length, Node.js throws an error. The spec doesn't address:
  1. What happens when an attacker sends a token of different length? If the error propagates as a 500, it leaks timing information (immediate failure = different length, delayed failure = same length, wrong content).
  2. The inputs must be converted to Buffers of equal length before comparison.

- **Impact:** Timing side-channel that reveals token length, reducing brute-force search space.

- **Recommendation:**
  ```typescript
  import { timingSafeEqual, createHash } from "node:crypto";
  
  function safeTokenCompare(provided: string, expected: string): boolean {
    // Hash both to ensure equal length — prevents length oracle
    const a = createHash("sha256").update(provided).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
  }
  ```
  This eliminates the length oracle entirely. Add this to the spec's pseudocode.

---

### [LOW-1] CLI setup: `MCP_CONNECTOR_PASSWORD` strength not enforced

- **Location:** Spec Feature 6, CLI guided setup
- **Description:** The CLI setup flow prompts for `WHOOP_CLIENT_SECRET` (masked) but the `MCP_CONNECTOR_PASSWORD` (used for the OAuth connector's authorize page) has no minimum strength requirement specified. If deployed remotely, a weak password is the single point of failure for accessing all WHOOP data.

- **Impact:** Weak password → brute-force access to WHOOP health data via the OAuth connector.

- **Recommendation:**
  1. Enforce minimum 12 characters at startup when `MCP_TRANSPORT=http`
  2. CLI `setup` command should generate a random password by default: `openssl rand -base64 18`
  3. Warn the user if password entropy is < 60 bits
  ```typescript
  if (MCP_CONNECTOR_PASSWORD && MCP_CONNECTOR_PASSWORD.length < 12) {
    throw new Error("MCP_CONNECTOR_PASSWORD must be at least 12 characters for remote deployment");
  }
  ```

---

### [LOW-2] Docker: `HEALTHCHECK` uses wget without TLS verification

- **Location:** Spec Feature 5, Dockerfile
- **Description:** The health check uses `wget -qO- http://localhost:3000/health`. This is over plaintext HTTP on localhost — which is fine for container-internal checks. However, if the server ever enforces HTTPS-only internally (unlikely but possible), the health check would fail silently. More importantly, `node:20-slim` doesn't include `wget` by default — the Dockerfile doesn't install it.

- **Impact:** Health check may fail in production if `wget` is not available in the slim image, causing orchestrators (ECS, K8s) to restart the container in a loop.

- **Recommendation:** Use Node.js for the health check instead (always available):
  ```dockerfile
  HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1))"
  ```

---

### [LOW-3] OAuth connector: Authorization codes as "one-time use, 60-second expiry" but no storage invalidation specified

- **Location:** Spec Feature 4
- **Description:** The spec says auth codes are "one-time use, 60-second expiry" but doesn't specify the storage mechanism for tracking used codes. For a hand-rolled OAuth server, this requires:
  1. A map/set of issued codes with expiry timestamps
  2. Deletion of the code after first use at `/token`
  3. Periodic cleanup of expired codes to prevent memory leaks

  Without explicit specification, an implementer might forget one-time-use enforcement (check expiry but not consumed status), allowing code replay within the 60s window.

- **Recommendation:** Spec should explicitly state:
  ```typescript
  // In-memory code store (process-scoped, OK for single-instance)
  const authCodes = new Map<string, { 
    expiresAt: number; 
    codeChallenge: string; 
    redirectUri: string;
    consumed: boolean;
  }>();
  
  // On /token: mark consumed=true, reject if already consumed
  // Periodic cleanup: delete entries where Date.now() > expiresAt + 60s
  ```

---

### [INFO-1] `get_correlations` computes health insights — potential liability for medical-sounding advice

- **Location:** Spec Feature 7
- **Description:** The `recommendation` field ("Aim for 7+ hours of sleep to support higher recovery scores") could be construed as health/medical advice. While the spec notes "no medical advice," the line between "actionable recommendation" and "health advice" is fuzzy. This is a compliance/liability concern, not a technical vulnerability.

- **Recommendation:** Add a standard disclaimer to every `get_correlations` response:
  ```typescript
  disclaimer: "This is a statistical observation from your data, not medical advice. Consult a healthcare provider for health decisions."
  ```

---

### [INFO-2] Spec does not address HTTP transport session management

- **Location:** Spec Feature 4
- **Description:** The spec defines bearer token auth and OAuth connector token issuance, but doesn't specify:
  1. Are MCP sessions (tool call state) tied to the bearer token or are they stateless?
  2. If a token is revoked/rotated, do active SSE connections get terminated?
  3. What's the max concurrent connections limit?

  For a single-user server this is low-risk, but worth defining for operational clarity.

- **Recommendation:** Add session management notes:
  - Each HTTP request is independently authenticated (stateless)
  - SSE connections should validate the token periodically (every 5 min) and close if invalid
  - Max concurrent connections: 5 (prevents resource exhaustion from leaked tokens)

---

## Positive Observations

1. **PKCE S256 enforced** — spec correctly mandates S256 and explicitly rejects `plain` method
2. **Fail-closed design** — missing `MCP_AUTH_TOKEN` with HTTP transport = startup error (not silent fallback)
3. **Defense-in-depth on webhooks** — HTTPS + private IP rejection + regex-validated webhook IDs
4. **Non-root Docker** — `USER node` in Dockerfile, multi-stage build avoids dev dependencies in production
5. **No secrets in layers** — runtime env vars only, `.dockerignore` excludes sensitive files
6. **Existing codebase is well-hardened** — state validation, XSS escaping, 0600 file perms, typed errors, PKCE on existing OAuth flow
7. **Hand-rolled rate limiter** — no new dependency for rate limiting (aligns with minimal-deps philosophy)
8. **CLI secret masking** — spec explicitly requires masked input for credential entry

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | High | JWT signing secret = bearer token | Separate `MCP_JWT_SECRET` or derive via HKDF |
| 2 | High | `redirect_uri` allowlist undefined | Define exact-match allowlist, validate on both `/authorize` and `/token` |
| 3 | High | Webhook SSRF: no DNS rebinding/IPv6/encoding protection | Resolve DNS, validate resolved IP, block IP literals |
| 4 | Medium | No CSRF `state` enforcement on connector | Require `state`, echo verbatim |
| 5 | Medium | Rate limiting gaps on `/token` and `/mcp` | Rate-limit all auth-related endpoints |
| 6 | Medium | Cache invalidation on token refresh unspecified | Explicit `cache.clear()` on refresh, document |
| 7 | Medium | Timing-safe compare length oracle | Hash both inputs before comparison |
| 8 | Low | Connector password strength not enforced | Minimum 12 chars, generate by default |
| 9 | Low | Docker HEALTHCHECK uses wget (may not be in slim image) | Use `node -e "fetch(...)"` |
| 10 | Low | Auth code one-time-use storage not specified | Define in-memory code store with consumed flag |

---

## Appendix: Threat Model for HTTP Transport

```
┌──────────────────────────────────────────────────────────┐
│  Deployment: Single-user MCP server on Fly/Railway       │
│  Assets: WHOOP health data (PII: heart rate, sleep, HRV) │
│  Exposure: Public internet (HTTPS)                        │
└──────────────────────────────────────────────────────────┘

Threat Actors:
1. Opportunistic scanner — automated probes, credential stuffing
2. Targeted attacker — knows user has WHOOP MCP, wants health data
3. Prompt injection — malicious content in LLM context attempts tool abuse
4. Insider (LLM service) — the AI client itself could be tricked into misuse

Attack Surface:
- /mcp (bearer auth) — tool execution
- /authorize (password) — OAuth connector entry
- /token (code exchange) — token issuance
- /health (unauthenticated) — information disclosure (minimal)

Key Invariants:
- No unauthenticated access to WHOOP data
- Token compromise = limited blast radius (24h expiry, single-user)
- No write operations on WHOOP account (read-only API)
```
