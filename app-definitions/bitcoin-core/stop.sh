#!/bin/bash
# Stop script for development mode

# Dev mode: just exit successfully
if [ "${DEV_MODE:-}" = "true" ] || [ ! -w "/opt" ]; then
  echo "Bitcoin Core stopped (dev/mock mode)!"
  # Kill background processes if any
  pkill -f "bitcoin-core.*sleep" 2>/dev/null || true
  exit 0
fi

# Production: use systemctl
systemctl stop bitcoin
