# Deploying to Fly.io

A personal, single-user deployment that claude.ai can reach as an OAuth
connector. Roughly 15 minutes, most of it waiting on `fly deploy`.

## Before you start

You need three things from elsewhere:

| | Where it comes from |
|---|---|
| `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` | your app at developer.whoop.com |
| `WHOOP_REFRESH_TOKEN` | `~/.whoop-mcp/tokens.json`, after running `node dist/index.js setup --verify` once on a machine with a browser |
| A Fly account | `fly auth signup` — a card is required even on the small tiers |

Your WHOOP app must have all seven scopes enabled, **`offline` included**.
Without `offline` WHOOP issues no refresh token and this deployment cannot work.

## 1. Create the app

```bash
fly launch --no-deploy --copy-config
```

Answer **no** to Postgres, Redis and any other add-on. Then edit `fly.toml` and
replace both occurrences of `CHANGE-ME` — `app` and `PUBLIC_URL` — with the app
name Fly assigned you. They must agree: `PUBLIC_URL` is the OAuth issuer
claude.ai will fetch metadata from, and a mismatch fails at connector setup
with an error that does not say so.

## 2. Create the volume

```bash
fly volumes create whoop_tokens --size 1 --region ams
```

Use the same region as `primary_region`. This is not optional — see the comment
on `[mounts]` in `fly.toml` for why the deployment cannot survive a restart
without it.

## 3. Set the secrets

```bash
fly secrets set \
  WHOOP_CLIENT_ID="..." \
  WHOOP_CLIENT_SECRET="..." \
  WHOOP_REFRESH_TOKEN="..." \
  MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  MCP_CONNECTOR_PASSWORD="$(openssl rand -base64 24)"
```

- `MCP_AUTH_TOKEN` — the bearer for direct clients (Claude Code, Desktop).
- `MCP_CONNECTOR_PASSWORD` — what you type into the claude.ai connector dialog.
  Save it somewhere you can find it again; you cannot read it back out of Fly.

`PUBLIC_URL` and `ALLOWED_REDIRECT_URIS` are not secret and live in `fly.toml`.

## 4. Deploy

```bash
fly deploy
fly logs
```

A healthy boot logs the token refresh and then the listening port. Failure
modes worth recognising:

- **`Cannot authenticate with WHOOP … nonInteractive`** — the refresh token was
  rejected. Usually it had already been consumed: WHOOP rotates on every use,
  so a token you have used locally since copying it is dead. Re-run the setup
  wizard and set the fresh value.
- **Machine restarts in a loop** — read the actual error in `fly logs`. The
  server exits rather than hanging by design, so a loop means a real fault.

Confirm it is up:

```bash
curl https://<your-app>.fly.dev/health          # {"status":"ok"}
curl -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
     https://<your-app>.fly.dev/health          # adds uptime + whoopApi: "ok"
```

The authenticated form is the one that matters — `whoopApi: "ok"` proves the
server can actually reach WHOOP with your token, not merely that it booted.

## 5. Add it to claude.ai

Settings → Connectors → Add custom connector. Give it your
`https://<your-app>.fly.dev` URL, and the `MCP_CONNECTOR_PASSWORD` when asked.

Once it appears as connected, any Claude session on your account — including
scheduled Routines — can read your WHOOP data.

## Cost and sleeping

`min_machines_running = 0` lets the machine stop when idle, which keeps the bill
to roughly the volume plus a little compute. The trade is a cold start on the
first call after a sleep: container boot plus a WHOOP token refresh, a handful
of seconds. Fine for a scheduled agent; mildly annoying interactively. Set it to
`1` if you would rather pay to avoid it.

## Rotating the WHOOP secret later

Regenerating the secret at developer.whoop.com does not invalidate the stored
refresh token, but every future refresh is signed with the new secret. Run
`fly secrets set WHOOP_CLIENT_SECRET="..."` — that triggers a redeploy, the
volume survives, and the stored token keeps working.
