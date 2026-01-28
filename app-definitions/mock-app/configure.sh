#!/bin/bash
set -e

echo "Configuring Mock App..."

# Reload and restart the service
systemctl daemon-reload
systemctl restart mock-app

echo "Mock App configured successfully!"
