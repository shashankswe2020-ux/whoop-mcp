#!/usr/bin/env bash
# Point your DuckDNS subdomain at this VM's current public IP.
#
# Install to: /opt/whoop-mcp/duckdns-update.sh  (chmod 700, owned by whoop)
# Fill in DUCKDNS_SUB and DUCKDNS_TOKEN below, then add a cron entry:
#   */5 * * * * /opt/whoop-mcp/duckdns-update.sh >/dev/null 2>&1
#
# Leaving ip= empty tells DuckDNS to use the request's source IP (this VM's
# public IP as seen through GCP's NAT), so it auto-tracks IP changes.

set -euo pipefail

DUCKDNS_SUB="YOURSUB"          # just the subdomain label, e.g. "whoop-jannik"
DUCKDNS_TOKEN="your_duckdns_token"

curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_SUB}&token=${DUCKDNS_TOKEN}&ip=" \
	-o /tmp/duckdns.log
