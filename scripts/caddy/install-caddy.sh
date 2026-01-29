#!/bin/bash
set -e

# Caddy Installation Script for Ownprem
# Usage: sudo ./install-caddy.sh <domain> [email]

DOMAIN="${1:-}"
EMAIL="${2:-}"

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
    log_info "Example: $0 ownprem.example.com admin@example.com"
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

# Determine if this is a local domain (needs self-signed certs)
IS_LOCAL=false
if [[ "$DOMAIN" =~ \.(local|localhost|lan|internal|home|test)$ ]] || [[ "$DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    IS_LOCAL=true
    log_info "Local domain detected - using Caddy's internal CA (self-signed)"
else
    if [[ -z "$EMAIL" ]]; then
        EMAIL="admin@$DOMAIN"
    fi
    log_info "Public domain detected - using Let's Encrypt (email: $EMAIL)"
fi

# Generate Caddyfile from template
log_info "Generating Caddyfile..."

if [[ "$IS_LOCAL" == "true" ]]; then
    # Local domain - use internal TLS
    cat > /etc/caddy/Caddyfile << EOF
# Ownprem Caddyfile
# Generated on $(date)
# Domain: $DOMAIN (local - self-signed certificate)

{
    # Use Caddy's internal CA for local domains
    local_certs
    skip_install_trust
}

$DOMAIN {
    tls internal
EOF
else
    # Public domain - use Let's Encrypt
    cat > /etc/caddy/Caddyfile << EOF
# Ownprem Caddyfile
# Generated on $(date)
# Domain: $DOMAIN (public - Let's Encrypt)

{
    email $EMAIL
}

$DOMAIN {
EOF
fi

# Append common configuration
cat >> /etc/caddy/Caddyfile << EOF
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

# For local domains, copy the root CA to a readable location
if [[ "$IS_LOCAL" == "true" ]]; then
    log_info "Waiting for Caddy to generate certificates..."
    sleep 3

    # Make request to trigger certificate generation
    curl -sk "https://$DOMAIN/health" >/dev/null 2>&1 || true
    sleep 2

    CA_CERT_PATH="/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt"
    PUBLIC_CA_PATH="/etc/caddy/root-ca.crt"

    if [[ -f "$CA_CERT_PATH" ]]; then
        log_info "Copying root CA certificate to $PUBLIC_CA_PATH"
        cp "$CA_CERT_PATH" "$PUBLIC_CA_PATH"
        chmod 644 "$PUBLIC_CA_PATH"
        log_info "Root CA certificate is now available for download"
    else
        log_warn "Root CA not found at $CA_CERT_PATH"
        log_warn "You may need to manually copy it after first HTTPS request"
    fi
fi

log_info "Caddy installation complete!"
echo ""
echo "Configuration:"
echo "  Domain: $DOMAIN"
echo "  Caddyfile: /etc/caddy/Caddyfile"
echo "  Logs: /var/log/caddy/"
echo ""

if [[ "$IS_LOCAL" == "true" ]]; then
    echo "Certificate: Self-signed (Caddy internal CA)"
    echo ""
    echo "Setup:"
    echo "  1. Add to client hosts file: <server-ip> $DOMAIN"
    echo "  2. Accept the self-signed certificate warning in browser"
    echo "  3. Ports 80 and 443 must be open in firewall"
else
    echo "Certificate: Let's Encrypt (email: $EMAIL)"
    echo ""
    echo "Setup:"
    echo "  1. DNS A record for $DOMAIN must point to this server"
    echo "  2. Ports 80 and 443 must be open in firewall"
fi

echo ""
echo "Commands:"
echo "  sudo systemctl status caddy"
echo "  sudo systemctl reload caddy"
echo "  sudo caddy validate --config /etc/caddy/Caddyfile"
echo "  sudo journalctl -u caddy -f"
