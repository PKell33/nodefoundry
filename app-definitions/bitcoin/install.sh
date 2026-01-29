#!/bin/bash
set -e

# Configuration from environment
APP_DIR="${APP_DIR:-/opt/nodefoundry/apps/bitcoin}"
DATA_DIR="${DATA_DIR:-/var/lib/bitcoin}"
VERSION="${APP_VERSION:-29.2.knots20251110}"
NETWORK="${NETWORK:-mainnet}"
VARIANT="${VARIANT:-standard}"

echo "Installing Bitcoin Knots ${VERSION} (${VARIANT})..."
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

# Set download URLs based on variant
if [ "$VARIANT" = "bip110" ]; then
  # BIP-110 enabled variant from dathonohm/bitcoin
  BIP110_VERSION="v0.1"
  DOWNLOAD_URL="https://github.com/dathonohm/bitcoin/releases/download/v${VERSION}%2Bbip110-${BIP110_VERSION}/bitcoin-${VERSION}+bip110-${BIP110_VERSION}-${ARCH_NAME}.tar.gz"
  CHECKSUM_URL="https://github.com/dathonohm/bitcoin/releases/download/v${VERSION}%2Bbip110-${BIP110_VERSION}/SHA256SUMS"
  TARBALL_NAME="bitcoin-${VERSION}+bip110-${BIP110_VERSION}-${ARCH_NAME}.tar.gz"
  EXTRACT_DIR="bitcoin-${VERSION}+bip110-${BIP110_VERSION}"
  echo "Using BIP-110 enabled variant (temporary data restrictions)"
  echo "Learn more: https://bip110.org/"
else
  # Standard Bitcoin Knots
  DOWNLOAD_URL="https://bitcoinknots.org/files/29.x/${VERSION}/bitcoin-${VERSION}-${ARCH_NAME}.tar.gz"
  CHECKSUM_URL="https://bitcoinknots.org/files/29.x/${VERSION}/SHA256SUMS"
  TARBALL_NAME="bitcoin-${VERSION}-${ARCH_NAME}.tar.gz"
  EXTRACT_DIR="bitcoin-${VERSION}"
fi

echo "Downloading from: $DOWNLOAD_URL"

cd /tmp

# Download Bitcoin Knots
curl -LO "$DOWNLOAD_URL"
curl -LO "$CHECKSUM_URL"

# Verify checksum
EXPECTED_HASH=$(grep "$TARBALL_NAME" SHA256SUMS | cut -d' ' -f1)
ACTUAL_HASH=$(sha256sum "$TARBALL_NAME" | cut -d' ' -f1)

if [ -z "$EXPECTED_HASH" ]; then
  echo "Warning: Could not find checksum for $TARBALL_NAME in SHA256SUMS"
  echo "Proceeding without verification..."
elif [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
  echo "Checksum verification failed!"
  echo "Expected: $EXPECTED_HASH"
  echo "Got: $ACTUAL_HASH"
  exit 1
else
  echo "Checksum verified successfully"
fi

# Extract
tar -xzf "$TARBALL_NAME"

# Install binaries
cp "${EXTRACT_DIR}/bin/"* "$APP_DIR/"

# Clean up
rm -rf "$EXTRACT_DIR" "$TARBALL_NAME" SHA256SUMS

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
Description=Bitcoin Knots${VARIANT:+ (${VARIANT})}
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

echo ""
echo "Bitcoin Knots ${VERSION} installed successfully!"
if [ "$VARIANT" = "bip110" ]; then
  echo ""
  echo "BIP-110 is enabled. This node will signal for and enforce"
  echo "temporary restrictions on arbitrary data storage."
  echo "Learn more: https://bip110.org/"
fi
