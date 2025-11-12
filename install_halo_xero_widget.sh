#!/bin/bash
# =====================================================
# Halo ↔ Xero Widget Installer v6
# Author: Engage Technology / Sean Glasspool
# =====================================================

set -e
APP_DIR="/opt/halo-xero-widget"
REPO_ZIP_URL="https://github.com/smegoff/halo-xero-widget/raw/main/halo-xero-widget.zip"
SERVER_JS_URL="https://raw.githubusercontent.com/smegoff/halo-xero-widget/main/server.js"
NODE_VER="20"

echo "🚀 Halo ↔ Xero Widget Installer v6 starting..."

# --- Confirm we're running as root or sudo ---
if [[ $EUID -ne 0 ]]; then
  echo "❌ Please run this script as root (sudo bash install_halo_xero_widget_v6.sh)"
  exit 1
fi

# --- Update system ---
apt update -y && apt install -y curl unzip ufw fail2ban nginx nodejs npm

# --- Setup Node version if needed ---
if ! command -v node >/dev/null 2>&1; then
  echo "⚙️ Installing Node.js v${NODE_VER}..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VER}.x | bash -
  apt install -y nodejs
fi

# --- Create app directory ---
mkdir -p "$APP_DIR"
cd "$APP_DIR"

# --- Download & extract repo ---
echo "📦 Downloading Halo-Xero widget package..."
curl -fsSL "$REPO_ZIP_URL" -o halo-xero-widget.zip
unzip -o halo-xero-widget.zip -d "$APP_DIR"

# --- Always pull the latest server.js ---
echo "📥 Fetching latest server.js..."
curl -fsSL "$SERVER_JS_URL" -o "$APP_DIR/server.js"

# --- Fix permissions ---
chown -R engageadmin:engageadmin "$APP_DIR"
chmod -R 775 "$APP_DIR"

# --- Install Node dependencies ---
echo "📦 Installing dependencies..."
sudo -u engageadmin npm install express axios dotenv ejs jsonwebtoken node-cache

# --- Setup environment file ---
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "⚙️ Creating .env file..."
  cat <<EOF > "$APP_DIR/.env"
# --- Halo / Xero Widget Config ---
PORT=3000
HALO_JWT_SECRET=$(openssl rand -hex 32)
HALO_WIDGET_SECRET=$(openssl rand -hex 32)

# --- Xero OAuth ---
XERO_CLIENT_ID=
XERO_CLIENT_SECRET=
XERO_REDIRECT_URI=https://widget.engagetech.nz/auth/callback
TENANT_ID=
EOF
fi

# --- Create empty tokens file with proper permissions ---
touch "$APP_DIR/tokens.json"
chown engageadmin:engageadmin "$APP_DIR/tokens.json"
chmod 664 "$APP_DIR/tokens.json"

# --- PM2 setup ---
echo "⚙️ Setting up PM2..."
npm install -g pm2
sudo -u engageadmin pm2 start "$APP_DIR/server.js" --name halo-xero
sudo -u engageadmin pm2 save
sudo -u engageadmin pm2 startup systemd -u engageadmin --hp /home/engageadmin

# --- Nginx reverse proxy ---
echo "🌐 Configuring Nginx..."
cat <<'NGINX' > /etc/nginx/sites-available/widget.engagetech.nz
server {
    listen 80;
    server_name widget.engagetech.nz;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/widget.engagetech.nz /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# --- Optional UFW setup ---
read -p "🔒 Configure UFW and SSH whitelist? (y/n): " ENABLE_UFW
if [[ $ENABLE_UFW == "y" || $ENABLE_UFW == "Y" ]]; then
  read -p "Enter comma-separated IPs to allow for SSH (e.g. 202.74.208.244,202.36.209.158): " IP_WHITELIST
  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 80,443/tcp
  IFS=',' read -ra IPS <<< "$IP_WHITELIST"
  for ip in "${IPS[@]}"; do
    ufw allow from "$ip" to any port 22 comment "SSH Whitelist"
  done
  ufw --force enable
  echo "✅ UFW enabled and restricted to specified IPs."
fi

# --- Optional Fail2Ban setup ---
read -p "🧱 Install Fail2Ban jail for SSH? (y/n): " ENABLE_F2B
if [[ $ENABLE_F2B == "y" || $ENABLE_F2B == "Y" ]]; then
  cat <<'JAIL' > /etc/fail2ban/jail.d/ssh.local
[sshd]
enabled = true
port    = ssh
filter  = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 1h
findtime = 10m
JAIL
  systemctl restart fail2ban
  echo "✅ Fail2Ban jail active for SSH."
fi

# --- Add halo-token alias ---
echo "⚙️ Adding halo-token alias..."
if ! grep -q "alias halo-token" /home/engageadmin/.bashrc; then
  echo "alias halo-token='node -e \"import dotenv from \\\"dotenv\\\"; import jwt from \\\"jsonwebtoken\\\"; dotenv.config(); console.log(jwt.sign({ clientName: process.argv[1] || \\\"Test Client\\\", iat: Math.floor(Date.now()/1000) }, process.env.HALO_JWT_SECRET));\"'" >> /home/engageadmin/.bashrc
fi
chown engageadmin:engageadmin /home/engageadmin/.bashrc

# --- Final report ---
HALO_JWT_SECRET=$(grep HALO_JWT_SECRET "$APP_DIR/.env" | cut -d= -f2)
HALO_WIDGET_SECRET=$(grep HALO_WIDGET_SECRET "$APP_DIR/.env" | cut -d= -f2)

echo "------------------------------------"
echo "✅ Install complete!"
echo "Accessible at: https://widget.engagetech.nz"
echo
echo "Halo JWT Secret: $HALO_JWT_SECRET"
echo "Halo Widget Secret: $HALO_WIDGET_SECRET"
echo "Secrets stored in: $APP_DIR/.env"
echo
echo "Next steps:"
echo " - Add these secrets to Halo integration settings"
echo " - Run: halo-token \"Dan Waite (C3601)\" to generate a test token"
echo " - Restart with: pm2 restart halo-xero"
echo "------------------------------------"
