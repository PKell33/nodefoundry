#!/bin/bash
set -e

DATA_DIR="${DATA_DIR:-/var/lib/bitcoin}"

echo "Configuring Bitcoin Knots + BIP-110..."

if [ ! -f "${DATA_DIR}/bitcoin.conf" ]; then
  echo "Error: bitcoin.conf not found"
  exit 1
fi

if [ "$(id -u)" = "0" ]; then
  chown bitcoin:bitcoin "${DATA_DIR}/bitcoin.conf"
  chmod 600 "${DATA_DIR}/bitcoin.conf"
  systemctl daemon-reload
  systemctl restart bitcoin
fi

echo "Bitcoin Knots + BIP-110 configured successfully!"
