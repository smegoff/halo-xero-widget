#!/usr/bin/env bash
set -euo pipefail

cd /opt/halo-xero-widget

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

exec /usr/bin/node /opt/halo-xero-widget/scripts/check-service-health.js
