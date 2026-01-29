#!/bin/bash
# Stop script for development mode

# Dev mode: just exit successfully
if [ "${DEV_MODE:-}" = "true" ] || [ ! -w "/opt" ]; then
  echo "Bitcoin Knots + BIP-110 stopped (dev/mock mode)!"
  pkill -f "bitcoin-bip110.*sleep" 2>/dev/null || true
  exit 0
fi

# Production: use systemctl
systemctl stop bitcoin
