# Spec: WHOOP MCP Server — V3 Platform Enhancements

> **Status:** Draft (revised per code-review-checkpoint-10 + security-audit-6)
> **Date:** 2026-05-31
> **Baseline:** V2 shipped (0.3.1) — 12 tools, 4 resources, 5 prompts, 433 tests, 98.55% coverage
> **Prior spec:** [v2-feature-enhancements.md](./v2-feature-enhancements.md)
> **Reviews:** [code-review-checkpoint-10](../reviews/code-review-checkpoint-10.md), [security-audit-6](../security-audits/security-audit-6.md)

## Spec Revision Log

- **2026-06-03** — Addresses GitHub issues #124–#150 (see issue tracker). Added explicit rate-limit assumptions section, tradeoffs / open decisions section (covering webhook read-only contradiction options and SDK `ProxyOAuthServerProvider` evaluation), and consolidated cache invalidation rationale. No prior content removed.

---

## Objective

Extend the WHOOP MCP server with platform-level capabilities — remote hosting, better onboarding, deeper analytics, and webhook integration — while **staying fully within WHOOP's public OAuth API** (TOS-compliant, zero account ban risk).

**Target users:** AI assistant users (Claude Desktop, Claude Code, claude.ai web, Cursor, ChatGPT Desktop) who want WHOOP health data accessible from any device.

**Success looks like:**
- Server accessible from claude.ai web/mobile (not just local stdio)
- One-command setup for new users
- Unique analytical moat (correlations, calendar view, composite tools) that competitors with more raw data don't offer
- Webhook-driven alerts without polling

---

## Assumptions

```
ASSUMPTIONS:
1. @modelcontextprotocol/sdk supports Streamable HTTP transport
   ✅ VERIFIED: StreamableHTTPServerTransport in server/streamableHttp.js
2. WHOOP webhook API is available on the public developer API
   ⚠️ GATED: Must verify at developer.whoop.com before Feature 8 implementation
3. OAuth 2.1 + PKCE connector pattern works for claude.ai web
   ✅ VERIFIED: SDK provides OAuthServerProvider interface + mcpAuthRouter()
4. Health data is read-only; webhooks are infrastructure-level writes (subscription management)
   — Webhook create/delete are NOT health data mutations, they configure event delivery
5. No new DIRECT runtime dependencies — leverage SDK's transitive deps
   (express@5, jose, pkce-challenge, express-rate-limit) for HTTP transport + OAuth connector
6. Node.js >= 20 remains the minimum
7. All computation stays in-process (no external database, no SQLite for V3)
→ Correct these now or implementation proceeds with these.
```

---

## Release Plan

| Release | Features | Theme |
|---------|----------|-------|
| **v0.4.0** | `get_today`, natural language dates (extend), `get_calendar` | Quick wins — best demo tools |
| **v0.5.0** | HTTP transport, Dockerfile, guided CLI setup | Remote hosting + onboarding |
| **v0.6.0** | `get_correlations`, webhook management | Analytics moat + push events |
| **v0.7.0** | Caching, write-safety preview pattern (future-proofing) | Performance + architecture |

---

## Feature 1: `get_today` Composite Tool (v0.4.0)

### Objective

Single tool call → today's recovery + last night's sleep + current cycle strain + most recent workout. Saves 3-4 separate tool calls. Best demo tool ("how am I doing today?").

### Design

| Field | Value |
|-------|-------|
| **MCP Name** | `get_today` |
| **Description** | Get today's complete health snapshot — recovery score, last night's sleep, current strain, and last workout in one call |
| **WHOOP Endpoints** | `/v2/recovery` (limit=1), `/v2/activity/sleep` (limit=1), `/v2/cycle` (limit=1) |
| **Scopes** | `read:recovery read:sleep read:cycles` (existing) |
| **Parallelism** | All 3 fetches in parallel (independent endpoints) |
| **Rate limit note** | 3 concurrent requests; WHOOP rate limit is ~100 req/min — well within budget |

### Input Schema

```typescript
z.object({}) // No inputs — always returns "now"
```

### Output Shape

```typescript
interface TodaySnapshot {
  timestamp: string; // ISO 8601 when snapshot was taken
  recovery: {
    score: number;           // 0-100
    hrv_rmssd_milli: number;
    resting_heart_rate: number;
    spo2_pct: number | null;
    skin_temp_celsius: number | null;
  } | null; // null if no recovery scored yet today
  sleep: {
    total_hours: number;
    rem_hours: number;
    deep_hours: number;
    light_hours: number;
    awake_hours: number;
    performance_pct: number;
    efficiency_pct: number;
    respiratory_rate: number | null;
  } | null; // null if no sleep logged yet
  strain: {
    day_strain: number;     // 0-21
    energy_burned_kj: number;
    active_duration_ms: number;
    workout_count: number;
    last_workout: {
      sport_name: string;
      strain: number;
    } | null; // null if no workouts today (extracted from cycle data)
  } | null; // null if cycle hasn't started
  summary: string; // Human-readable one-liner: "Recovery 72% (yellow), 7.2h sleep, strain 8.4"
}
```

### Acceptance Criteria

- [ ] Returns combined data from 3 endpoints in a single response
- [ ] All 3 API calls made in parallel (not serialized)
- [ ] If one endpoint fails, others still return (partial result with null for failed section)
- [ ] If ALL endpoints fail, throws error (not partial empty object)
- [ ] `summary` string generated from available data (handles null sections gracefully)
- [ ] `last_workout` populated from cycle's most recent workout (no extra API call)
- [ ] Response time < 2s under normal conditions (parallel fetches)
- [ ] No new OAuth scopes required
- [ ] Unit tests with mocked API responses for: all succeed, one fails, all fail
- [ ] Integration test verifies tool registration on MCP server

---

## Feature 2: `get_calendar` Grid Tool (v0.4.0)

### Objective

Return a multi-day grid view — recovery scores, sleep hours, strain per day — for 7/14/30-day overviews. Answers "how was my last week?" in one call with structured data perfect for AI summarization.

### Design

| Field | Value |
|-------|-------|
| **MCP Name** | `get_calendar` |
| **Description** | Get a day-by-day grid of recovery, sleep, and strain for a date range. Perfect for weekly/monthly overviews. |
| **WHOOP Endpoints** | `/v2/recovery`, `/v2/activity/sleep`, `/v2/cycle` (all paginated) |
| **Scopes** | `read:recovery read:sleep read:cycles` (existing) |

### Input Schema

```typescript
z.object({
  days: z.number().int().min(1).max(90).optional()
    .describe("Number of days to show. Default: 7. Max: 90."),
  start: z.string().optional()
    .describe("Start date — ISO 8601 or relative ('last 14 days', 'this month'). Defaults to N days ago."),
})
```

### Output Shape

```typescript
interface CalendarGrid {
  period: { start: string; end: string; days: number };
  days: CalendarDay[];
  averages: {
    recovery: number | null;
    sleep_hours: number | null;
    strain: number | null;
  };
}

interface CalendarDay {
  date: string;           // YYYY-MM-DD
  recovery_score: number | null;
  recovery_zone: "green" | "yellow" | "red" | null;
  sleep_hours: number | null;
  sleep_performance_pct: number | null;
  day_strain: number | null;
  workout_count: number;
}
```

### Acceptance Criteria

- [ ] Default 7 days when no `days` param provided
- [ ] Uses auto-pagination internally for ranges > 25 records
- [ ] Sleep assigned to calendar day of `end` timestamp (wake-up day)
- [ ] Sleep spanning midnight correctly assigned to wake-up day
- [ ] Days with no data get null values (not omitted from array)
- [ ] `recovery_zone` computed: green >= 67, yellow >= 34, red < 34
- [ ] `averages` computed from non-null values only
- [ ] Rejects `days` > 90 at Zod validation layer
- [ ] Supports natural language dates in `start` param (existing date-utils)
- [ ] Three endpoint streams paginated in parallel; pagination within each is serial
- [ ] 90-day request completes in < 5s under normal API latency
- [ ] Unit tests with 7-day fixture data verify alignment and averages
- [ ] Edge case: brand new user with 0 days of data → empty `days` array

### Day Alignment Rule

> **Sleep is assigned to the calendar day containing the `end` timestamp (the day you woke up).** This matches WHOOP's own UI which assigns last night's sleep to today's recovery. A sleep starting at 11 PM on Jan 1 and ending 7 AM on Jan 2 belongs to Jan 2. Naps are assigned to their `end` date as well.

### Parallelism Strategy

Pagination within each endpoint is serial (next_token chaining). The three endpoint streams (recovery, sleep, cycle) **run in parallel** since they are independent API endpoints:

---

## Feature 3: Extended Natural Language Dates (v0.4.0)

### Objective

Extend the existing `date-utils.ts` to support additional common expressions that users naturally speak.

### New Expressions (additive — existing ones preserved)

| Expression | Resolves To |
|------------|-------------|
| `"last N weeks"` (1–52) | N×7 days back from today |
| `"last N months"` (1–12) | N calendar months back |
| `"this quarter"` | Q1/Q2/Q3/Q4 start → now |
| `"last quarter"` | Previous quarter start → end |
| `"last year"` | Full previous calendar year |
| `"YYYY-MM"` (e.g., `"2026-05"`) | Full calendar month (1st to last day) |

### Implementation

Add regex patterns to the strict allowlist in `src/tools/date-utils.ts`:

```typescript
const LAST_N_WEEKS_REGEX = /^last\s+(\d+)\s+weeks?$/i;
const LAST_N_MONTHS_REGEX = /^last\s+(\d+)\s+months?$/i;
const THIS_QUARTER_REGEX = /^this\s+quarter$/i;
const LAST_QUARTER_REGEX = /^last\s+quarter$/i;
const LAST_YEAR_REGEX = /^last\s+year$/i;
const MONTH_REGEX = /^(\d{4})-(0[1-9]|1[0-2])$/;
```

### Acceptance Criteria

- [ ] `"last 2 weeks"` → 14 days back from now (UTC)
- [ ] `"last 3 months"` → 3 calendar months back (handles variable month lengths)
- [ ] `"this quarter"` → correct Q start to now (Q1=Jan, Q2=Apr, Q3=Jul, Q4=Oct)
- [ ] `"last quarter"` → previous quarter full range
- [ ] `"last year"` → Jan 1 to Dec 31 of previous year
- [ ] `"2026-05"` → May 1 00:00Z to May 31 23:59:59.999Z
- [ ] N > 52 weeks rejected → `InvalidDateExpression`
- [ ] N > 12 months rejected → `InvalidDateExpression`
- [ ] Case-insensitive: `"Last 2 Weeks"` works
- [ ] All existing date expressions still work (no regression)
- [ ] Unit tests with `vi.useFakeTimers()` for determinism
- [ ] Edge case: "last 1 month" on March 31 (February has fewer days)

---

## Feature 4: Streamable HTTP Transport (v0.5.0)

### Objective

Support `MCP_TRANSPORT=http` (or `both`) mode so the server can be deployed remotely (Fly, Railway, Render) and accessed from claude.ai web, Claude mobile, and multiple devices simultaneously.

### Session Model

```
Session Model: Single WHOOP user, multiple MCP clients.
All MCP clients (stdio + HTTP) access the same WHOOP account.
The OAuth connector authenticates the MCP CLIENT (is this client authorized
to use my WHOOP server?), not the WHOOP USER.
WHOOP OAuth tokens remain server-side (token-store.ts), not per-session.
Each HTTP request is independently authenticated (stateless).
```

### Design

```
┌─────────────────┐       HTTPS        ┌──────────────────────┐
│  Claude Desktop │──── stdio ─────────▶│                      │
│  Claude Code    │                     │   whoop-ai-mcp       │
├─────────────────┤                     │                      │
│  claude.ai web  │──── HTTP/SSE ──────▶│  Transport layer:    │
│  Claude mobile  │                     │  - stdio (default)   │
│  Cursor         │──── HTTP/SSE ──────▶│  - http              │
└─────────────────┘                     │  - both (stdio+http) │
                                        └──────────────────────┘
                                               │
                                               ▼ HTTPS
                                        api.prod.whoop.com
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_TRANSPORT` | No | `"stdio"` (default), `"http"`, or `"both"` |
| `MCP_PORT` | No | Port for HTTP transport. Default: `3000` |
| `MCP_AUTH_TOKEN` | If HTTP | Bearer token for authenticating direct MCP clients. Generate with `openssl rand -hex 32` |
| `MCP_JWT_SECRET` | No | Separate secret for signing OAuth connector JWTs. If unset, derived from `MCP_AUTH_TOKEN` via HKDF. |
| `PUBLIC_URL` | If OAuth connector | Server's public origin (e.g., `https://my-whoop.fly.dev`). Must be HTTPS. |
| `MCP_CONNECTOR_PASSWORD` | If OAuth connector | Password for claude.ai connector OAuth flow. Minimum 12 characters. |
| `ALLOWED_REDIRECT_URIS` | If OAuth connector | Comma-separated allowlist of redirect URIs (exact match). |

### Authentication Gate

HTTP transport MUST be protected:

1. **Bearer token** — `Authorization: Bearer <MCP_AUTH_TOKEN>` on every request
2. **OAuth 2.1 + PKCE connector** (optional) — for claude.ai web/mobile which only support OAuth connectors

```typescript
import { timingSafeEqual, createHash } from "node:crypto";

// Hash both inputs before comparison — prevents length oracle
function safeTokenCompare(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function authMiddleware(req: Request): void {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HttpError(401, "Missing or invalid Authorization header");
  }
  const token = authHeader.slice(7);
  if (!safeTokenCompare(token, MCP_AUTH_TOKEN)) {
    throw new HttpError(401, "Invalid bearer token");
  }
}
```

### OAuth 2.1 Connector (for claude.ai web/mobile)

Claude's web/mobile apps only connect to remote MCPs via an OAuth connector flow. The server implements the SDK's `OAuthServerProvider` interface and uses `mcpAuthRouter()` from `@modelcontextprotocol/sdk/server/auth/router.js` — this provides metadata endpoints, PKCE validation, token exchange, and rate limiting with battle-tested security.

| Endpoint | Purpose | Auth |
|----------|---------|------|
| `GET /.well-known/oauth-authorization-server` | OAuth metadata document | None |
| `GET /authorize` | Authorization page (password prompt) | None (rate-limited) |
| `POST /token` | Token exchange (authorization_code → access_token) | None (rate-limited) |
| `GET /health` | Unauthenticated health check | None |

**Security requirements:**
- PKCE S256 enforced (reject plain)
- `state` parameter MUST be echoed verbatim; rejected if missing (CSRF prevention)
- Authorization codes: one-time use, 60-second expiry, stored with `consumed` flag
- Access tokens: signed JWT (HMAC-SHA256), 24h expiry
- Refresh tokens: signed JWT, 30d expiry
- **JWT signing key:** Derived from `MCP_AUTH_TOKEN` via HKDF (never use the bearer token directly as signing material). If `MCP_JWT_SECRET` is set, use that instead.
- `redirect_uri`: Exact string match against `ALLOWED_REDIRECT_URIS` env var. Validated on BOTH `/authorize` AND `/token`.
- Rate limiting (using SDK's bundled `express-rate-limit`):
  - `/authorize`: 3 attempts per minute per IP, lockout after 10 failed attempts for 15 minutes
  - `/token`: 10 requests per minute per IP
  - `/mcp`: 100 requests per minute per IP (prevents brute-force of bearer token)
- HTTPS required in production (reject HTTP origin in `PUBLIC_URL`)
- `MCP_CONNECTOR_PASSWORD` minimum 12 characters enforced at startup
- Max 5 concurrent HTTP connections (prevents resource exhaustion from leaked tokens)
- SSE connections validate token periodically (every 5 min), close if invalid

**Authorization code storage:**
```typescript
const authCodes = new Map<string, {
  expiresAt: number;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  redirectUri: string;
  consumed: boolean;
  state: string;
}>();
// On /token: mark consumed=true, reject if already consumed
// Periodic cleanup: delete entries where Date.now() > expiresAt + 60s
```

**JWT secret derivation:**
```typescript
import { hkdf } from "node:crypto";

async function deriveJwtSecret(authToken: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    hkdf("sha256", authToken, "whoop-mcp-jwt-v1", "jwt-signing", 32, (err, key) => {
      if (err) reject(err);
      else resolve(Buffer.from(key));
    });
  });
}
```

### Acceptance Criteria

- [ ] `MCP_TRANSPORT=http` starts an HTTP server on `MCP_PORT`
- [ ] `MCP_TRANSPORT=both` starts HTTP server AND accepts stdio connections
- [ ] `MCP_TRANSPORT=stdio` (default) behaves exactly as before (no regression)
- [ ] Bearer token required on all `/mcp` routes — 401 without it
- [ ] Token comparison uses SHA-256 hash (no length oracle)
- [ ] All 12+ tools + 4 resources + 5 prompts work identically over HTTP
- [ ] Implements SDK's `OAuthServerProvider` interface (not hand-rolled OAuth)
- [ ] OAuth 2.1 metadata served at `/.well-known/oauth-authorization-server`
- [ ] PKCE S256 enforced — plain PKCE rejected
- [ ] `state` parameter required and echoed verbatim
- [ ] Auth codes expire after 60s, are one-time use (consumed flag), rejected on replay
- [ ] `redirect_uri` validated as exact string match against `ALLOWED_REDIRECT_URIS`
- [ ] `redirect_uri` checked on BOTH `/authorize` AND `/token`
- [ ] JWT signed with HKDF-derived key, NOT the bearer token itself
- [ ] `/health` returns 200 without auth (for deployment health checks)
- [ ] Rate limits enforced: `/authorize` (3/min), `/token` (10/min), `/mcp` (100/min)
- [ ] `MCP_CONNECTOR_PASSWORD` < 12 chars → startup error
- [ ] Max 5 concurrent connections enforced
- [ ] SSE connections validate token periodically (every 5 min), close if invalid
- [ ] Graceful shutdown: SIGTERM → drain connections → exit
- [ ] Missing `MCP_AUTH_TOKEN` when `MCP_TRANSPORT=http|both` → startup error (fail-closed)
- [ ] Unit tests: auth middleware (length oracle prevention), token validation, OAuth flow, rate limiting
- [ ] Integration test: full tool call over HTTP transport

---

## Feature 5: Docker + Cloud Deployment (v0.5.0)

### Objective

Provide a production-ready Dockerfile and deployment guides for one-click cloud deployment.

### Dockerfile

```dockerfile
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
```

### Deployment Guides (in README)

| Platform | Method |
|----------|--------|
| Fly.io | `fly launch` + `fly secrets set` |
| Railway | Connect GitHub repo + set env vars |
| Render | Blueprint / manual Docker deploy |
| Generic Docker | `docker run` with env vars |

### Acceptance Criteria

- [ ] Multi-stage Dockerfile produces < 100MB image
- [ ] Runs as non-root (`USER node`)
- [ ] Health check uses `node -e "fetch(...)"` (no wget/curl dependency)
- [ ] All env vars configurable at runtime (not baked into image)
- [ ] No secrets in image layers
- [ ] `docker build` succeeds from clean clone
- [ ] README includes deployment instructions for Fly + Railway
- [ ] `.dockerignore` excludes: `node_modules/`, `tests/`, `.git/`, `*.md`, `docs/`

---

## Feature 6: Guided CLI Setup (v0.5.0)

### Objective

Interactive `whoop-ai-mcp setup` command that walks new users through OAuth app creation, credential configuration, and MCP client config generation.

### CLI Commands

| Command | Description |
|---------|-------------|
| `whoop-ai-mcp setup` | Full guided setup (interactive) |
| `whoop-ai-mcp setup --client claude-desktop` | Generate Claude Desktop config |
| `whoop-ai-mcp setup --client claude-code` | Print Claude Code CLI command |
| `whoop-ai-mcp setup --client cursor` | Generate Cursor MCP config |
| `whoop-ai-mcp setup --verify` | Test OAuth connection + fetch profile |

### Interactive Flow

```
$ whoop-ai-mcp setup

🏋️ WHOOP MCP Server Setup
━━━━━━━━━━━━━━━━━━━━━━━━━

Step 1: Create a WHOOP Developer App
  → Open: https://developer.whoop.com/
  → Create an app with redirect URI: http://localhost:3333/callback
  → Required scopes: read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement

Step 2: Enter your credentials
  WHOOP_CLIENT_ID: █
  WHOOP_CLIENT_SECRET: █

Step 3: Verify connection
  ✓ OAuth flow completed
  ✓ Profile fetched: "Shashank M."

Step 4: Configure your AI client
  Which client? [claude-desktop / claude-code / cursor]
  → Writing Claude Desktop config...
  ✓ Config written to ~/Library/Application Support/Claude/claude_desktop_config.json

Done! Restart Claude Desktop to connect.
```

### Implementation Notes

- Uses `readline` (Node built-in) for interactive prompts — no new dependency
- Masks secret input (asterisks)
- **Creates backup before modifying** any existing config file (`.bak` suffix)
- Writes Claude Desktop config (merges with existing, doesn't overwrite)
- If merge fails, restores from backup automatically
- For Claude Code: prints the `claude mcp add` command to run
- `--verify` mode runs OAuth flow + fetches profile to confirm working credentials
- Non-interactive mode via flags: `--client-id=X --client-secret=Y --client=claude-desktop`

### Acceptance Criteria

- [ ] `whoop-ai-mcp setup` starts interactive wizard
- [ ] Secrets masked during input (no echo to terminal)
- [ ] Creates backup of existing config before modification (`.bak` file)
- [ ] If merge fails, original config is restored from backup
- [ ] Claude Desktop config file merged (not overwritten) — preserves other MCPs
- [ ] Claude Code prints correct `claude mcp add` command
- [ ] `--verify` performs OAuth + profile fetch, reports success/failure
- [ ] Non-interactive mode works for CI/scripting
- [ ] Fails gracefully if credentials are wrong (clear error message)
- [ ] No new runtime dependencies (uses Node's `readline`)
- [ ] Tests verify config generation logic (not interactive I/O)

---

## Feature 7: `get_correlations` Tool (v0.6.0)

### Objective

Cross-correlate health metrics to surface insights like "your recovery is higher after 7+ hours of sleep" or "high strain days correlate with lower next-day HRV." This is the **unique analytical moat** — competitors with more raw data don't compute this.

### Design

| Field | Value |
|-------|-------|
| **MCP Name** | `get_correlations` |
| **Description** | Analyze correlations between health metrics — discover how sleep affects recovery, how strain impacts next-day HRV, etc. |
| **WHOOP Endpoints** | `/v2/recovery`, `/v2/activity/sleep`, `/v2/cycle` (paginated) |
| **Scopes** | Existing |

### Input Schema

```typescript
z.object({
  correlation: z.enum([
    "sleep_duration_vs_recovery",
    "strain_vs_next_day_recovery",
    "hrv_vs_sleep_performance",
    "workout_strain_vs_recovery_drop",
    "sleep_consistency_vs_hrv",
  ]).describe("Which correlation to analyze"),
  days: z.number().int().min(14).max(90).optional()
    .describe("Days of data to analyze. Default: 30. Min: 14 (21 for sleep_consistency_vs_hrv)."),
})
```

### Output Shape

```typescript
interface CorrelationResult {
  correlation_type: string;
  period: { start: string; end: string; days: number };
  sample_size: number;
  pearson_r: number;           // -1 to +1
  strength: "strong" | "moderate" | "weak" | "none";
  direction: "positive" | "negative" | "none";
  p_significant: boolean;     // true if |r| > threshold for sample size
  insight: string;            // Human-readable: "Your recovery is 12% higher on days after 7+ hours of sleep"
  data_points: Array<{
    date: string;
    x_value: number;
    y_value: number;
  }>;
  recommendation: string;     // Actionable: "Aim for 7+ hours of sleep to support higher recovery scores"
  disclaimer: string;         // Always: "Statistical observation from your data, not medical advice."
}
```

### Correlation Definitions

| Correlation | X (independent) | Y (dependent) | Hypothesis |
|-------------|----------------|---------------|------------|
| `sleep_duration_vs_recovery` | Sleep hours (night N) | Recovery score (day N+1) | More sleep → higher recovery |
| `strain_vs_next_day_recovery` | Day strain (day N) | Recovery score (day N+1) | Higher strain → lower next-day recovery |
| `hrv_vs_sleep_performance` | HRV (day N) | Sleep performance % (night N) | Higher HRV → better sleep |
| `workout_strain_vs_recovery_drop` | Workout strain | Recovery change (day before → day after) | Higher workout strain → larger recovery drop |
| `sleep_consistency_vs_hrv` | Rolling 7-day std dev of bedtimes | HRV on day N+1 | More consistent sleep → higher HRV |

### `sleep_consistency_vs_hrv` Windowed Computation

This correlation uses a **rolling 7-day window** for the X variable:

```
- Window: rolling 7-day standard deviation of bedtime (time component only, in minutes from midnight)
- X: std-dev of bedtimes in 7-day window ending on day N
- Y: HRV on day N+1
- Minimum data: 21 days (7-day window warmup + 14 paired observations)
- Zod validation: .min(21) enforced for this correlation type specifically
```

### Statistical Implementation

```typescript
// Pearson correlation coefficient — pure TypeScript, no deps
function pearsonR(x: number[], y: number[]): number {
  const n = x.length;
  const meanX = mean(x);
  const meanY = mean(y);
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

// Strength thresholds
function correlationStrength(r: number): "strong" | "moderate" | "weak" | "none" {
  const abs = Math.abs(r);
  if (abs >= 0.7) return "strong";
  if (abs >= 0.4) return "moderate";
  if (abs >= 0.2) return "weak";
  return "none";
}
```

### Statistical Significance (`p_significant`)

`p_significant` is `true` when |r| exceeds the critical value for a two-tailed test at α = 0.05, given the sample size. Use the t-distribution approximation:

```typescript
// t = r * sqrt((n-2) / (1 - r²))
// Compare against critical t-value for df = n-2, α = 0.05 (two-tailed)
// For simplicity, use a precomputed |r| critical value lookup:

const R_CRITICAL_TABLE: Record<number, number> = {
  // n: minimum |r| for p < 0.05 (two-tailed)
  7:  0.754,
  8:  0.707,
  9:  0.666,
  10: 0.632,
  12: 0.576,
  14: 0.532,
  16: 0.497,
  18: 0.468,
  20: 0.444,
  25: 0.396,
  30: 0.361,
  40: 0.312,
  50: 0.279,
  60: 0.254,
  70: 0.235,
  80: 0.220,
  90: 0.207,
};

function isSignificant(r: number, n: number): boolean {
  // Find the closest n in the table (round down to conservative estimate)
  const keys = Object.keys(R_CRITICAL_TABLE).map(Number).sort((a, b) => a - b);
  const key = keys.reverse().find(k => k <= n) ?? keys[keys.length - 1];
  return Math.abs(r) >= R_CRITICAL_TABLE[key];
}
```

**Interpretation guide for AI assistants:**
- `p_significant: true` + `strength: "strong"` → High-confidence finding, safe to recommend action
- `p_significant: true` + `strength: "weak"` → Real but small effect, mention cautiously
- `p_significant: false` → Not enough evidence, present as "no clear pattern found"

### Acceptance Criteria

- [ ] All 5 correlation types produce correct Pearson r values
- [ ] Minimum 14 days required (Zod validation); 21 days for `sleep_consistency_vs_hrv`
- [ ] `strength` correctly mapped from |r| thresholds
- [ ] `insight` string is grammatically correct and includes specific numbers
- [ ] `recommendation` is actionable and health-appropriate (no medical advice)
- [ ] `disclaimer` always present: "Statistical observation from your data, not medical advice."
- [ ] Handles missing data points (days without recovery/sleep score → excluded from correlation)
- [ ] At least 7 valid data point pairs required — fewer → error "Insufficient paired data"
- [ ] `sleep_consistency_vs_hrv` uses rolling 7-day std dev of bedtime (minutes from midnight)
- [ ] `sleep_consistency_vs_hrv` requires minimum 21 days of data
- [ ] `strain_vs_next_day_recovery` correctly offsets by one day (day N strain → day N+1 recovery)
- [ ] `p_significant` uses critical r-value lookup table for α=0.05 two-tailed
- [ ] `p_significant: false` when sample size < 7 (always)
- [ ] Unit tests with hand-computed fixture data verify r values
- [ ] Property-based tests: perfectly correlated input → r = 1.0, random input → |r| < threshold
- [ ] No new runtime dependencies

---

## Feature 8: Webhook Management (v0.6.0)

### Objective

Expose WHOOP's official webhook API (6 event types) through MCP tools. Enables push-based notifications rather than polling.

> **⚠️ GATED:** Before implementing, verify at developer.whoop.com that `/v2/webhook` endpoints exist and are accessible with current OAuth scopes. If not available, defer this feature entirely.

> **Note:** Webhook create/delete are infrastructure-level writes (subscription management), NOT health data mutations. They configure event delivery destinations but do not modify any health records.

### WHOOP Webhook API Reference

| Event Type | Fires When |
|------------|------------|
| `recovery.updated` | New recovery score processed |
| `sleep.updated` | Sleep record finalized |
| `workout.updated` | Workout record finalized |
| `cycle.updated` | Cycle data updated |
| `body_measurement.updated` | Body measurement changed |
| `profile.updated` | Profile information changed |

### Tools

#### `manage_webhooks`

| Field | Value |
|-------|-------|
| **MCP Name** | `manage_webhooks` |
| **Description** | List, create, or delete webhook subscriptions for real-time health data notifications |
| **WHOOP Endpoints** | `/v2/webhook` (GET, POST, DELETE) |
| **Scopes** | Existing (webhooks use same read scopes) |

### Input Schema

```typescript
z.object({
  action: z.enum(["list", "create", "delete"]).describe("Webhook action to perform"),
  // For "create":
  webhook_url: z.string().url().optional()
    .describe("HTTPS URL to receive webhook events (required for 'create')"),
  events: z.array(z.enum([
    "recovery.updated",
    "sleep.updated",
    "workout.updated",
    "cycle.updated",
    "body_measurement.updated",
    "profile.updated",
  ])).optional().describe("Event types to subscribe to (required for 'create')"),
  // For "delete":
  webhook_id: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional()
    .describe("Webhook ID to delete (required for 'delete')"),
})
```

### Output Shape

```typescript
// list
interface WebhookListResult {
  action: "list";
  webhooks: Array<{
    id: string;
    url: string;
    events: string[];
    created_at: string;
  }>;
}

// create
interface WebhookCreateResult {
  action: "create";
  webhook: {
    id: string;
    url: string;
    events: string[];
    created_at: string;
  };
}

// delete
interface WebhookDeleteResult {
  action: "delete";
  deleted_id: string;
  success: boolean;
}
```

### Security: Webhook URL Validation (SSRF Prevention)

Defense-in-depth validation — string checks + DNS resolution:

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

const PRIVATE_IPV6_PREFIXES = ["::1", "fe80:", "fd", "fc"];

async function validateWebhookUrl(urlStr: string): Promise<void> {
  const url = new URL(urlStr);

  // 1. Must be HTTPS
  if (url.protocol !== "https:") throw new Error("Webhook URL must use HTTPS");

  // 2. No IP literals in hostname
  if (isIP(url.hostname)) throw new Error("Webhook URL must use a domain name, not an IP");

  // 3. No non-standard ports
  if (url.port && url.port !== "443") throw new Error("Webhook URL must use port 443");

  // 4. Resolve DNS and check resolved IP (blocks DNS rebinding)
  const { address, family } = await lookup(url.hostname);
  if (family === 4 && PRIVATE_RANGES.some(r => r.test(address))) {
    throw new Error("Webhook URL resolves to a private/reserved IP address");
  }
  if (family === 6 && PRIVATE_IPV6_PREFIXES.some(p => address.startsWith(p))) {
    throw new Error("Webhook URL resolves to a private IPv6 address");
  }
}
```

### Acceptance Criteria

- [ ] ⚠️ **PRE-CONDITION:** Verified that WHOOP `/v2/webhook` endpoints exist in public API
- [ ] `list` returns all registered webhooks for the user
- [ ] `create` registers a new webhook and returns the created object
- [ ] `create` rejects HTTP URLs (requires HTTPS)
- [ ] `create` rejects IP literals in hostname
- [ ] `create` resolves DNS and rejects private/reserved IPs (IPv4 + IPv6)
- [ ] `create` rejects non-443 ports
- [ ] `delete` removes specified webhook by ID
- [ ] `delete` with invalid ID returns clear error
- [ ] Missing required fields per action → Zod validation error
- [ ] Unit tests mock all 3 WHOOP webhook API operations
- [ ] Security tests: private IP, IPv6 loopback, DNS rebinding (mocked lookup), IP literals

### Inbound Webhook Signature Verification

When WHOOP delivers events to our registered webhook URL, we must verify the payload authenticity. Without this, any party that discovers the endpoint can forge events.

> **⚠️ GATED:** Verify WHOOP's actual signing mechanism (header name, algorithm) from their docs before implementing. The design below assumes HMAC-SHA256 (industry standard for webhook signing).

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

const WEBHOOK_SIGNING_SECRET = process.env.WHOOP_WEBHOOK_SECRET; // provided by WHOOP on webhook creation

function verifyWebhookSignature(
  payload: Buffer,
  signatureHeader: string, // e.g., "sha256=abc123..."
  secret: string
): boolean {
  const [algo, providedSig] = signatureHeader.split("=");
  if (algo !== "sha256" || !providedSig) return false;

  const expectedSig = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  // Timing-safe comparison — both are hex strings of equal length
  return providedSig.length === expectedSig.length &&
    timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig));
}
```

**Acceptance criteria (inbound verification):**

- [ ] Incoming webhook requests with missing signature header → 401
- [ ] Incoming webhook requests with invalid signature → 401
- [ ] Valid signature → event processed
- [ ] Signature comparison is timing-safe
- [ ] `WHOOP_WEBHOOK_SECRET` missing at startup → webhook receiver disabled (not a fatal error)
- [ ] Replay protection: reject events with timestamp > 5 minutes old (if WHOOP includes timestamp header)

---

## Feature 9: In-Memory Caching (v0.7.0)

### Objective

Replace the existing `ResourceCache` (in `src/resources/index.ts`) with a unified in-memory cache used by all tools and resources. Reduces redundant API calls when multiple tools/resources access the same data within a short window.

> **Note:** This feature REPLACES the existing `ResourceCache` implementation. Do not create a parallel cache — refactor the existing one into a general-purpose module.

### Design

```typescript
interface CacheEntry<T> {
  data: T;
  fetchedAt: number;      // Date.now()
  ttlMs: number;
}

interface CacheConfig {
  defaultTtlMs: number;   // 5 minutes
  maxEntries: number;     // 100 (LRU eviction)
}
```

### Cache Key Strategy

- Cache key = `endpoint + sorted_query_params` (deterministic)
- **No tokens or auth headers in cache keys** (single-user, no cross-user leakage possible)
- Single-user assumption: process serves one authenticated user at a time

### Cache Invalidation

- On token refresh: call `cache.clear()` (nuclear invalidation — simplest correct approach)
- Rationale: token refresh implies session boundary; stale data more likely after re-auth

### Cache Strategy

| Data Type | TTL | Rationale |
|-----------|-----|-----------|
| Profile | 1 hour | Rarely changes |
| Recovery (latest) | 5 min | Updates once per day, but user may check frequently |
| Sleep (latest) | 5 min | Same |
| Cycle (latest) | 2 min | Strain updates throughout the day |
| Collections | No cache | Too variable by params |

### Acceptance Criteria

- [ ] Existing `ResourceCache` removed and replaced by new unified cache
- [ ] Cache hit returns data without API call (verify via mock call count)
- [ ] Cache miss triggers fetch + stores result
- [ ] Expired entries trigger fresh fetch
- [ ] LRU eviction when `maxEntries` exceeded
- [ ] Cache key = endpoint + sorted params (no tokens/auth in keys)
- [ ] `cache.clear()` called on token refresh
- [ ] `get_today` benefits from cache (3 calls → potentially 0 if all cached)
- [ ] Resources use cache (recovery/sleep/cycle latest)
- [ ] Cache is per-process, not persisted (dies with process restart)
- [ ] No new runtime dependencies
- [ ] Unit tests verify TTL expiration, LRU eviction, hit/miss, and clear-on-refresh behavior

---

## Feature 10: Write-Safety Preview Pattern (v0.7.0)

### Objective

Architecture-level preparation for future write operations. If/when WHOOP adds write endpoints to the public API, the pattern is ready.

### Design

```typescript
interface WritePreview<T> {
  preview: true;
  will_execute: {
    method: "POST" | "PUT" | "DELETE";
    path: string;
    body_summary: T;
    idempotency_key: string;  // UUID v4, generated per preview
  };
  set_confirm_true_to_run: true;
}

interface WriteReceipt<T> {
  preview: false;
  executed: true;
  result: T;
  idempotency_key: string;  // Same key from the preview that was confirmed
}

type WriteResult<T> = WritePreview<T> | WriteReceipt<T>;
```

### Acceptance Criteria

- [ ] `withPreview()` utility function implemented and exported
- [ ] Pattern tested with mock write tool
- [ ] Default `confirm: false` returns preview shape with `idempotency_key`
- [ ] `confirm: true` executes the actual write, echoes same `idempotency_key`
- [ ] `idempotency_key` is UUID v4 format, unique per preview
- [ ] Discriminated union type (`preview: true | false`) enables type-safe handling
- [ ] No actual write tools registered yet (just the pattern + utility)
- [ ] Documented in README as "future-ready for write operations"

---

## Non-Goals for V3

| Feature | Reason to Defer |
|---------|-----------------|
| Private iOS API access | Violates WHOOP TOS — never |
| SQLite/persistent storage | In-memory cache sufficient for V3 |
| Multi-user support | Requires fundamentally different auth model; single-user assumption throughout |
| Real-time streaming (WebSocket) | WHOOP has no streaming API |
| OS keychain integration | Platform-specific, dotfile is sufficient |
| Strength Trainer / Journal | Not available on public API |
| Health data writes | WHOOP public API is read-only. Webhook create/delete are infrastructure writes only |

---

## New Project Structure (V3 additions)

```
src/
├── index.ts                    # Entry point (updated: transport selection via MCP_TRANSPORT)
├── server.ts                   # MCP server (updated: new tools registered)
├── transport/
│   ├── stdio.ts                # Stdio transport setup (extracted from index.ts)
│   ├── http.ts                 # Streamable HTTP transport + auth middleware
│   └── oauth-connector.ts      # OAuthServerProvider implementation (SDK interface)
├── cli/
│   ├── setup.ts                # Interactive setup wizard (with config backup)
│   └── config-generators.ts    # Claude Desktop / Code / Cursor config
├── cache/
│   └── memory-cache.ts         # LRU in-memory cache (replaces ResourceCache)
├── logging/
│   └── logger.ts              # Structured JSON logger (stderr, requestId correlation)
├── tools/
│   ├── get-today.ts            # NEW: get_today composite
│   ├── get-calendar.ts         # NEW: get_calendar grid
│   ├── get-correlations.ts     # NEW: get_correlations
│   ├── manage-webhooks.ts      # NEW: manage_webhooks (gated on API availability)
│   └── write-safety.ts         # NEW: withPreview() pattern + idempotency_key
├── api/
│   └── webhook-types.ts        # NEW: Webhook API types

tests/
├── transport/
│   ├── http.test.ts            # Auth middleware, rate limits, length oracle
│   └── oauth-connector.test.ts # OAuthServerProvider, state, PKCE, redirect_uri
├── logging/
│   └── logger.test.ts          # Format, level filtering, requestId propagation
├── cli/
│   └── setup.test.ts           # Config generation, backup/restore
├── cache/
│   └── memory-cache.test.ts    # TTL, LRU, clear-on-refresh
├── tools/
│   ├── get-today.test.ts
│   ├── get-calendar.test.ts
│   ├── get-correlations.test.ts # Windowed computation, disclaimer
│   ├── manage-webhooks.test.ts  # SSRF DNS resolution mocks
│   └── write-safety.test.ts    # idempotency_key, preview/confirm

Dockerfile                       # NEW: Multi-stage production image
.dockerignore                    # NEW: Exclude non-production files
```

---

## Implementation Order

| # | Feature | Release | Dependencies | Complexity |
|---|---------|---------|--------------|------------|
| 1 | Extended natural language dates | v0.4.0 | None (extends existing date-utils) | Low |
| 2 | `get_today` composite tool | v0.4.0 | None | Low |
| 3 | `get_calendar` grid tool | v0.4.0 | Auto-pagination (exists), date-utils | Medium |
| 4 | HTTP transport + auth middleware | v0.5.0 | None | High |
| 5 | Observability (structured logging) | v0.5.0 | HTTP transport (requestId) | Medium |
| 6 | OAuth 2.1 connector | v0.5.0 | HTTP transport | High |
| 7 | Dockerfile + deployment | v0.5.0 | HTTP transport | Low |
| 8 | Guided CLI setup | v0.5.0 | None | Medium |
| 9 | `get_correlations` tool | v0.6.0 | Stats-utils (exists), pagination | Medium |
| 10 | Webhook management | v0.6.0 | Webhook types | Medium |
| 11 | In-memory cache | v0.7.0 | None | Medium |
| 12 | Write-safety pattern | v0.7.0 | None | Low |

---

## Testing Strategy

- **Same as V1/V2:** Mock WHOOP API, never hit real endpoints in tests
- **HTTP transport:** Test with supertest-style HTTP assertions against in-process server
- **Auth middleware:** Test SHA-256 length oracle prevention (equal-length strings, different content)
- **Rate limiting:** Test with `express-rate-limit` on each endpoint category
- **OAuth connector:** Test full OAuth flow with mocked client, including state param and PKCE
- **CLI:** Test config generation logic + backup/restore behavior; interactive I/O manual QA only
- **Correlations:** Hand-computed fixture data + property-based tests; windowed computation for `sleep_consistency_vs_hrv`
- **Webhooks:** SSRF tests with mocked DNS resolution (private IPs, IPv6, IP literals)
- **Cache:** Time-based tests with `vi.useFakeTimers()`, verify `cache.clear()` on token refresh
- **Coverage target:** Maintain >90% on new code, >80% overall
- **No new test runtime dependencies** (Vitest sufficient for everything)

---

## Observability (v0.5.0+)

Remote deployment requires structured observability. Without it, debugging production issues requires SSH access and log tailing.

### Structured Logging

```typescript
import { randomUUID } from "node:crypto";

interface LogEntry {
  ts: string;             // ISO 8601
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  requestId?: string;     // Correlation ID per MCP request
  tool?: string;          // Tool name if within a tool call
  durationMs?: number;    // For timed operations
  error?: string;         // Error message (never stack traces in production)
  [key: string]: unknown; // Additional context
}

// Log level controlled by LOG_LEVEL env var (default: "info")
// Output: JSON lines to stderr (stdout reserved for stdio transport)
```

### Request Correlation

Every inbound MCP request (HTTP or stdio) gets a `requestId` (UUID v4) that propagates through:
- Tool handler execution
- WHOOP API calls
- Cache lookups
- Error paths

This enables tracing a single user question through all backend operations.

### WHOOP API Observability

| Event | Log Level | Fields |
|-------|-----------|--------|
| API request sent | `debug` | `requestId`, endpoint, method |
| API response received | `debug` | `requestId`, endpoint, status, `durationMs` |
| API 429 (rate limited) | `warn` | `requestId`, endpoint, `retryAfterMs`, attempt number |
| API 5xx (server error) | `warn` | `requestId`, endpoint, status, `durationMs` |
| API timeout (>10s) | `error` | `requestId`, endpoint, `durationMs` |
| Token refresh triggered | `info` | `requestId`, reason (401 / expiry) |
| Token refresh failed | `error` | `requestId`, error message |

### Health Endpoint Response (for `/health`)

```typescript
interface HealthResponse {
  status: "ok" | "degraded" | "error";
  uptime_seconds: number;
  whoop_api: {
    last_success: string | null;   // ISO 8601 timestamp
    last_error: string | null;     // ISO 8601 timestamp
    consecutive_errors: number;
  };
  connections: {
    active: number;
    max: number;
  };
}
// "degraded" = WHOOP API had >3 consecutive errors
// "error" = token refresh failed (server cannot serve data)
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `"info"` | Minimum log level: `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `"json"` | `"json"` (production) or `"pretty"` (development) |

### Implementation Notes

- Zero runtime dependencies — just `JSON.stringify` to stderr
- Structured JSON for machine parsing (Fly, Railway, Datadog all ingest JSON logs)
- `LOG_FORMAT=pretty` uses: `[2026-05-31T14:02:33Z] INFO  get_today completed {requestId=a1b2c3, durationMs=842}`
- Never log tokens, secrets, or full request/response bodies
- Log to **stderr** always (stdout is reserved for stdio MCP transport)

### Acceptance Criteria

- [ ] All logs are structured JSON to stderr (not stdout)
- [ ] Every MCP request gets a unique `requestId` (UUID v4)
- [ ] `requestId` propagates to WHOOP API calls and error logs
- [ ] WHOOP API 429 responses logged at `warn` with retry timing
- [ ] WHOOP API timeouts (>10s) logged at `error`
- [ ] `/health` endpoint returns structured status including WHOOP API health
- [ ] `LOG_LEVEL` env var controls verbosity (default: `info`)
- [ ] `LOG_FORMAT=pretty` for human-readable local development
- [ ] No tokens, secrets, or PII in log output
- [ ] Unit tests verify log output format and level filtering

---

## Security Considerations

| Area | Threat | Mitigation |
|------|--------|------------|
| HTTP transport | Unauthorized access | Bearer token (SHA-256 hash compare, no length oracle) + fail-closed |
| HTTP transport | Brute-force | Rate limits: `/authorize` 3/min, `/token` 10/min, `/mcp` 100/min |
| HTTP transport | Connection exhaustion | Max 5 concurrent connections enforced |
| OAuth connector | Open redirect | Exact string match against `ALLOWED_REDIRECT_URIS` env var |
| OAuth connector | CSRF | `state` parameter required + PKCE S256 enforced |
| OAuth connector | Token theft | HKDF-derived JWT signing key (not bearer token), short-lived JWTs |
| OAuth connector | Replay attack | Auth codes one-time use (consumed flag), expire after 60s |
| Webhook URLs | SSRF | DNS resolution check, reject private IPs (v4+v6), reject IP literals, port 443 only |
| Inbound webhooks | Forgery | HMAC-SHA256 signature verification, timing-safe compare, reject stale (>5 min) |
| CLI secrets | Terminal logging | Mask input, don't echo to stdout |
| CLI config | Corruption | Backup `.bak` before modification, restore on failure |
| Docker image | Secret leakage | No secrets baked in; runtime env vars only |
| Cache | Cross-request leakage | No tokens in cache keys; single-user assumption; `cache.clear()` on refresh |
| Connector password | Weak secrets | `MCP_CONNECTOR_PASSWORD` must be ≥ 12 chars (startup validation) |
| SSE transport | Stale sessions | Token re-validated every 5 min, connection closed if invalid |
| Logging | Secret leakage | Never log tokens, secrets, or PII; structured output to stderr only |

---

## WHOOP API Rate Limit Assumptions

> Addresses #149. Documents the rate-limit budget that parallel-fetching tools (`get_today`, `get_calendar`) and the cache TTLs are designed against.

| Assumption | Value | Source |
|------------|-------|--------|
| Per-user request budget | ~100 req/min (working assumption) | WHOOP developer docs do not publish a hard public number; verify before v0.4.0 ships |
| Burst tolerance | 5–10 concurrent requests appears safe in practice | Empirical from V1/V2 testing |
| 429 response | API client already retries with `Retry-After` honoring + exponential backoff | `src/api/client.ts` |

**Per-tool budget impact:**

| Tool | Worst-case requests | Notes |
|------|---------------------|-------|
| `get_today` | 3 (parallel) | Single shot per invocation |
| `get_calendar` (90 days) | ~12 (4 pages × 3 endpoints, parallel across endpoints, serial within each) | Within 100/min budget |
| `get_correlations` (30–90 days) | ~9–12 | Same shape as calendar |

**Defenses:**
- Client-level `Retry-After` honoring already implemented (V1).
- Cache (Feature 9) reduces redundant fetches across rapid successive tool calls.
- **Open:** consider a process-wide concurrency limiter (semaphore, e.g. p-limit-style ≤ 8) if real-world 429s appear after v0.4.0 ships. Tracked under Open Questions #2.

---

## Tradeoffs / Open Decisions

This section captures decisions where the issue tracker raised valid alternatives that should NOT be picked unilaterally during spec revision. Each is a product decision to be resolved before the corresponding feature lands.

### TD-1: Webhook management vs. read-only invariant (refs #128)

Feature 8 (`manage_webhooks`) issues `POST /v2/webhook` and `DELETE /v2/webhook/:id`. Assumption #4 has been softened to "infrastructure-level writes," but the underlying decision remains open:

| Option | Rationale | Cost |
|--------|-----------|------|
| **A. Frame as infrastructure write (current spec text)** | Webhook subscriptions are not health-data mutations. Aligns with how most MCP servers expose webhook setup. | Slight expansion of "read-only" promise we made to users. |
| **B. Gate Feature 8 entirely on developer.whoop.com confirmation** | Removes contradiction by making webhooks conditional. | Webhook feature may be deferred indefinitely if API is private. |
| **C. Drop Feature 8; provide a CLI-only webhook helper outside MCP** | Keeps the MCP surface 100% read. | Loses LLM-driven webhook management. |

**Status:** Spec currently encodes A + B together (Feature 8 is gated on API availability and reframed as infra). Final decision deferred to v0.6.0 planning.

### TD-2: SDK `ProxyOAuthServerProvider` vs. self-issued JWTs (refs #150)

The SDK ships `ProxyOAuthServerProvider` (`server/auth/providers/proxyProvider.js`) which proxies an upstream OAuth server rather than issuing local tokens. Since this server already authenticates against WHOOP OAuth, proxying could eliminate the custom JWT layer entirely.

| Option | Rationale | Cost |
|--------|-----------|------|
| **A. Self-issued JWTs (current spec, HKDF-derived signing key)** | Decouples MCP-client auth from WHOOP-user auth — fits Session Model (single WHOOP user, many MCP clients). | More moving parts: JWT signing, expiry, rotation. |
| **B. ProxyOAuthServerProvider proxying WHOOP OAuth** | Zero custom JWT code; SDK-blessed pattern. | Forces every MCP client to complete a WHOOP OAuth flow — breaks the "one WHOOP user, many devices" model documented in Session Model. |
| **C. ProxyOAuthServerProvider proxying a different upstream IdP (e.g., self-hosted)** | Cleanest separation. | Requires standing up an IdP for what is currently a single-user tool. |

**Status:** Spec retains A. Re-evaluate in v0.5.0 implementation kickoff after spiking ProxyOAuthServerProvider against a real claude.ai connector handshake.

---

## Success Metrics

| Metric | Current (v0.3.1) | Target (v0.7.0) |
|--------|-------------------|-----------------|
| MCP tools | 12 | 16 (+4: today, calendar, correlations, webhooks) |
| MCP resources | 4 | 4 (unchanged) |
| MCP prompts | 5 | 5 (unchanged) |
| Transport modes | 1 (stdio) | 2 (stdio + HTTP) |
| Deployment options | Local only | Local + Docker + Fly + Railway |
| Test count | 433 | ~600 (est.) |
| npm weekly downloads | Track | 2x current |
| "How am I doing today?" | 3 tool calls | 1 tool call (`get_today`) |
| Multi-device access | ❌ | ✅ (via HTTP transport) |
| Setup time (new user) | ~10 min manual | ~3 min guided |

---

## Resolved Questions

| # | Question | Resolution |
|---|----------|------------|
| 1 | Does SDK support Streamable HTTP? | ✅ Yes — `StreamableHTTPServerTransport` available in `@modelcontextprotocol/sdk` |
| 2 | Do we need Express for HTTP? | ✅ SDK bundles Express 5 as transitive dep — use it directly |
| 3 | OAuth implementation approach? | ✅ Implement SDK's `OAuthServerProvider` interface (not hand-rolled) |
| 4 | Rate limiting library? | ✅ `express-rate-limit` available as SDK transitive dep — use it |
| 5 | Minimum correlation sample size? | ✅ 7 paired observations minimum, 14 for standard, 21 for `sleep_consistency_vs_hrv` |
| 6 | `get_today` include workout details? | ✅ Include `last_workout` summary (type + strain + duration), not full details |
| 7 | OAuth connector vs callback-server? | ✅ Separate module — different lifecycle and security model |

## Open Questions

1. Does WHOOP's webhook API require a separate scope or use existing `read:*` scopes? (Verify at developer.whoop.com before implementing Feature 8)
2. What's WHOOP's actual rate limit on their API? (Needed to set cache TTLs appropriately)
3. Should `MCP_TRANSPORT=both` be the default when HTTP is configured, or require explicit opt-in? (Propose: explicit — `stdio` remains default for backward compatibility)

---

## Revision History

| Date | Change |
|------|--------|
| 2026-05-31 | Initial V3 platform enhancement spec drafted |
| 2026-06-01 | Incorporated code-review-checkpoint-10 (16 issues) + security-audit-6 (10 findings). Key changes: SDK OAuthServerProvider (not hand-rolled), HKDF JWT derivation, SHA-256 length oracle prevention, full SSRF DNS resolution, `sleep_consistency_vs_hrv` windowed computation, cache replaces ResourceCache, `idempotency_key` on write pattern, Docker healthcheck uses node fetch, CLI config backup, `MCP_TRANSPORT=both`, rate limits per endpoint, max connections, state param, connector password validation, disclaimer field on correlations |
| 2026-06-01 | Addressed final review gaps: (1) webhook inbound signature verification (HMAC-SHA256), (2) `p_significant` critical r-value lookup table (\u03b1=0.05 two-tailed), (3) observability section — structured JSON logging, request correlation IDs, WHOOP API health tracking, `/health` endpoint schema |
| 2026-06-03 | Single-pass revision against issues #124–#150. Added Spec Revision Log, WHOOP API Rate Limit Assumptions section (#149), and Tradeoffs / Open Decisions section covering webhook read-only contradiction (#128) and `ProxyOAuthServerProvider` evaluation (#150). All HIGH/MEDIUM/LOW security findings (#124–#126, #131, #133, #135, #137, #139, #141, #142) and remaining checkpoint-10 items (#127, #130, #132, #134, #136, #138, #140, #143–#148) verified against existing spec text — most were already encoded in the 2026-06-01 pass; this revision tightens cross-references rather than re-introducing content. |
