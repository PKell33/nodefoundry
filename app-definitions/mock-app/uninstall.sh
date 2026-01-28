#!/bin/bash
set -e

APP_DIR="${APP_DIR:-/opt/nodefoundry/apps/mock-app}"

echo "Uninstalling Mock App..."

# Stop and disable service
systemctl stop mock-app || true
systemctl disable mock-app || true

# Remove service file
rm -f /etc/systemd/system/mock-app.service

# Reload systemd
systemctl daemon-reload

# Remove app directory
rm -rf "$APP_DIR"

echo "Mock App uninstalled successfully!"
