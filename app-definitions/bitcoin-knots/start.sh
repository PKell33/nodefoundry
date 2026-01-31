#!/bin/bash
# Start script for development mode

APP_DIR="${APP_DIR:-/opt/ownprem/apps/bitcoin-knots}"
DATA_DIR="${DATA_DIR:-/var/lib/bitcoin}"

# Dev mode: create mock log and sleep
if [ "${DEV_MODE:-}" = "true" ] || [ ! -w "/opt" ]; then
  echo "Bitcoin Knots started (dev/mock mode)!"

  # Create a mock log file so the UI has something to show
  LOG_DIR="${APP_DIR}/logs"
  mkdir -p "$LOG_DIR"
  LOG_FILE="${LOG_DIR}/bitcoin-knots.log"

  echo "$(date -Iseconds) [INFO] Bitcoin Knots started in dev/mock mode" >> "$LOG_FILE"
  echo "$(date -Iseconds) [INFO] This is a simulated log - no actual Bitcoin node is running" >> "$LOG_FILE"

  # Keep running so the app shows as "running"
  while true; do
    echo "$(date -Iseconds) [INFO] Heartbeat - mock Bitcoin Knots is alive" >> "$LOG_FILE"
    sleep 60
  done &
  exit 0
fi

# Production: use systemctl
systemctl start bitcoin
