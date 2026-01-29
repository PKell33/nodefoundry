#!/bin/bash
set -e

DATA_DIR="${DATA_DIR:-/var/lib/bitcoin}"

echo "Configuring Bitcoin Core..."

# Ensure config file exists (should be written by orchestrator)
if [ ! -f "${DATA_DIR}/bitcoin.conf" ]; then
  echo "Error: bitcoin.conf not found at ${DATA_DIR}/bitcoin.conf"
  exit 1
fi

# Set proper permissions
if [ "$(id -u)" = "0" ]; then
  chown bitcoin:bitcoin "${DATA_DIR}/bitcoin.conf"
  chmod 600 "${DATA_DIR}/bitcoin.conf"
fi

# Reload and restart the service
if [ "$(id -u)" = "0" ]; then
  systemctl daemon-reload
  systemctl restart bitcoin
fi

echo "Bitcoin Core configured successfully!"
