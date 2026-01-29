#!/bin/bash
set -e

# Caddy Installation Script for Ownprem
# Usage: sudo ./install-caddy.sh <domain> [email]

DOMAIN="${1:-}"
EMAIL="${2:-admin@$DOMAIN}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

if [[ $EUID -ne 0 ]]; then
   log_error "This script must be run as root (use sudo)"
   exit 1
fi

if [[ -z "$DOMAIN" ]]; then
    log_error "Usage: $0 <domain> [admin-email]"
    log_info "Example: $0 foundry.example.com admin@example.com"
    exit 1
fi

log_info "Installing Caddy for domain: $DOMAIN"

# Install Caddy if not present
if ! command -v caddy &> /dev/null; then
    log_info "Installing Caddy..."

    # Detect OS
    if [[ -f /etc/debian_version ]]; then
        # Debian/Ubuntu
        apt-get update
        apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
        apt-get update
        apt-get install -y caddy
    elif [[ -f /etc/redhat-release ]]; then
        # RHEL/CentOS/Fedora
        dnf install -y 'dnf-command(copr)'
        dnf copr enable -y @caddy/caddy
        dnf install -y caddy
    else
        log_error "Unsupported OS. Please install Caddy manually: https://caddyserver.com/docs/install"
        exit 1
    fi
else
    log_info "Caddy already installed: $(caddy version)"
fi

# Create log directory
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy

# Backup existing Caddyfile if present
if [[ -f /etc/caddy/Caddyfile ]]; then
    BACKUP="/etc/caddy/Caddyfile.backup.$(date +%Y%m%d%H%M%S)"
    log_info "Backing up existing Caddyfile to $BACKUP"
    cp /etc/caddy/Caddyfile "$BACKUP"
fi

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Generate Caddyfile from template
log_info "Generating Caddyfile..."
cat > /etc/caddy/Caddyfile << EOF
# Ownprem Caddyfile
# Generated on $(date)
# Domain: $DOMAIN

{
    email $EMAIL
}

$DOMAIN {
    # Security headers
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }

    # Serve static UI files
    root * /opt/ownprem/repo/apps/ui/dist

    # API proxy
    handle /api/* {
        reverse_proxy localhost:3001 {
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
        }
    }

    # WebSocket proxy for Socket.io
    handle /socket.io/* {
        reverse_proxy localhost:3001 {
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
            header_up Connection {>Connection}
            header_up Upgrade {>Upgrade}
        }
    }

    # Health endpoints
    handle /health {
        reverse_proxy localhost:3001
    }

    handle /ready {
        reverse_proxy localhost:3001
    }

    # App proxies
    handle /apps/* {
        reverse_proxy localhost:3001 {
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
        }
    }

    # SPA fallback
    handle {
        try_files {path} /index.html
        file_server
    }

    # Logging
    log {
        output file /var/log/caddy/ownprem-access.log {
            roll_size 100mb
            roll_keep 5
            roll_keep_for 720h
        }
        format json
    }
}

# Redirect www to non-www
www.$DOMAIN {
    redir https://$DOMAIN{uri} permanent
}
EOF

# Validate configuration
log_info "Validating Caddyfile..."
if ! caddy validate --config /etc/caddy/Caddyfile; then
    log_error "Caddyfile validation failed"
    exit 1
fi

# Update CORS origin in orchestrator config
ORCHESTRATOR_ENV="/etc/ownprem/orchestrator.env"
if [[ -f "$ORCHESTRATOR_ENV" ]]; then
    log_info "Updating CORS_ORIGIN in orchestrator config..."
    if grep -q "^CORS_ORIGIN=" "$ORCHESTRATOR_ENV"; then
        sed -i "s|^CORS_ORIGIN=.*|CORS_ORIGIN=https://$DOMAIN|" "$ORCHESTRATOR_ENV"
    else
        echo "CORS_ORIGIN=https://$DOMAIN" >> "$ORCHESTRATOR_ENV"
    fi
fi

# Enable and start Caddy
log_info "Enabling Caddy service..."
systemctl enable caddy
systemctl restart caddy

# Check status
if systemctl is-active --quiet caddy; then
    log_info "Caddy is running"
else
    log_error "Caddy failed to start"
    journalctl -u caddy --no-pager -n 20
    exit 1
fi

log_info "Caddy installation complete!"
echo ""
echo "Configuration:"
echo "  Domain: $DOMAIN"
echo "  Email: $EMAIL"
echo "  Caddyfile: /etc/caddy/Caddyfile"
echo "  Logs: /var/log/caddy/"
echo ""
echo "Caddy will automatically obtain SSL certificates from Let's Encrypt."
echo ""
echo "Ensure the following:"
echo "  1. DNS A record for $DOMAIN points to this server"
echo "  2. Ports 80 and 443 are open in firewall"
echo "  3. Ownprem services are running on port 3001"
echo ""
echo "Commands:"
echo "  sudo systemctl status caddy"
echo "  sudo systemctl reload caddy"
echo "  sudo caddy validate --config /etc/caddy/Caddyfile"
echo "  sudo journalctl -u caddy -f"
