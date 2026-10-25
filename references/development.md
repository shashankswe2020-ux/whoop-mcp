# Development and Releases

[Back to README](../README.md)

## Development

Use Node >=20 for the npm client, or Node >=22 when working on the separate
collector/dashboard package. Tests mock WHOOP; automated checks must never use
real account data. Run the client and collector suites below for the current
checkout's test results; release-specific verification belongs in the changelog.

### Setup

```bash
git clone https://github.com/shashankswe2020-ux/whoop-mcp.git
cd whoop-mcp
npm ci
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Build TypeScript |
| `npm test` | Run mocked client tests (Vitest 4) |
| `npm run test:coverage` | Run tests with coverage |
| `npm run typecheck` | Type check (`tsc --noEmit`) |
| `npm run lint` | Lint (ESLint) |
| `npm run lint:fix` | Lint + auto-fix |
| `npm run format` | Format (Prettier) |
| `npm run format:check` | Verify configured source formatting |
| `npm run dev` | Run in dev mode (tsx) |
| `npm audit` | Audit all client dependencies, including development tools |

The collector is a separate private package, not included in the npm client:

```bash
npm --prefix collector ci
npm --prefix collector test
npm --prefix collector run typecheck
npm --prefix collector run lint
npm --prefix collector run format:check
npm --prefix collector run build
npm --prefix collector run build:dashboard
npm --prefix collector audit
```

Both collector builds are local dry runs; deployment requires separately configured
Cloudflare infrastructure. See [operator documentation](../collector/README.md).
The [public website](https://whoopconnector.com/) is maintained independently in
the private [whoop-mcp-site repository](https://github.com/shashankswe2020-ux/whoop-mcp-site).
Its source, tests, statistics generator and operating documentation live only
there. Until the custom domain moves from GitHub Pages to Cloudflare Pages,
`.github/workflows/pages.yml` in this repository checks out the site repository
with a read-only deploy key (`SITE_DEPLOY_KEY`), runs its checks, refreshes the
download and star counts, and deploys to GitHub Pages. It runs daily at 06:17 UTC
and can be started manually after site changes:
`gh workflow run pages.yml -R shashankswe2020-ux/whoop-mcp`.

### Project Structure

```
src/
├── index.ts              # CLI dispatch, auth, telemetry and transport startup
├── server.ts             # MCP server + tool/resource/prompt registration
├── privacy.ts            # Process-level disclosure policy
├── cli/                  # Multi-client setup, consent and local diagnostics
├── cache/                # Process-local LRU/TTL cache
├── logging/              # Structured stderr logging
├── telemetry/            # Optional bounded metadata sender
├── transport/            # Authenticated Streamable HTTP
├── auth/
│   ├── oauth.ts          # OAuth2 Authorization Code flow
│   ├── token-store.ts    # Secure token persistence
│   └── callback-server.ts # Local OAuth callback server
├── api/
│   ├── client.ts         # HTTP client with retry + refresh
│   ├── pagination.ts     # Auto-pagination utility (fetchAllPages)
│   ├── types.ts          # WHOOP API response types
│   └── endpoints.ts      # API URL constants
├── resources/
│   └── index.ts          # MCP Resource handlers (4 resources)
├── tools/
│   ├── get-profile.ts
│   ├── get-recovery.ts
│   ├── get-sleep.ts
│   ├── get-workout.ts
│   ├── get-cycle.ts
│   ├── get-body-measurement.ts
│   ├── get-sleep-by-id.ts
│   ├── get-workout-by-id.ts
│   ├── get-cycle-by-id.ts
│   ├── get-weekly-summary.ts   # Analytical: weekly health report
│   ├── compare-periods.ts      # Analytical: period comparison
│   ├── get-trend.ts            # Analytical: trend detection
│   ├── get-today.ts            # Composite: today's snapshot
│   ├── get-calendar.ts         # Grid: multi-day calendar view
│   ├── get-baselines.ts        # Personal distributions with sample safeguards
│   ├── get-sleep-debt.ts       # Observed deficits and sleep consistency
│   ├── date-utils.ts           # Relative date expression parser
│   ├── stats-utils.ts          # Statistics (mean, median, regression)
│   └── collection-utils.ts
└── prompts/
  └── index.ts                # MCP Prompt handlers (5 prompts)

tests/                         # Mirrors client source; mocked WHOOP data
collector/                     # Separate Workers/D1 collector and private dashboard
docs/                          # Specifications, plans and verification records
```

## Releases & npm Package

This project is published on npm as [`whoop-ai-mcp`](https://www.npmjs.com/package/whoop-ai-mcp).

```bash
npm install -g whoop-ai-mcp@latest
```

Or run directly with `npx`:

```bash
npx -y whoop-ai-mcp@latest
```

The server command needs WHOOP credentials; use `setup` for configuration first.
Review the changelog before upgrading. For a global installation, rerun
`npm install -g whoop-ai-mcp@latest`, then restart the client. The `@latest` and
unversioned wizard-generated launch entries resolve npm's latest dist-tag on
launch; inspect the actual launched version when diagnosing issues.

### Release Process

1. Synchronize `package.json`, `package-lock.json`, `server.json` and the changelog.
2. Pass tests, lint, typecheck, formatting, build, package inspection and full
  dependency audits, including collector checks when affected. Review and merge
  only the intended changes; leave unrelated working-tree edits out.
3. Tag the approved merge commit `vX.Y.Z` and push that tag.
4. Verify the [Release workflow](../.github/workflows/release.yml) creates the correct
  GitHub release and changelog notes.
5. Verify the [npm publish workflow](../.github/workflows/npm-publish.yml) runs for
  the same commit. Releases created by `GITHUB_TOKEN` do not trigger downstream
  release workflows; use its manual dispatch on the approved tag when necessary.
6. Confirm the npm version/dist-tag and smoke-test the published artifact.
  Registry propagation can lag a successful upload; do not blindly republish.
  Verify MCP Registry metadata separately. Coordinate website release metadata
  updates with the independent site repository.

### Changelog

See [CHANGELOG.md](../CHANGELOG.md) for a full list of changes in each release.
