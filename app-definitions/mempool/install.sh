#!/bin/bash
set -e

# Configuration from environment
APP_DIR="${APP_DIR:-/opt/ownprem/apps/mempool}"
DATA_DIR="${DATA_DIR:-/var/lib/mempool}"
VERSION="${APP_VERSION:-3.0.0}"
BUILD_DIR="/tmp/mempool-build"

echo "Installing Mempool ${VERSION}..."
echo "APP_DIR: $APP_DIR"
echo "DATA_DIR: $DATA_DIR"

# Create directories
mkdir -p "$APP_DIR"
mkdir -p "$DATA_DIR"
mkdir -p "$BUILD_DIR"

# Install dependencies
if [ "$(id -u)" = "0" ]; then
  apt-get update
  apt-get install -y mariadb-server nginx git curl

  # Install Node.js 20 if not present
  if ! command -v node &> /dev/null || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 18 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi

  # Start and enable MariaDB
  systemctl enable mariadb
  systemctl start mariadb
fi

# Clone repository
cd "$BUILD_DIR"
if [ -d "mempool" ]; then
  cd mempool
  git fetch --tags
  git checkout "v${VERSION}"
else
  git clone --branch "v${VERSION}" --depth 1 https://github.com/mempool/mempool.git
  cd mempool
fi

# Build backend
echo "Building Mempool backend..."
cd backend
npm install --omit=dev
npm run build
cp -r . "$APP_DIR/backend"

# Build frontend
echo "Building Mempool frontend..."
cd ../frontend
npm install --legacy-peer-deps
npm run build -- --configuration production

# Copy frontend to nginx serve directory
mkdir -p "$APP_DIR/frontend"
cp -r dist/mempool/* "$APP_DIR/frontend/" 2>/dev/null || cp -r dist/* "$APP_DIR/frontend/"

# Clean up
rm -rf "$BUILD_DIR"

# Create mempool user
if [ "$(id -u)" = "0" ]; then
  id -u mempool &>/dev/null || useradd -r -s /bin/false mempool
  chown -R mempool:mempool "$DATA_DIR"
  chown -R mempool:mempool "$APP_DIR"
fi

# Create nginx config
if [ "$(id -u)" = "0" ]; then
  cat > /etc/nginx/sites-available/mempool << 'EOF'
server {
    listen 3006;
    server_name _;

    root /opt/ownprem/apps/mempool/frontend;
    index index.html;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Frontend
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api {
        proxy_pass http://127.0.0.1:8999/api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:8999/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

  ln -sf /etc/nginx/sites-available/mempool /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
fi

# Create systemd service for backend
if [ "$(id -u)" = "0" ]; then
  cat > /etc/systemd/system/mempool.service << EOF
[Unit]
Description=Mempool Backend
After=network-online.target mariadb.service bitcoin.service
Wants=network-online.target
Requires=mariadb.service

[Service]
Type=simple
User=mempool
Group=mempool

WorkingDirectory=${APP_DIR}/backend
ExecStart=/usr/bin/node --max-old-space-size=2048 dist/index.js

Restart=on-failure
RestartSec=30

Environment=NODE_ENV=production

# Hardening
PrivateTmp=true
ProtectSystem=full
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable mempool nginx
  echo "Systemd services created"
else
  echo "Not running as root - skipping systemd service creation"
  cat > "$APP_DIR/start.sh" << EOF
#!/bin/bash
cd ${APP_DIR}/backend
node --max-old-space-size=2048 dist/index.js
EOF
  chmod +x "$APP_DIR/start.sh"
fi

echo "Mempool ${VERSION} installed successfully!"
echo "Note: Database setup will be completed during configuration"
