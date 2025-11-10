#!/bin/bash
# Halo Xero Widget Installer - Engage Technology (v4)
# by Sean Glasspool
# Tested on Ubuntu 24.04 / 25.04

set -e

APP_DIR="/opt/halo-xero-widget"
DOMAIN="widget.engagetech.nz"
NODE_PORT=3000
ZIP_URL="https://github.com/smegoff/halo-xero-widget/raw/main/halo-xero-widget.zip"
HALO_JWT_SECRET=$(openssl rand -hex 32)
HALO_WIDGET_SECRET=$(openssl rand -hex 32)

echo "==== Halo Xero Widget Installer (v4) ===="
echo "Domain: $DOMAIN"
echo "App Directory: $APP_DIR"
echo "-----------------------------------------"
sleep 2

# --- 1. System prep ---
echo "[1/10] Updating system..."
apt update && apt upgrade -y

echo "[2/10] Installing required packages..."
apt install -y curl nginx ufw git unzip certbot python3-certbot-nginx

# --- 2. Node.js + PM2 ---
echo "[3/10] Installing Node.js LTS & PM2..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pm2

# --- 3. App setup ---
echo "[4/10] Creating app directory and downloading code..."
rm -rf $APP_DIR
mkdir -p $APP_DIR
cd $APP_DIR

echo "Downloading ZIP from GitHub..."
curl -L -o halo-xero-widget.zip "$ZIP_URL"
unzip halo-xero-widget.zip
rm halo-xero-widget.zip

# Handle nested folder structure
if [ -d "$APP_DIR/halo-xero-widget" ]; then
    mv $APP_DIR/halo-xero-widget/* $APP_DIR/
    rm -rf $APP_DIR/halo-xero-widget
fi

# --- 4. Environment configuration ---
echo "[5/10] Creating .env configuration..."
cat <<EOF > $APP_DIR/.env
PORT=$NODE_PORT
HALO_JWT_SECRET=$HALO_JWT_SECRET
HALO_WIDGET_SECRET=$HALO_WIDGET_SECRET
NODE_ENV=production
EOF

# --- 5. Dependencies ---
echo "[6/10] Installing Node dependencies..."
npm install --omit=dev || npm install

# --- 6. PM2 setup ---
echo "[7/10] Starting Node app with PM2..."
pm2 start app.js --name halo-xero
pm2 save
pm2 startup systemd -u $(whoami) --hp $(eval echo ~$USER)

# --- 7. Nginx reverse proxy ---
echo "[8/10] Configuring Nginx reverse proxy..."
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

# --- 8. SSL setup ---
echo "[9/10] Requesting Let's Encrypt certificate for $DOMAIN..."
certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m admin@$DOMAIN || true

# --- 9. Optional Fail2Ban + SSH restrictions ---
read -p "Would you like to install Fail2Ban and restrict SSH access to specific IPs? (y/n): " install_security

if [[ "$install_security" =~ ^[Yy]$ ]]; then
    echo "[10/10] Installing and configuring Fail2Ban + SSH IP whitelist..."
    apt install -y fail2ban ufw

    read -p "Enter comma-separated list of IPs to allow SSH from (e.g. 202.74.208.244,203.97.32.5): " ALLOWED_IPS

    # Fail2Ban config
    cat <<EOF >/etc/fail2ban/jail.local
[DEFAULT]
ignoreip = 127.0.0.1/8 ${ALLOWED_IPS//,/ }
bantime = 1h
findtime = 10m
maxretry = 5
backend = systemd
banaction = ufw

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 5
EOF

    systemctl enable fail2ban
    systemctl restart fail2ban

    # Reset and configure UFW
    echo "Resetting UFW rules..."
    ufw --force reset
    ufw default deny incoming
    ufw default allow outgoing

    # Allow web traffic
    ufw allow 'Nginx Full'

    # Allow SSH only from provided IPs
    IFS=',' read -ra ADDR <<< "$ALLOWED_IPS"
    for ip in "${ADDR[@]}"; do
        echo "Allowing SSH from $ip"
        ufw allow proto tcp from $ip to any port 22
    done

    ufw --force enable
    ufw reload

    echo "Fail2Ban + SSH whitelist configured."
    fail2ban-client status sshd
else
    echo "Skipping Fail2Ban + SSH restriction setup."
    # Ensure at least web access if UFW off
    ufw allow 'Nginx Full'
    ufw allow OpenSSH
    ufw --force enable
fi

echo "------------------------------------"
echo "✅ Install complete!"
echo "Accessible at: https://$DOMAIN"
echo
echo "Halo JWT Secret: $HALO_JWT_SECRET"
echo "Halo Widget Secret: $HALO_WIDGET_SECRET"
echo
echo "Next steps:"
echo " - Add these secrets to Halo integration settings"
echo " - Test via: https://$DOMAIN/?clientId={ClientId}&token={Token}"
echo " - Restart with: pm2 restart halo-xero"
echo "------------------------------------"
