# Hosting WHOOP MCP for free on a GCP e2-micro VM (Caddy + DuckDNS)

This runs the server always-on for **~$0/month** using Google Cloud's
perpetual **Always Free** `e2-micro` instance, with free TLS from
**Caddy + Let's Encrypt** and a free **DuckDNS** hostname. It's reachable by
**claude.ai web and mobile** via the OAuth 2.1 connector.

```
claude.ai (web/mobile)
      │  https://YOURSUB.duckdns.org/mcp   (OAuth 2.1 + PKCE, JWT bearer)
      ▼
  Caddy :443  ──reverse_proxy──▶  node dist/index.js  @ 127.0.0.1:3000
  (Let's Encrypt cert)                     │
                                           ▼
                                   api.prod.whoop.com  (your WHOOP account)
```

**Why this shape is safe:** the Node server binds **loopback only**
(`MCP_HOST=127.0.0.1`, the default). Nothing but Caddy can reach it, and only
port 443 is ever exposed. Your `MCP_AUTH_TOKEN` and `MCP_CONNECTOR_PASSWORD`
are the gate — anyone holding either can read all your WHOOP data, so treat
them as high-value secrets.

---

## Prerequisites

- The [`gcloud` CLI](https://cloud.google.com/sdk/docs/install) installed and
  authenticated (`gcloud auth login`), with a project + **billing account**
  attached (required even for Always Free; overages bill — set a budget alert).
- A free [DuckDNS](https://www.duckdns.org) account: create a subdomain (e.g.
  `whoop-jannik`) and copy your **token**.
- Your WHOOP developer app (developer.whoop.com) with redirect URI
  `http://localhost:3000/callback` (used only for the one-time local token
  seed in step 1).
- This fork: `https://github.com/codeOfJannik/whoop-mcp`.

Pick a free-tier region for every command below: `us-west1`, `us-central1`,
or `us-east1`. This guide uses `us-central1` / zone `us-central1-a`.

---

## Step 1 — Seed the WHOOP token locally (one time)

The WHOOP OAuth grant needs a browser, which a headless VM doesn't have. Do it
once on your laptop; the resulting refresh token is portable to the VM.

```bash
git clone https://github.com/codeOfJannik/whoop-mcp.git
cd whoop-mcp && npm ci && npm run build

WHOOP_CLIENT_ID=your_id \
WHOOP_CLIENT_SECRET=your_secret \
node dist/index.js
# → a browser opens; authorize WHOOP.
# → wait for "Authentication successful." then Ctrl-C.
```

This writes `~/.whoop-mcp/tokens.json`. Keep it handy for step 4.

> The server refreshes this token automatically (no browser needed) as long as
> **only one instance** uses it. Don't run the server locally again once the VM
> is live, or refresh-token rotation will invalidate the VM's copy.

---

## Step 2 — Create the VM + firewall

```bash
# Always-Free e2-micro, 30 GB standard disk, Debian 12
gcloud compute instances create whoop-mcp \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --tags=whoop-mcp

# Allow HTTP (ACME challenge) + HTTPS from anywhere
gcloud compute firewall-rules create whoop-mcp-web \
  --network=default --direction=INGRESS --action=ALLOW \
  --rules=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags=whoop-mcp
```

Note the VM's external IP:

```bash
gcloud compute instances describe whoop-mcp --zone=us-central1-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
```

Point your DuckDNS subdomain at that IP once now (the cron in step 5 keeps it
current): visit `https://www.duckdns.org/update?domains=YOURSUB&token=YOURTOKEN&ip=THAT_IP`.

---

## Step 3 — Bootstrap the VM (Node + Caddy + build)

SSH in and run the bootstrap script (installs Node 22 + Caddy, creates the
`whoop` user, clones + builds the repo):

```bash
gcloud compute ssh whoop-mcp --zone=us-central1-a

# on the VM:
curl -fsSL https://raw.githubusercontent.com/codeOfJannik/whoop-mcp/main/docs/deploy/bootstrap-vm.sh | sudo bash
```

---

## Step 4 — Install the token, env file, and systemd unit

Copy the token you seeded in step 1 up to the VM (from your laptop):

```bash
gcloud compute scp ~/.whoop-mcp/tokens.json whoop-mcp:/tmp/tokens.json --zone=us-central1-a
```

Back on the VM:

```bash
sudo install -m 600 -o whoop -g whoop /tmp/tokens.json /home/whoop/.whoop-mcp/tokens.json && rm /tmp/tokens.json

# Env file — copy the template and fill in your secrets
sudo cp /opt/whoop-mcp/docs/deploy/whoop-mcp.env.example /etc/whoop-mcp/whoop-mcp.env
sudo chmod 600 /etc/whoop-mcp/whoop-mcp.env
sudo nano /etc/whoop-mcp/whoop-mcp.env      # set WHOOP creds, PUBLIC_URL, and:
#   MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
#   MCP_CONNECTOR_PASSWORD="$(openssl rand -base64 24)"
#   PUBLIC_URL=https://YOURSUB.duckdns.org

# systemd service
sudo cp /opt/whoop-mcp/docs/deploy/whoop-mcp.service /etc/systemd/system/whoop-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable --now whoop-mcp
sudo systemctl status whoop-mcp --no-pager     # should be active (running)
journalctl -u whoop-mcp -n 30 --no-pager       # look for "http transport listening"
```

---

## Step 5 — Caddy (TLS) + DuckDNS updater

```bash
# Caddy: set your hostname and reload
sudo cp /opt/whoop-mcp/docs/deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile                 # replace YOURSUB.duckdns.org with your real hostname
sudo systemctl restart caddy
journalctl -u caddy -n 30 --no-pager           # look for "certificate obtained successfully"

# DuckDNS auto-updater (keeps the hostname pointed at this VM)
sudo cp /opt/whoop-mcp/docs/deploy/duckdns-update.sh /opt/whoop-mcp/duckdns-update.sh
sudo nano /opt/whoop-mcp/duckdns-update.sh      # set DUCKDNS_SUB + DUCKDNS_TOKEN
sudo chmod 700 /opt/whoop-mcp/duckdns-update.sh && sudo chown whoop:whoop /opt/whoop-mcp/duckdns-update.sh
( sudo crontab -u whoop -l 2>/dev/null; echo "*/5 * * * * /opt/whoop-mcp/duckdns-update.sh >/dev/null 2>&1" ) | sudo crontab -u whoop -
sudo -u whoop /opt/whoop-mcp/duckdns-update.sh  # run once now; should print "OK"
```

---

## Step 6 — Verify

```bash
# From anywhere:
curl https://YOURSUB.duckdns.org/health
# → {"status":"ok"}

# OAuth metadata is published (proves the connector is mounted):
curl https://YOURSUB.duckdns.org/.well-known/oauth-authorization-server
# → JSON with "issuer":"https://YOURSUB.duckdns.org"
```

---

## Step 7 — Connect claude.ai

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. URL: `https://YOURSUB.duckdns.org/mcp`.
3. When prompted, enter your **`MCP_CONNECTOR_PASSWORD`**.
4. Approve. Claude (web + mobile) now queries your WHOOP data.

---

## Operations & cost notes

- **Cost:** e2-micro + 30 GB pd-standard + Caddy + DuckDNS all sit inside the
  Always Free limits (1 GB/month egress is plenty for personal use). Set a GCP
  **budget alert at $1** so any accidental overage is visible.
- **Logs:** `journalctl -u whoop-mcp -f` (server) and `journalctl -u caddy -f`
  (TLS). Secrets are redacted from server logs.
- **Update the server:** run the deploy script — it pulls, rebuilds `dist/`,
  restarts the service, and health-checks the WHOOP upstream in one step:
  `curl -fsSL https://raw.githubusercontent.com/codeOfJannik/whoop-mcp/main/docs/deploy/update.sh | sudo bash`
  (or `sudo bash /opt/whoop-mcp/docs/deploy/update.sh`). A bare `git pull` does
  **not** deploy: the service runs the compiled `dist/`, so without a rebuild +
  restart the old code keeps running.
- **Token expiry:** if WHOOP ever fully revokes the refresh token, the service
  will fail to start (it can't run a headless browser flow). Re-seed with
  step 1 locally and re-copy `tokens.json` (step 4).
- **Rotating secrets:** change `MCP_AUTH_TOKEN` / `MCP_CONNECTOR_PASSWORD` in
  the env file and `sudo systemctl restart whoop-mcp`; then reconnect in
  claude.ai. Rotating `MCP_AUTH_TOKEN` also rotates the connector's JWT signing
  key, so existing claude.ai sessions must re-authorize.
