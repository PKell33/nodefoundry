#!/bin/bash
set -e

APP_DIR="${APP_DIR:-/opt/nodefoundry/apps/mock-app}"
MESSAGE="${MESSAGE:-Hello from Mock App}"

echo "Installing Mock App..."

# Create app directory
mkdir -p "$APP_DIR"

# Create the Node.js server
cat > "$APP_DIR/server.js" << 'EOF'
const http = require('http');
const msg = process.env.MESSAGE || 'Mock App Running';
const serverId = process.env.SERVER_ID || 'unknown';

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Mock App</title>
      <style>
        body { font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        .info { background: #f5f5f5; padding: 15px; border-radius: 5px; }
        .status { color: #0a0; font-weight: bold; }
      </style>
    </head>
    <body>
      <h1>${msg}</h1>
      <div class="info">
        <p class="status">Mock app is running successfully!</p>
        <p>Server: ${serverId}</p>
        <p>Time: ${new Date().toISOString()}</p>
      </div>
    </body>
    </html>
  `);
});

server.listen(9999, '0.0.0.0', () => {
  console.log('Mock app listening on port 9999');
});
EOF

# Create systemd service
cat > /etc/systemd/system/mock-app.service << EOF
[Unit]
Description=Mock App
After=network.target

[Service]
Type=simple
Environment=MESSAGE=${MESSAGE}
Environment=SERVER_ID=${SERVER_ID:-foundry}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mock-app

echo "Mock App installed successfully!"
