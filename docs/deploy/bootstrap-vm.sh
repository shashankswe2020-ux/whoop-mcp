#!/usr/bin/env bash
#
# One-time VM bootstrap for the WHOOP MCP server on Debian 12 (GCP e2-micro).
# Installs Node.js 22 + Caddy, creates the `whoop` service user, clones and
# builds the server. Idempotent — safe to re-run. Contains NO secrets.
#
# Run on the VM as a sudo user:
#   curl -fsSL https://raw.githubusercontent.com/codeOfJannik/whoop-mcp/main/docs/deploy/bootstrap-vm.sh | sudo bash
# or copy it over and:  sudo bash bootstrap-vm.sh
#
# After it finishes, follow docs/deploy/gcp-e2-micro-duckdns.md from step 4
# (drop in the env file, token, Caddyfile, and start the services).

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/codeOfJannik/whoop-mcp.git}"
APP_DIR="/opt/whoop-mcp"
SVC_USER="whoop"

echo "==> Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

echo "==> Installing Node.js 22 (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
	curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
	apt-get install -y nodejs
fi
node -v

echo "==> Installing Caddy (official apt repo)"
if ! command -v caddy >/dev/null 2>&1; then
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
		| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
		| tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
	apt-get update -y
	apt-get install -y caddy
fi

echo "==> Creating service user '${SVC_USER}'"
if ! id "${SVC_USER}" >/dev/null 2>&1; then
	useradd --system --create-home --home-dir "/home/${SVC_USER}" --shell /usr/sbin/nologin "${SVC_USER}"
fi
install -d -m 700 -o "${SVC_USER}" -g "${SVC_USER}" "/home/${SVC_USER}/.whoop-mcp"

echo "==> Cloning / updating ${REPO_URL} into ${APP_DIR}"
if [ -d "${APP_DIR}/.git" ]; then
	git -C "${APP_DIR}" pull --ff-only
else
	git clone --depth 1 "${REPO_URL}" "${APP_DIR}"
fi

echo "==> Building"
cd "${APP_DIR}"
npm ci
npm run build
npm prune --omit=dev
chown -R "${SVC_USER}:${SVC_USER}" "${APP_DIR}"

echo "==> Creating /etc/whoop-mcp"
install -d -m 750 -o root -g "${SVC_USER}" /etc/whoop-mcp

cat <<'DONE'

==> Base install complete.

Next (see docs/deploy/gcp-e2-micro-duckdns.md, from step 4):
  1. Copy your seeded WHOOP token to /home/whoop/.whoop-mcp/tokens.json
       sudo install -m 600 -o whoop -g whoop tokens.json /home/whoop/.whoop-mcp/tokens.json
  2. Create /etc/whoop-mcp/whoop-mcp.env from docs/deploy/whoop-mcp.env.example (chmod 600)
  3. Install docs/deploy/whoop-mcp.service to /etc/systemd/system/ and enable it
  4. Install docs/deploy/Caddyfile.example to /etc/caddy/Caddyfile (set your hostname), restart caddy
  5. Set up the DuckDNS updater cron (docs/deploy/duckdns-update.sh)
DONE
