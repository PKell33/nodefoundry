#!/bin/bash
# Start script for development mode

# Dev mode: just exit successfully
if [ "${DEV_MODE:-}" = "true" ] || [ ! -w "/opt" ]; then
  echo "Bitcoin Knots + BIP-110 started (dev/mock mode)!"
  while true; do sleep 3600; done &
  exit 0
fi

# Production: use systemctl
systemctl start bitcoin
