#!/usr/bin/env bash
#
# Update an already-bootstrapped WHOOP MCP VM to the latest committed code.
# Pulls, reinstalls deps, rebuilds dist/, restarts the service, and verifies
# the upstream WHOOP API is reachable. Idempotent — safe to re-run. No secrets.
#
# Why this exists: `git pull` alone does NOT deploy. The service runs the
# COMPILED dist/ under a long-lived process, so a pull without `npm run build`
# + `systemctl restart` leaves the old code running indefinitely. This script
# does all three (plus a health check) so an update can't half-land.
#
# Run on the VM as a sudo user:
#   curl -fsSL https://raw.githubusercontent.com/codeOfJannik/whoop-mcp/main/docs/deploy/update.sh | sudo bash
# or copy it over and:  sudo bash update.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/whoop-mcp}"
SVC_USER="${SVC_USER:-whoop}"
SERVICE="${SERVICE:-whoop-mcp}"
ENV_FILE="${ENV_FILE:-/etc/whoop-mcp/whoop-mcp.env}"

if [ "$(id -u)" -ne 0 ]; then
	echo "ERROR: run as root (sudo bash update.sh)." >&2
	exit 1
fi

if [ ! -d "${APP_DIR}/.git" ]; then
	echo "ERROR: ${APP_DIR} is not a git checkout. Run bootstrap-vm.sh first." >&2
	exit 1
fi

echo "==> Fetching latest code in ${APP_DIR}"
cd "${APP_DIR}"
BEFORE="$(git rev-parse --short HEAD)"
git pull --ff-only
AFTER="$(git rev-parse --short HEAD)"
echo "    ${BEFORE} -> ${AFTER}"

echo "==> Installing deps + building (dev deps needed for tsc)"
npm ci
npm run build
# Trim back to runtime-only deps so the service stays lean, matching bootstrap.
npm prune --omit=dev
chown -R "${SVC_USER}:${SVC_USER}" "${APP_DIR}"

echo "==> Restarting ${SERVICE}"
systemctl restart "${SERVICE}"

# Give the process a moment to authenticate + bind before probing.
sleep 4

echo "==> Service state"
if ! systemctl is-active --quiet "${SERVICE}"; then
	echo "ERROR: ${SERVICE} is not active after restart. Recent logs:" >&2
	journalctl -u "${SERVICE}" -n 30 --no-pager >&2
	exit 1
fi
systemctl is-active "${SERVICE}"

# Health check: hit the authed /health endpoint, which makes a real WHOOP API
# call and reports upstream reachability as whoopApi: "ok" | "error".
echo "==> Verifying WHOOP upstream via /health"
if [ -r "${ENV_FILE}" ]; then
	# shellcheck disable=SC1090
	set -a
	. "${ENV_FILE}"
	set +a
	PORT="${MCP_PORT:-3000}"
	HEALTH="$(curl -fsS -H "Authorization: Bearer ${MCP_AUTH_TOKEN:-}" \
		"http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
	echo "    ${HEALTH:-<no response>}"
	case "${HEALTH}" in
		*'"whoopApi":"ok"'*)
			echo "==> Update complete — WHOOP API reachable."
			;;
		*)
			echo "WARNING: server is up but WHOOP API is not confirmed reachable." >&2
			echo "  If startup logged 'interactive OAuth is disabled', the stored" >&2
			echo "  refresh token is dead — re-seed /home/${SVC_USER}/.whoop-mcp/tokens.json" >&2
			echo "  (see docs/deploy/gcp-e2-micro-duckdns.md) and restart." >&2
			journalctl -u "${SERVICE}" -n 15 --no-pager >&2
			exit 1
			;;
	esac
else
	echo "    ${ENV_FILE} not readable — skipping health check."
	echo "==> Update complete (service restarted; health not verified)."
fi
