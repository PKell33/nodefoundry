#!/bin/bash
set -e

APP_DIR="${APP_DIR:-/opt/ownprem/apps/electrs}"
DATA_DIR="${DATA_DIR:-/var/lib/electrs}"
KEEP_DATA="${KEEP_DATA:-false}"

echo "Uninstalling Electrs..."

# Stop and disable service
if [ "$(id -u)" = "0" ]; then
  systemctl stop electrs || true
  systemctl disable electrs || true
  rm -f /etc/systemd/system/electrs.service
  systemctl daemon-reload
fi

# Remove app directory
rm -rf "$APP_DIR"

# Remove data directory only if explicitly requested
if [ "$KEEP_DATA" = "false" ]; then
  echo "Removing index data..."
  rm -rf "$DATA_DIR"
else
  echo "Keeping index data at $DATA_DIR"
fi

# Remove electrs user
if [ "$(id -u)" = "0" ]; then
  if id -u electrs &>/dev/null; then
    userdel electrs 2>/dev/null || true
  fi
fi

echo "Electrs uninstalled successfully!"
