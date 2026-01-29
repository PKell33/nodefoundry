#!/bin/bash
set -e

DATA_DIR="${DATA_DIR:-/var/lib/electrs}"

echo "Configuring Electrs..."

# Ensure config file exists
if [ ! -f "${DATA_DIR}/electrs.toml" ]; then
  echo "Error: electrs.toml not found at ${DATA_DIR}/electrs.toml"
  exit 1
fi

# Set proper permissions
if [ "$(id -u)" = "0" ]; then
  chown electrs:electrs "${DATA_DIR}/electrs.toml"
  chmod 600 "${DATA_DIR}/electrs.toml"
fi

# Reload and restart the service
if [ "$(id -u)" = "0" ]; then
  systemctl daemon-reload
  systemctl restart electrs
fi

echo "Electrs configured successfully!"
