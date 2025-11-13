#!/usr/bin/env bash
set -euo pipefail

VERSION="v6.0-hmac-only"
APP_DIR="/opt/halo-xero-widget"
REPO_ZIP_URL="https://raw.githubusercontent.com/smegoff/halo-xero-widget/main/halo-xero-widget.zip"
SERVER_JS_URL="https://raw.githubusercontent.com/smegoff/halo-xero-widget/main/server.js"
FINANCE_EJS_URL="https://raw.githubusercontent.com/smegoff/halo-xero-widget/main/views/finance.ejs"

echo "====================================="
echo " Halo <> Xero Widget Installer"
echo " Version: ${VERSION}"
echo "====================================="

if [[ $EUID -ne 0 ]]; then
  echo "⚠️  Please run as root (sudo)."
  exit 1
fi

read -rp "Domain for widget (default: widget.engagetech.nz): " DOMAIN
DOMAIN=${DOMAIN:-widget.engagetech.nz}

read -rp "App port (default: 3000): " PORT
PORT=${PORT:-3000}

echo "You MUST paste the same secret you use for Halo's Iframe secret (HMAC)."
read -rp "HMAC secret (used for $HMAC validation): " HMAC_SECRET

read -rp "Xero Client ID: " XERO_CLIENT_ID
read -rp "Xero Client Secret: " XERO_CLIENT_SECRET

XERO_REDIRECT_URI="https://${DOMAIN}/auth/callback"

echo "-------------------------------------"
echo "Installing dependencies..."
echo "-------------------------------------"

apt-get update -y
apt-get install -y nginx unzip curl coreutils ca-certificates

# Node.js (20.x)
if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# PM2
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

echo "-------------------------------------"
echo "Fetching widget code..."
echo "-------------------------------------"

rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}"
cd "${APP_DIR}"

curl -fsSL "${REPO_ZIP_URL}" -o widget.zip
unzip -o widget.zip
rm widget.zip

# Overwrite server.js and finance.ejs with latest from repo
echo "Updating server.js and finance.ejs from GitHub..."
curl -fsSL "${SERVER_JS_URL}" -o server.js
mkdir -p views
curl -fsSL "${FINANCE_EJS_URL}" -o views/finance.ejs

# Ensure Node deps
echo "Installing Node dependencies..."
npm install --omit=dev

# .env
ENV_FILE="${APP_DIR}/.env"
if [[ -f "${ENV_FILE}" ]]; then
  echo "⚠️  .env already exists, leaving as-is."
else
  echo "Creating .env..."
  cat > "${ENV_FILE}" <<EOF
PORT=${PORT}
HMAC_SECRET=${HMAC_SECRET}

XERO_CLIENT_ID=${XERO_CLIENT_ID}
XERO_CLIENT_SECRET=${XERO_CLIENT_SECRET}
XERO_REDIRECT_URI=${XERO_REDIRECT_URI}

TENANT_ID=
EOF
fi

chown -R root:root "${APP_DIR}"

echo "-------------------------------------"
echo "Configuring Nginx for ${DOMAIN}..."
echo "-------------------------------------"

NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}"

cat > "${NGINX_CONF}" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass         http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sf "${NGINX_CONF}" /etc/nginx/sites-enabled/${DOMAIN}
nginx -t
systemctl reload nginx

echo "-------------------------------------"
echo "Obtaining Let's Encrypt certificate..."
echo "-------------------------------------"

if ! command -v certbot >/dev/null 2>&1; then
  apt-get install -y certbot python3-certbot-nginx
fi

certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "hostmaster@${DOMAIN#*.}" || true

echo "-------------------------------------"
echo "Setting up PM2 process..."
echo "-------------------------------------"

cd "${APP_DIR}"
pm2 delete halo-xero >/dev/null 2>&1 || true
pm2 start server.js --name halo-xero
pm2 save

# Enable PM2 startup at boot
pm2 startup systemd -u root --hp /root >/tmp/pm2_startup.txt || true
bash /tmp/pm2_startup.txt || true

echo "-------------------------------------"
echo "Running validation checks..."
echo "-------------------------------------"

curl -I "https://${DOMAIN}" || true
pm2 status
ss -tulpn | grep -E ":80|:443" || true

echo "-------------------------------------"
echo "✅ Install complete!"
echo "Accessible at: https://${DOMAIN}"
echo
echo "HMAC secret (must match Halo Iframe secret):"
echo "  ${HMAC_SECRET}"
echo
echo ".env stored at: ${ENV_FILE}"
echo "App directory:   ${APP_DIR}"
echo
echo "Next steps:"
echo " - In Halo, create a custom tab with iframe URL:"
echo "     https://${DOMAIN}/finance?area=\$area&agentId=\$loggedinagentid&hmac=\$HMAC"
echo " - Authorise Xero via:"
echo "     https://${DOMAIN}/auth/connect"
echo " - Debug HMAC via:"
echo "     https://${DOMAIN}/debug-hmac?area=\$area&agentId=\$loggedinagentid&hmac=\$HMAC"
echo "-------------------------------------"
echo "Installer version: ${VERSION}"
