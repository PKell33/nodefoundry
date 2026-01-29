#!/bin/bash
set -e

APP_DIR="${APP_DIR:-/opt/ownprem/apps/bitcoin-core}"
DATA_DIR="${DATA_DIR:-/var/lib/bitcoin}"
VERSION="${APP_VERSION:-28.0}"
NETWORK="${NETWORK:-mainnet}"

# Dev mode: skip actual installation
if [ "${DEV_MODE:-}" = "true" ] || [ ! -w "/opt" ]; then
  echo "Bitcoin Core ${VERSION} installed (dev/mock mode)!"
  exit 0
fi

echo "Installing Bitcoin Core ${VERSION}..."

mkdir -p "$APP_DIR"
mkdir -p "$DATA_DIR"

ARCH=$(uname -m)
case $ARCH in
  x86_64)  ARCH_NAME="x86_64-linux-gnu" ;;
  aarch64) ARCH_NAME="aarch64-linux-gnu" ;;
  *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

DOWNLOAD_URL="https://bitcoincore.org/bin/bitcoin-core-${VERSION}/bitcoin-${VERSION}-${ARCH_NAME}.tar.gz"
CHECKSUM_URL="https://bitcoincore.org/bin/bitcoin-core-${VERSION}/SHA256SUMS"

echo "Downloading from: $DOWNLOAD_URL"

cd /tmp
curl -LO "$DOWNLOAD_URL"
curl -LO "$CHECKSUM_URL"

TARBALL="bitcoin-${VERSION}-${ARCH_NAME}.tar.gz"
EXPECTED_HASH=$(grep "$TARBALL" SHA256SUMS | cut -d' ' -f1)
ACTUAL_HASH=$(sha256sum "$TARBALL" | cut -d' ' -f1)

if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
  echo "Checksum verification failed!"
  exit 1
fi
echo "Checksum verified"

tar -xzf "$TARBALL"
cp "bitcoin-${VERSION}/bin/"* "$APP_DIR/"
rm -rf "bitcoin-${VERSION}" "$TARBALL" SHA256SUMS

if [ "$(id -u)" = "0" ]; then
  id -u bitcoin &>/dev/null || useradd -r -s /bin/false bitcoin
  chown -R bitcoin:bitcoin "$DATA_DIR"
  chown -R bitcoin:bitcoin "$APP_DIR"

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
ExecStart=${APP_DIR}/bitcoind ${NETWORK_FLAG} -datadir=${DATA_DIR} -conf=${DATA_DIR}/bitcoin.conf -server -daemon=0
ExecStop=${APP_DIR}/bitcoin-cli ${NETWORK_FLAG} -datadir=${DATA_DIR} stop
Restart=on-failure
RestartSec=30
TimeoutStartSec=infinity
TimeoutStopSec=600
PrivateTmp=true
ProtectSystem=full
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable bitcoin
fi

echo "Bitcoin Core ${VERSION} installed successfully!"
