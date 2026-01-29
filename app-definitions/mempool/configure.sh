#!/bin/bash
set -e

APP_DIR="${APP_DIR:-/opt/ownprem/apps/mempool}"
DATA_DIR="${DATA_DIR:-/var/lib/mempool}"

# Database credentials from environment
MYSQL_DATABASE="${MYSQL_DATABASE:-mempool}"
MYSQL_USER="${MYSQL_USER:-mempool}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-}"

echo "Configuring Mempool..."

# Ensure config file exists
if [ ! -f "${APP_DIR}/backend/mempool-config.json" ]; then
  echo "Error: mempool-config.json not found"
  exit 1
fi

# Setup database if running as root
if [ "$(id -u)" = "0" ]; then
  echo "Setting up MariaDB database..."

  # Create database and user if they don't exist
  mysql -u root << EOF
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\`;
CREATE USER IF NOT EXISTS '${MYSQL_USER}'@'localhost' IDENTIFIED BY '${MYSQL_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_USER}'@'localhost';
FLUSH PRIVILEGES;
EOF

  echo "Database configured"
fi

# Set proper permissions
if [ "$(id -u)" = "0" ]; then
  chown mempool:mempool "${APP_DIR}/backend/mempool-config.json"
  chmod 600 "${APP_DIR}/backend/mempool-config.json"
fi

# Update frontend config for base path
if [ "$(id -u)" = "0" ]; then
  # Update nginx config if basePath changes
  systemctl reload nginx || true
fi

# Restart services
if [ "$(id -u)" = "0" ]; then
  systemctl daemon-reload
  systemctl restart mempool
fi

echo "Mempool configured successfully!"
