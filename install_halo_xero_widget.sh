#!/bin/bash
set -e
echo "🚀 Halo ↔ Xero Widget Installer v6.2"

# === CONFIG ===
APP_DIR="/opt/halo-xero-widget"
DOMAIN="widget.engagetech.nz"
NODE_VERSION="20"

# === REQUIREMENTS ===
echo "📦 Updating packages..."
apt update -y
apt install -y curl unzip nginx python3-certbot-nginx ufw fail2ban nodejs npm jq

# === SETUP NODEJS ===
if ! command -v node &>/dev/null; then
  echo "📦 Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_$NODE_VERSION.x | bash -
  apt install -y nodejs
fi

# === CREATE APP DIR ===
mkdir -p $APP_DIR
cd $APP_DIR

# === DOWNLOAD REPO ZIP ===
echo "📥 Downloading latest halo-xero-widget.zip..."
curl -fsSL -o halo-xero-widget.zip https://github.com/smegoff/halo-xero-widget/raw/main/halo-xero-widget.zip

echo "📦 Extracting files..."
unzip -o halo-xero-widget.zip -d $APP_DIR

# === FETCH LATEST CORE FILES ===
echo "📥 Fetching latest server.js and finance.ejs..."
curl -fsSL https://raw.githubusercontent.com/smegoff/halo-xero-widget/main/server.js -o $APP_DIR/server.js
mkdir -p $APP_DIR/views
curl -fsSL https://raw.githubusercontent.com/smegoff/halo-xero-widget/main/views/finance.ejs -o $APP_DIR/views/finance.ejs
echo "✅ Synced latest code from GitHub."

# === INSTALL DEPENDENCIES ===
echo "📦 Installing dependencies..."
npm install --omit=dev

# === ENV FILE ===
echo "🔧 Creating .env file..."
JWT_SECRET=$(openssl rand -hex 32)
WIDGET_SECRET=$(openssl rand -hex 32)
cat <<EOF > $APP_DIR/.env
PORT=3000
HALO_JWT_SECRET=$JWT_SECRET
HALO_WIDGET_SECRET=$WIDGET_SECRET
TENANT_ID=
XERO_CLIENT_ID=
XERO_CLIENT_SECRET=
XERO_REDIRECT_URI=https://$DOMAIN/auth/callback
EOF
echo "✅ .env file created."

# === PERMISSIONS ===
chown -R root:root $APP_DIR
chmod -R 755 $APP_DIR

# === PM2 SETUP ===
echo "⚙️  Setting up PM2..."
npm install -g pm2
pm2 start $APP_DIR/server.js --name halo-xero
pm2 save
pm2 startup systemd -u root --hp /root

# === NGINX CONFIG ===
echo "🧩 Configuring Nginx reverse proxy..."
cat <<NGINX >/etc/nginx/sites-available/halo-xero-widget
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/halo-xero-widget /etc/nginx/sites-enabled/halo-xero-widget
nginx -t && systemctl restart nginx

# === SSL CERT ===
echo "🔐 Requesting SSL certificate..."
certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m admin@$DOMAIN || echo "⚠️ Certbot failed. Try manually later."

# === FIREWALL ===
echo "🧱 Configuring UFW..."
ufw allow 'OpenSSH'
ufw allow 'Nginx Full'
read -p "Enter comma-separated IPs to whitelist for SSH (or leave blank): " WHITELIST
if [ -n "$WHITELIST" ]; then
  IFS=',' read -ra IPS <<< "$WHITELIST"
  for ip in "${IPS[@]}"; do
    ufw allow from $(echo $ip | xargs)/32 to any port 22
  done
fi
ufw --force enable

# === FAIL2BAN ===
echo "🛡️  Enabling Fail2Ban..."
systemctl enable fail2ban
systemctl start fail2ban

# === JWT TOKEN ALIAS ===
echo "💡 Adding halo-token alias..."
cat <<'BASH' >/usr/local/bin/halo-token
#!/bin/bash
if [ -z "$1" ]; then
  echo "Usage: halo-token 'Client Name'"
  exit 1
fi
cd /opt/halo-xero-widget
node -e "import jwt from 'jsonwebtoken'; import dotenv from 'dotenv'; dotenv.config(); console.log(jwt.sign({ clientName: '$1', iat: Math.floor(Date.now()/1000) }, process.env.HALO_JWT_SECRET));"
BASH
chmod +x /usr/local/bin/halo-token

# === VALIDATION ===
echo "🔍 Running validation checks..."
curl -I http://localhost:3000 || true
pm2 status || true
ss -tulpn | grep 3000 || true

# === SUMMARY ===
cat <<EOT

------------------------------------
✅ Install complete!
Accessible at: https://$DOMAIN

Halo JWT Secret: $JWT_SECRET
Halo Widget Secret: $WIDGET_SECRET
Secrets stored in: $APP_DIR/.env

Installer version: v6.2  (generated $(date +%Y-%m-%d))

Next steps:
 - Add Xero Client ID & Secret to $APP_DIR/.env
 - Authorise via: https://$DOMAIN/auth/connect
 - Test widget via: https://$DOMAIN/finance?contactName={ClientName}&token={JWT}
 - Generate JWT: halo-token "Client Name"
------------------------------------
EOT
