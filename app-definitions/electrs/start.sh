#!/bin/bash
# Start script for development mode

APP_DIR="${APP_DIR:-/opt/ownprem/apps/electrs}"
DATA_DIR="${DATA_DIR:-/var/lib/electrs}"

# Dev mode: create mock log and sleep
if [ "${DEV_MODE:-}" = "true" ] || [ ! -w "/opt" ]; then
  echo "Electrs started (dev/mock mode)!"

  # Create a mock log file so the UI has something to show
  LOG_DIR="${APP_DIR}/logs"
  mkdir -p "$LOG_DIR"
  LOG_FILE="${LOG_DIR}/electrs.log"

  echo "$(date -Iseconds) [INFO] Electrs started in dev/mock mode" >> "$LOG_FILE"
  echo "$(date -Iseconds) [INFO] This is a simulated log - no actual Electrs server is running" >> "$LOG_FILE"

  # Keep running so the app shows as "running"
  while true; do
    echo "$(date -Iseconds) [INFO] Heartbeat - mock Electrs is alive" >> "$LOG_FILE"
    sleep 60
  done &
  exit 0
fi

# Production: use systemctl
systemctl start electrs
