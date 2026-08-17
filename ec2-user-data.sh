#!/bin/bash
set -euxo pipefail

APP_NAME="solidarity-in-action"
APP_DIR="/opt/$APP_NAME"
APP_REPO="${APP_REPO_URL:-https://github.com/your-org/$APP_NAME.git}"
PORT="${PORT:-3000}"
APP_URL="${APP_URL:-http://$(curl -fsS http://169.254.169.254/latest/meta-data/public-hostname 2>/dev/null || echo localhost)}"
SESSION_SECRET="${SESSION_SECRET:-$(openssl rand -hex 32)}"

# Update system packages
if command -v dnf >/dev/null 2>&1; then
  dnf update -y
  dnf install -y git nginx curl openssl
elif command -v yum >/dev/null 2>&1; then
  yum update -y
  amazon-linux-extras enable nginx1 || true
  yum install -y git nginx curl openssl
else
  echo "Unsupported OS. This script is designed for Amazon Linux."
  exit 1
fi

# Install Node.js 20
if ! command -v node >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  fi
fi

# Download app source
mkdir -p "$APP_DIR"
if [ -f /tmp/solidarity-in-action.zip ]; then
  rm -rf /tmp/solidarity-in-action
  unzip -o /tmp/solidarity-in-action.zip -d /tmp
  cp -a /tmp/solidarity-in-action/. "$APP_DIR"/
elif [ -d /tmp/solidarity-in-action ]; then
  cp -a /tmp/solidarity-in-action/. "$APP_DIR"/
elif git ls-remote "$APP_REPO" >/dev/null 2>&1; then
  git clone "$APP_REPO" "$APP_DIR"
else
  echo "No app source found. Provide /tmp/solidarity-in-action.zip or set APP_REPO_URL."
  exit 1
fi

cd "$APP_DIR"
if [ ! -f package.json ]; then
  echo "package.json not found in $APP_DIR"
  exit 1
fi

# Install production dependencies
npm install --omit=dev

# Create .env if absent
if [ ! -f .env ]; then
  cp .env.example .env
fi

cat > .env <<EOF
PORT=$PORT
NODE_ENV=production
SESSION_SECRET=$SESSION_SECRET
STUN_URL=stun:stun.l.google.com:19302
TURN_URL=
TURN_USERNAME=
TURN_CREDENTIAL=
APP_URL=$APP_URL
EOF

# Create systemd service
cat > /etc/systemd/system/solidarity-in-action.service <<EOF
[Unit]
Description=Solidarity in Action Node App
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
User=root
Group=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable solidarity-in-action.service
systemctl start solidarity-in-action.service

# Configure NGINX reverse proxy
cat > /etc/nginx/conf.d/solidarity-in-action.conf <<EOF
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

nginx -t
systemctl enable --now nginx

# Optional firewall rule
if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

echo "Solidarity in Action setup complete."
echo "App dir: $APP_DIR"
echo "App URL: $APP_URL"
echo "Service: systemctl status solidarity-in-action.service"
echo "Logs: journalctl -u solidarity-in-action.service -f"
