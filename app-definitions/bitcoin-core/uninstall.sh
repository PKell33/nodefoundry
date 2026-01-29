#!/bin/bash
set -e

APP_DIR="${APP_DIR:-/opt/ownprem/apps/bitcoin-core}"
DATA_DIR="${DATA_DIR:-/var/lib/bitcoin}"
KEEP_DATA="${KEEP_DATA:-false}"

echo "Uninstalling Bitcoin Core..."

if [ "$(id -u)" = "0" ]; then
  systemctl stop bitcoin || true
  systemctl disable bitcoin || true
  rm -f /etc/systemd/system/bitcoin.service
  systemctl daemon-reload
fi

rm -rf "$APP_DIR"

if [ "$KEEP_DATA" = "false" ]; then
  rm -rf "$DATA_DIR"
fi

echo "Bitcoin Core uninstalled!"
