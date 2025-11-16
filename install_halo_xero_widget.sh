
#!/usr/bin/env bash
set -e

APP_DIR="/opt/halo-xero-widget"
APP_NAME="halo-xero"

echo "== Halo ⇄ Xero Widget installer =="

if [[ "$EUID" -ne 0 ]]; then
  echo "Please run as root: sudo $0"
  exit 1
fi

mkdir -p "$APP_DIR"
cd "$APP_DIR"

echo "-> Installing OS dependencies (Node, pm2, puppeteer libs)..."
apt-get update -y
apt-get install -y nodejs npm \
  libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
  libxkbcommon0 libxdamage1 libxfixes3 libxcomposite1 libxrandr2 \
  libgbm1 libglib2.0-0t64 libgtk-3-0t64 libasound2t64

echo "-> Installing pm2..."
npm install -g pm2

echo "-> Installing Node dependencies..."
npm install

if [[ ! -f ".env" ]]; then
  echo "-> Creating .env from .env.example (edit this with real values)..."
  cp .env.example .env || true
fi

echo "-> Starting app with pm2..."
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start server.js --name "$APP_NAME"

echo "-> Saving pm2 startup..."
pm2 save
pm2 startup systemd -u "$(logname)" --hp "/home/$(logname)" || true

echo "Done. Check with: pm2 status"
