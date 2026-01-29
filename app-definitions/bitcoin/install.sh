#!/bin/bash
set -e

# Configuration from environment
APP_DIR="${APP_DIR:-/opt/nodefoundry/apps/bitcoin}"
DATA_DIR="${DATA_DIR:-/var/lib/bitcoin}"
VERSION="${APP_VERSION:-28.0}"
NETWORK="${NETWORK:-mainnet}"

echo "Installing Bitcoin Core ${VERSION}..."
echo "APP_DIR: $APP_DIR"
echo "DATA_DIR: $DATA_DIR"

# Create directories
mkdir -p "$APP_DIR"
mkdir -p "$DATA_DIR"

# Determine architecture
ARCH=$(uname -m)
case $ARCH in
  x86_64)  ARCH_NAME="x86_64-linux-gnu" ;;
  aarch64) ARCH_NAME="aarch64-linux-gnu" ;;
  *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Download Bitcoin Core
DOWNLOAD_URL="https://bitcoincore.org/bin/bitcoin-core-${VERSION}/bitcoin-${VERSION}-${ARCH_NAME}.tar.gz"
CHECKSUM_URL="https://bitcoincore.org/bin/bitcoin-core-${VERSION}/SHA256SUMS"

echo "Downloading from: $DOWNLOAD_URL"

cd /tmp
curl -LO "$DOWNLOAD_URL"
curl -LO "$CHECKSUM_URL"

# Verify checksum
EXPECTED_HASH=$(grep "bitcoin-${VERSION}-${ARCH_NAME}.tar.gz" SHA256SUMS | cut -d' ' -f1)
ACTUAL_HASH=$(sha256sum "bitcoin-${VERSION}-${ARCH_NAME}.tar.gz" | cut -d' ' -f1)

if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
  echo "Checksum verification failed!"
  echo "Expected: $EXPECTED_HASH"
  echo "Got: $ACTUAL_HASH"
  exit 1
fi

echo "Checksum verified successfully"

# Extract
tar -xzf "bitcoin-${VERSION}-${ARCH_NAME}.tar.gz"

# Install binaries
cp "bitcoin-${VERSION}/bin/"* "$APP_DIR/"

# Clean up
rm -rf "bitcoin-${VERSION}" "bitcoin-${VERSION}-${ARCH_NAME}.tar.gz" SHA256SUMS

# Create bitcoin user if running as root
if [ "$(id -u)" = "0" ]; then
  id -u bitcoin &>/dev/null || useradd -r -s /bin/false bitcoin
  chown -R bitcoin:bitcoin "$DATA_DIR"
  chown -R bitcoin:bitcoin "$APP_DIR"
fi

# Create systemd service
if [ "$(id -u)" = "0" ]; then
  # Determine network flag
  NETWORK_FLAG=""
  case $NETWORK in
    testnet) NETWORK_FLAG="-testnet" ;;
    signet)  NETWORK_FLAG="-signet" ;;
    regtest) NETWORK_FLAG="-regtest" ;;
  esac

  cat > /etc/systemd/system/bitcoin.service << EOF
[Unit]
Description=Bitcoin Core
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bitcoin
Group=bitcoin

ExecStart=${APP_DIR}/bitcoind ${NETWORK_FLAG} \\
  -datadir=${DATA_DIR} \\
  -conf=${DATA_DIR}/bitcoin.conf \\
  -pid=${DATA_DIR}/bitcoind.pid \\
  -server \\
  -daemon=0

ExecStop=${APP_DIR}/bitcoin-cli ${NETWORK_FLAG} -datadir=${DATA_DIR} stop

Restart=on-failure
RestartSec=30
TimeoutStartSec=infinity
TimeoutStopSec=600

# Hardening
PrivateTmp=true
ProtectSystem=full
NoNewPrivileges=true
MemoryDenyWriteExecute=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable bitcoin
  echo "Systemd service created"
else
  echo "Not running as root - skipping systemd service creation"
  cat > "$APP_DIR/start.sh" << EOF
#!/bin/bash
${APP_DIR}/bitcoind -datadir=${DATA_DIR} -conf=${DATA_DIR}/bitcoin.conf -server -daemon=0
EOF
  chmod +x "$APP_DIR/start.sh"
fi

echo "Bitcoin Core ${VERSION} installed successfully!"
