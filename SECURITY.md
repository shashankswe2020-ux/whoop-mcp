# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅ Yes    |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in `whoop-mcp`, please report it privately:

1. Go to **[Security Advisories](https://github.com/shashankswe2020-ux/whoop-mcp/security/advisories/new)** and open a new draft advisory.
2. Alternatively, email the maintainer directly — contact details are on the [GitHub profile](https://github.com/shashankswe2020-ux).

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a minimal proof-of-concept
- Any suggested mitigations, if known

You should receive an acknowledgment within **48 hours** and a resolution timeline within **7 days** for confirmed issues.

## Security Design

### OAuth Tokens

- Tokens are stored at `~/.whoop-mcp/tokens.json` with `0600` permissions (user-only read/write).
- The token directory is created with `0700` permissions.
- Tokens are never logged, printed to stdout, or included in error messages.
- Access tokens are refreshed automatically before expiry (with a 60-second safety buffer).

### OAuth Flow

- Uses Authorization Code flow with a `state` parameter for CSRF protection.
- Uses PKCE (`S256`) with per-login `code_verifier` / `code_challenge` values.
- The callback server binds to `127.0.0.1` only — never `0.0.0.0`.
- The callback server shuts down immediately after receiving the code (or on timeout/error).
- All HTML responses in the callback server escape user-controlled parameters to prevent reflected XSS.
- Browser is opened via `spawn` with an argument array — no shell string interpolation.

### API Client

- All WHOOP API requests include a 30-second timeout via `AbortSignal.timeout`.
- Rate limit responses (HTTP 429) are retried with exponential backoff, capped at 3 retries.
- The `Retry-After` header is respected but capped at 60 seconds.
- All non-2xx responses throw typed errors — raw bodies are never passed to users unmarshalled.

### Credentials

- `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` are read exclusively from environment variables.
- Credentials are never written to disk, logged, or included in error output.
- The `.gitignore` excludes `.env` files, `tokens.json`, and `dist/`.

### Dependency Surface

- Two runtime dependencies: `@modelcontextprotocol/sdk` and `zod`.
- All other dependencies are development-only (TypeScript tooling, test framework).
- Run `npm audit` to check for known vulnerabilities in the dependency tree.

## Known Limitations

- **Single-user design** — Token storage is per-user on the local filesystem. This server is not designed for multi-user or server-side deployments.
