#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/halo-xero-widget}"
APP_USER="${APP_USER:-engageadmin}"
REPO_URL="${REPO_URL:-https://github.com/smegoff/halo-xero-widget.git}"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-widget.example.com}"
NODE_MAJOR="${NODE_MAJOR:-20}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/halo-xero-widget-backups}"
ENV_FILE="${ENV_FILE:-}"
CONFIGURE_NGINX="${CONFIGURE_NGINX:-0}"
ENABLE_CERTBOT="${ENABLE_CERTBOT:-0}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
RUN_SYNC="${RUN_SYNC:-0}"

log() {
  printf "\n== %s ==\n" "$*"
}

die() {
  printf "ERROR: %s\n" "$*" >&2
  exit 1
}

usage() {
  cat <<USAGE
Halo Xero Widget one-shot install / recovery script

Run as root on Ubuntu:
  sudo bash install_halo_xero_widget.sh

Common overrides:
  APP_DIR=/opt/halo-xero-widget
  APP_USER=engageadmin
  REPO_URL=https://github.com/smegoff/halo-xero-widget.git
  BRANCH=main
  DOMAIN=widget.example.com
  ENV_FILE=/root/halo-xero.env
  CONFIGURE_NGINX=1
  ENABLE_CERTBOT=1 CERTBOT_EMAIL=admin@example.com
  RUN_SYNC=1

The script preserves existing .env and data/ before replacing code.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${EUID}" -ne 0 ]]; then
  die "Run as root: sudo bash install_halo_xero_widget.sh"
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="${BACKUP_ROOT}/${timestamp}"

log "Installing OS dependencies"
apt-get update -y
apt-get install -y \
  ca-certificates curl git gnupg nginx postgresql-client \
  libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
  libxkbcommon0 libxdamage1 libxfixes3 libxcomposite1 libxrandr2 \
  libgbm1 libglib2.0-0t64 libgtk-3-0t64 libasound2t64

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(`.`)[0]' 2>/dev/null || echo 0)" -lt "${NODE_MAJOR}" ]]; then
  log "Installing Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

log "Ensuring application user"
if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${APP_USER}"
fi

log "Backing up existing install if present"
mkdir -p "${BACKUP_ROOT}"
if [[ -d "${APP_DIR}" ]]; then
  mkdir -p "${backup_dir}"
  tar --exclude="${APP_DIR}/node_modules" -czf "${backup_dir}/halo-xero-widget.tar.gz" -C "$(dirname "${APP_DIR}")" "$(basename "${APP_DIR}")"
  printf "Backup written: %s\n" "${backup_dir}/halo-xero-widget.tar.gz"
fi

log "Fetching application code"
if [[ ! -d "${APP_DIR}/.git" ]]; then
  if [[ -d "${APP_DIR}" && -n "$(find "${APP_DIR}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    mv "${APP_DIR}" "${APP_DIR}.pre-git-${timestamp}"
  fi
  git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
else
  git -C "${APP_DIR}" fetch origin "${BRANCH}"
  git -C "${APP_DIR}" checkout "${BRANCH}"
  git -C "${APP_DIR}" reset --hard "origin/${BRANCH}"
fi

log "Restoring preserved runtime files"
mkdir -p "${APP_DIR}/data"
if [[ -n "${ENV_FILE}" ]]; then
  install -m 600 "${ENV_FILE}" "${APP_DIR}/.env"
elif [[ -f "${backup_dir}/halo-xero-widget.tar.gz" ]]; then
  tmp_restore="$(mktemp -d)"
  tar -xzf "${backup_dir}/halo-xero-widget.tar.gz" -C "${tmp_restore}"
  if [[ -f "${tmp_restore}/$(basename "${APP_DIR}")/.env" ]]; then
    install -m 600 "${tmp_restore}/$(basename "${APP_DIR}")/.env" "${APP_DIR}/.env"
  fi
  if [[ -d "${tmp_restore}/$(basename "${APP_DIR}")/data" ]]; then
    cp -a "${tmp_restore}/$(basename "${APP_DIR}")/data/." "${APP_DIR}/data/"
  fi
  rm -rf "${tmp_restore}"
fi

if [[ ! -f "${APP_DIR}/.env" ]]; then
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  chmod 600 "${APP_DIR}/.env"
  printf "Created %s/.env from .env.example. Edit it before exposing the service.\n" "${APP_DIR}"
fi

chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

log "Installing Node dependencies"
sudo -u "${APP_USER}" bash -lc "cd '${APP_DIR}' && npm ci --omit=dev"

log "Installing PM2"
npm install -g pm2

log "Running application syntax checks"
sudo -u "${APP_USER}" bash -lc "cd '${APP_DIR}' && npm run check"

if [[ "${CONFIGURE_NGINX}" == "1" ]]; then
  log "Configuring nginx for ${DOMAIN}"
  cat > /etc/nginx/sites-available/halo-xero-widget <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /admin {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
  ln -sfn /etc/nginx/sites-available/halo-xero-widget /etc/nginx/sites-enabled/halo-xero-widget
  nginx -t
  systemctl reload nginx

  if [[ "${ENABLE_CERTBOT}" == "1" ]]; then
    [[ -n "${CERTBOT_EMAIL}" ]] || die "CERTBOT_EMAIL is required when ENABLE_CERTBOT=1"
    apt-get install -y certbot python3-certbot-nginx
    certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${CERTBOT_EMAIL}" --redirect
  fi
fi

log "Starting PM2 services"
sudo -u "${APP_USER}" bash -lc "cd '${APP_DIR}' && pm2 delete halo-xero halo-xero-admin >/dev/null 2>&1 || true && pm2 start ecosystem.config.cjs && pm2 save"
pm2 startup systemd -u "${APP_USER}" --hp "/home/${APP_USER}" >/dev/null || true

if [[ "${RUN_SYNC}" == "1" ]]; then
  log "Running initial Xero contact sync"
  sudo -u "${APP_USER}" bash -lc "cd '${APP_DIR}' && node scripts/sync-xero-contacts.js"
fi

log "Recovery check"
sudo -u "${APP_USER}" bash -lc "pm2 status"
printf "\nDone. Review %s/.env, PM2 status, nginx, and https://%s/admin.\n" "${APP_DIR}" "${DOMAIN}"
