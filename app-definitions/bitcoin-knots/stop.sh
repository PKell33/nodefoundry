#!/bin/bash
# Stop script for development mode

APP_DIR="${APP_DIR:-/opt/ownprem/apps/bitcoin-knots}"

# Dev mode: kill the mock process and log
if [ "${DEV_MODE:-}" = "true" ] || [ ! -w "/opt" ]; then
  echo "Bitcoin Knots stopped (dev/mock mode)!"

  # Log the stop event
  LOG_FILE="${APP_DIR}/logs/bitcoin-knots.log"
  if [ -f "$LOG_FILE" ]; then
    echo "$(date -Iseconds) [INFO] Bitcoin Knots stopped (dev/mock mode)" >> "$LOG_FILE"
  fi

  # Kill background sleep processes
  pkill -f "bitcoin-knots.*sleep" 2>/dev/null || true
  exit 0
fi

# Production: use systemctl
systemctl stop bitcoin
