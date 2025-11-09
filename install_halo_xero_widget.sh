#!/bin/bash
# Halo Xero Widget installer - Engage Tech
# Tested on Ubuntu 22.04 / 24.04
# by Tui 🪶

set -e

APP_DIR="/opt/halo-xero-widget"
DOMAIN="halo-widget.engagetech.nz"
NODE_PORT=3000
ZIP_URL="https://github.com/smegoff/halo-xero-widget/raw/main/halo-xero-widget.zip"
HALO_JWT_SECRET=$(openssl rand -hex 32)
HALO_WIDGET_SECRET=$(openssl rand -hex 32)

echo "==== Halo Xero Widget installer ===="
echo "Domain: $DOMAIN"
echo "Node app dir: $APP_DIR"
echo "------------------------------------"
sleep 2

# --- System prep ---
echo "[1/9] Updating system..."
apt update && apt upgrade -y

echo "[2/9] Installing required packages..."
apt install -y curl nginx ufw git unzip certbot python3-certbot-nginx

# --- Node.js & PM2 ---
echo "[3/9] Installing Node.js LTS & PM2..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pm2

# --- App setup ---
echo "[4/9] Creating app directory and downloading code..."
rm -rf $APP_DIR
mkdir -p $APP_DIR
cd $APP_DIR

echo "Downloading ZIP from GitHub..."
curl -L -o halo-xero-widget.zip "$ZIP_URL"
unzip halo-xero-widget.zip
rm halo-xero-widget.zip

# Optional: handle nested folder issue if ZIP extracts into its own folder
if [ -d "$APP_DIR/halo-xero-widget" ]; then
    mv $APP_DIR/halo-xero-widget/* $APP_DIR/
    rm -rf $APP_DIR/halo-xero-widget
fi

# --- Env config ---
echo "[5/9] Creating .env configuration..."
cat <<EOF > $APP_DIR/.env
PORT=$NODE_PORT
HALO_JWT_SECRET=$HALO_JWT_SECRET
HALO_WIDGET_SECRET=$HALO_WIDGET_SECRET
NODE_ENV=production
EOF

# --- Install dependencies ---
echo "[6/9] Installing Node dependencies..."
npm install --omit=dev || npm install

# --- PM2 service ---
echo "[7/9] Starting app with PM2..."
pm2 start app.js --name halo-xero
pm2 save
pm2 startup systemd -u $(whoami) --hp $(eval echo ~$USER)

# --- Nginx config ---
echo "[8/9] Configuring Nginx reverse proxy..."
cat <<EOF > /etc/nginx/sites-available/halo-xero.conf
server {
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$NODE_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }

    listen 80;
    listen [::]:80;
}
EOF

ln -sf /etc/nginx/sites-available/halo-xero.conf /etc/nginx/sites-enabled/
nginx -t && systemctl restart nginx

# --- SSL setup ---
echo "Requesting Let's Encrypt certificate..."
certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m admin@$DOMAIN || true

# --- UFW firewall ---
echo "Configuring UFW firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "------------------------------------"
echo "✅ Install complete!"
echo "Site should be live at: https://$DOMAIN"
echo
echo "Halo JWT Secret: $HALO_JWT_SECRET"
echo "Halo Widget Secret: $HALO_WIDGET_SECRET"
echo
echo "Remember to:"
echo " - Add these secrets to Halo integration settings"
echo " - Reboot or 'pm2 restart halo-xero' to apply"
echo "------------------------------------"
