#!/bin/bash
set -e

APP_DIR="${APP_DIR:-/opt/nodefoundry/apps/bitcoin}"
DATA_DIR="${DATA_DIR:-/var/lib/bitcoin}"
KEEP_DATA="${KEEP_DATA:-false}"

echo "Uninstalling Bitcoin Core..."

# Stop and disable service
if [ "$(id -u)" = "0" ]; then
  systemctl stop bitcoin || true
  systemctl disable bitcoin || true
  rm -f /etc/systemd/system/bitcoin.service
  systemctl daemon-reload
fi

# Remove app directory (binaries)
rm -rf "$APP_DIR"

# Remove data directory only if explicitly requested
if [ "$KEEP_DATA" = "false" ]; then
  echo "Removing blockchain data (this may take a while)..."
  rm -rf "$DATA_DIR"
else
  echo "Keeping blockchain data at $DATA_DIR"
fi

# Remove bitcoin user if it has no other processes
if [ "$(id -u)" = "0" ]; then
  if id -u bitcoin &>/dev/null; then
    userdel bitcoin 2>/dev/null || true
  fi
fi

echo "Bitcoin Core uninstalled successfully!"
