#!/bin/bash
set -e

# Configuration from environment
APP_DIR="${APP_DIR:-/opt/ownprem/apps/electrs}"
DATA_DIR="${DATA_DIR:-/var/lib/electrs}"
VERSION="${APP_VERSION:-0.10.6}"
BUILD_DIR="/tmp/electrs-build"

# Dev mode: skip actual installation (building takes 10-20 minutes)
if [ "${DEV_MODE:-}" = "true" ] || [ ! -w "/opt" ]; then
  echo "Electrs ${VERSION} installed (dev/mock mode)!"
  mkdir -p "$APP_DIR"
  mkdir -p "$DATA_DIR"
  exit 0
fi

echo "Installing Electrs ${VERSION}..."
echo "APP_DIR: $APP_DIR"
echo "DATA_DIR: $DATA_DIR"

# Create directories
mkdir -p "$APP_DIR"
mkdir -p "$DATA_DIR"
mkdir -p "$BUILD_DIR"

# Install build dependencies
if [ "$(id -u)" = "0" ]; then
  apt-get update
  apt-get install -y build-essential clang cmake librocksdb-dev git curl
fi

# Install Rust if not present
if ! command -v cargo &> /dev/null; then
  echo "Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi

# Clone and build
cd "$BUILD_DIR"
if [ -d "electrs" ]; then
  cd electrs
  git fetch --tags
  git checkout "v${VERSION}"
else
  git clone --branch "v${VERSION}" https://github.com/romanz/electrs.git
  cd electrs
fi

echo "Building Electrs (this may take 10-20 minutes)..."
ROCKSDB_INCLUDE_DIR=/usr/include ROCKSDB_LIB_DIR=/usr/lib cargo build --locked --release

# Install binary
cp target/release/electrs "$APP_DIR/"

# Clean up build directory
rm -rf "$BUILD_DIR"

# Create electrs user if running as root
if [ "$(id -u)" = "0" ]; then
  id -u electrs &>/dev/null || useradd -r -s /usr/sbin/nologin electrs
  chown -R electrs:electrs "$DATA_DIR"
  chown -R electrs:electrs "$APP_DIR"
fi

# Create systemd service
if [ "$(id -u)" = "0" ]; then
  # Generate systemd service file with properly quoted paths
  cat > /etc/systemd/system/ownprem-electrs.service << EOF
[Unit]
Description=Electrs - Electrum Server
After=network-online.target ownprem-bitcoin-core.service
Wants=network-online.target
Requires=ownprem-bitcoin-core.service

[Service]
Type=simple
User=electrs
Group=electrs

ExecStart="${APP_DIR}/electrs" \\
  --conf "${DATA_DIR}/electrs.toml" \\
  --db-dir "${DATA_DIR}/db"

Restart=on-failure
RestartSec=30
TimeoutStopSec=300

# Hardening
PrivateTmp=true
ProtectSystem=full
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable ownprem-electrs
  echo "Systemd service created"
else
  echo "Not running as root - skipping systemd service creation"
  cat > "${APP_DIR}/start.sh" << EOF
#!/bin/bash
"${APP_DIR}/electrs" --conf "${DATA_DIR}/electrs.toml" --db-dir "${DATA_DIR}/db"
EOF
  chmod +x "${APP_DIR}/start.sh"
fi

echo "Electrs ${VERSION} installed successfully!"
