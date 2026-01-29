#!/bin/bash
# Build Caddy with layer4 module for TCP proxying
# This is required for proxying TCP services like Electrs

set -e

echo "Building Caddy with layer4 module..."

# Check if Go is installed
if ! command -v go &> /dev/null; then
    echo "Go is required to build Caddy. Installing..."
    sudo apt-get update
    sudo apt-get install -y golang-go
fi

# Check if xcaddy is installed
if ! command -v xcaddy &> /dev/null; then
    echo "Installing xcaddy..."
    go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
    export PATH="$PATH:$(go env GOPATH)/bin"
fi

# Build Caddy with layer4 module
echo "Building Caddy with layer4 module..."
xcaddy build --with github.com/mholt/caddy-l4

# Move the binary
sudo mv caddy /usr/bin/caddy-l4
sudo chmod +x /usr/bin/caddy-l4

echo ""
echo "Caddy with layer4 built successfully!"
echo ""
echo "To use it, update your systemd service or run directly:"
echo "  sudo ln -sf /usr/bin/caddy-l4 /usr/bin/caddy"
echo "  sudo systemctl restart caddy"
echo ""
echo "Or to test:"
echo "  /usr/bin/caddy-l4 run --config /etc/caddy/Caddyfile"
