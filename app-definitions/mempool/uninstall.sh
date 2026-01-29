#!/bin/bash
set -e

APP_DIR="${APP_DIR:-/opt/nodefoundry/apps/mempool}"
DATA_DIR="${DATA_DIR:-/var/lib/mempool}"
KEEP_DATA="${KEEP_DATA:-false}"
MYSQL_DATABASE="${MYSQL_DATABASE:-mempool}"
MYSQL_USER="${MYSQL_USER:-mempool}"

echo "Uninstalling Mempool..."

# Stop services
if [ "$(id -u)" = "0" ]; then
  systemctl stop mempool || true
  systemctl disable mempool || true
  rm -f /etc/systemd/system/mempool.service

  # Remove nginx config
  rm -f /etc/nginx/sites-enabled/mempool
  rm -f /etc/nginx/sites-available/mempool
  systemctl reload nginx || true

  systemctl daemon-reload
fi

# Remove app directory
rm -rf "$APP_DIR"

# Remove data and database
if [ "$KEEP_DATA" = "false" ]; then
  rm -rf "$DATA_DIR"

  # Drop database and user
  if [ "$(id -u)" = "0" ]; then
    mysql -u root << EOF || true
DROP DATABASE IF EXISTS \`${MYSQL_DATABASE}\`;
DROP USER IF EXISTS '${MYSQL_USER}'@'localhost';
FLUSH PRIVILEGES;
EOF
    echo "Database removed"
  fi
else
  echo "Keeping data at $DATA_DIR"
fi

# Remove mempool user
if [ "$(id -u)" = "0" ]; then
  if id -u mempool &>/dev/null; then
    userdel mempool 2>/dev/null || true
  fi
fi

echo "Mempool uninstalled successfully!"
