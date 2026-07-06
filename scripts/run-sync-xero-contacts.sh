#!/usr/bin/env bash
set -euo pipefail

cd /opt/halo-xero-widget

# Load .env if present
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

exec /usr/bin/node /opt/halo-xero-widget/scripts/sync-xero-contacts.js
