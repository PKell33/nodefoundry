#!/bin/bash
set -euo pipefail

# OwnPrem Caddy Installation Script
# This script downloads and extracts binaries only.
# Privileged operations are handled by the agent via the privileged helper.

APP_DIR="${APP_DIR:-/opt/ownprem/apps/ownprem-caddy}"

# Configuration from environment (for template generation)
CA_URL="${CA_URL:-https://ca.ownprem.local:8443/acme/acme/directory}"
CA_ROOT_CERT="${CA_ROOT_CERT:-/etc/step-ca/root_ca.crt}"
ADMIN_API_LISTEN="${ADMIN_API_LISTEN:-localhost:2019}"

# Caddy version
CADDY_VERSION="2.8.4"

# Detect architecture
ARCH=$(uname -m)
case $ARCH in
    x86_64) ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
    armv7l) ARCH="armv7" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "Installing OwnPrem Caddy binaries..."

# Create app directories (unprivileged - agent owns APP_DIR)
mkdir -p "$APP_DIR/bin"
mkdir -p "$APP_DIR/templates"

# Cleanup function for temporary files
cleanup_temp() {
    [[ -n "${TEMP_DIR:-}" && -d "${TEMP_DIR}" ]] && rm -rf "${TEMP_DIR}"
}
trap cleanup_temp EXIT

# Download and verify Caddy if not present
if [[ ! -f "$APP_DIR/bin/caddy" ]]; then
    echo "Downloading Caddy v${CADDY_VERSION}..."
    TEMP_DIR=$(mktemp -d)

    CADDY_URL="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${ARCH}.tar.gz"
    CADDY_CHECKSUMS_URL="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_checksums.txt"

    curl -fsSL "${CADDY_URL}" -o "${TEMP_DIR}/caddy.tar.gz"
    curl -fsSL "${CADDY_CHECKSUMS_URL}" -o "${TEMP_DIR}/checksums.txt"

    # Verify checksum (Caddy uses SHA512)
    cd "${TEMP_DIR}"
    EXPECTED_HASH=$(grep "caddy_${CADDY_VERSION}_linux_${ARCH}.tar.gz" checksums.txt | awk '{print $1}')
    if [[ -z "${EXPECTED_HASH}" ]]; then
        echo "ERROR: Could not find checksum for caddy_${CADDY_VERSION}_linux_${ARCH}.tar.gz"
        exit 1
    fi
    ACTUAL_HASH=$(sha512sum caddy.tar.gz | awk '{print $1}')
    if [[ "${EXPECTED_HASH}" != "${ACTUAL_HASH}" ]]; then
        echo "ERROR: Checksum verification failed for Caddy!"
        echo "Expected: ${EXPECTED_HASH}"
        echo "Actual:   ${ACTUAL_HASH}"
        exit 1
    fi
    echo "Checksum verified for Caddy"

    tar -xzf caddy.tar.gz
    mv caddy "${APP_DIR}/bin/"
    chmod +x "${APP_DIR}/bin/caddy"
    echo "Caddy installed to ${APP_DIR}/bin/"

    rm -rf "${TEMP_DIR}"
    TEMP_DIR=""
fi

# Create Caddyfile template (agent will copy to /etc/caddy/)
cat > "$APP_DIR/templates/Caddyfile" << EOF
{
    # Use internal CA for certificates
    acme_ca ${CA_URL}
    acme_ca_root ${CA_ROOT_CERT}

    # Admin API
    admin ${ADMIN_API_LISTEN}

    # Logging
    log {
        output file /var/log/caddy/access.log
        format json
    }
}

# Default site - will be configured by orchestrator
:443 {
    respond "OwnPrem Caddy is running" 200
}
EOF

# Create reload-proxy script (triggers orchestrator to push correct TLS config)
cat > "$APP_DIR/bin/reload-proxy.sh" << 'SCRIPT'
#!/bin/bash
# Wait for orchestrator and trigger proxy reload
# This ensures Caddy gets the correct TLS config from step-ca
for i in {1..10}; do
    if curl -sf -X POST http://localhost:3001/api/proxy-routes/reload >/dev/null 2>&1; then
        exit 0
    fi
    sleep 1
done
# Don't fail the service if reload doesn't work - Caddy is still functional
exit 0
SCRIPT
chmod +x "$APP_DIR/bin/reload-proxy.sh"

# Create systemd service template (agent will copy to /etc/systemd/system/)
cat > "$APP_DIR/templates/ownprem-caddy.service" << 'EOF'
[Unit]
Description=OwnPrem Caddy HTTP/2 web server
Documentation=https://caddyserver.com/docs/
After=network-online.target ownprem-orchestrator.service
Wants=network-online.target

[Service]
Type=notify
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
Environment=XDG_DATA_HOME=${DATA_DIR}
Environment=XDG_CONFIG_HOME=${CONFIG_DIR}
ExecStart=${APP_DIR}/bin/caddy run --config ${CONFIG_DIR}/Caddyfile --adapter caddyfile
ExecStartPost=${APP_DIR}/bin/reload-proxy.sh
ExecReload=${APP_DIR}/bin/caddy reload --config ${CONFIG_DIR}/Caddyfile --adapter caddyfile
TimeoutStopSec=5s
LimitNOFILE=1048576
LimitNPROC=512
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

echo ""
echo "=========================================="
echo "OwnPrem Caddy Binaries Installed"
echo "=========================================="
echo ""
echo "Binary: $APP_DIR/bin/caddy"
echo ""
echo "The agent will now configure Caddy with privileged operations."
echo ""
