#!/usr/bin/env bash
# ==============================================================================
# Daymate One-Click Remote Server Deployment Script
# ==============================================================================
set -e

REMOTE_HOST="$1"
REMOTE_DIR="${2:-/opt/daymate}"

if [ -z "$REMOTE_HOST" ]; then
  echo "Usage: ./deploy.sh <user@server_ip> [remote_dir]"
  echo "Example: ./deploy.sh root@1.2.3.4"
  exit 1
fi

echo "==> 1. Building server bundle..."
cd "$(dirname "$0")/.."
pnpm server:build
cp out/server/index.js deploy/server.js

echo "==> 2. Preparing remote directory on $REMOTE_HOST..."
ssh "$REMOTE_HOST" "mkdir -p $REMOTE_DIR/data"

echo "==> 3. Uploading deployment files..."
rsync -avz deploy/package.json deploy/server.js deploy/Dockerfile deploy/docker-compose.yml "$REMOTE_HOST:$REMOTE_DIR/"

echo "==> 4. Syncing local database and settings to server (preserving history)..."
LOCAL_USER_DATA="$HOME/Library/Application Support/daymate"
if [ -f "$LOCAL_USER_DATA/daymate.db" ]; then
  echo "   -> Copying daymate.db..."
  rsync -avz "$LOCAL_USER_DATA/daymate.db" "$REMOTE_HOST:$REMOTE_DIR/data/"
fi
if [ -f "$LOCAL_USER_DATA/settings.json" ]; then
  echo "   -> Copying settings.json..."
  rsync -avz "$LOCAL_USER_DATA/settings.json" "$REMOTE_HOST:$REMOTE_DIR/data/"
fi

echo "==> 5. Installing dependencies on remote server..."
ssh "$REMOTE_HOST" "cd $REMOTE_DIR && npm install --omit=dev"

echo "==> 6. Starting Daymate Server via Systemd or PM2..."
ssh "$REMOTE_HOST" "bash -c '
  if command -v pm2 &> /dev/null; then
    cd $REMOTE_DIR && pm2 restart daymate || pm2 start server.js --name daymate
  elif [ -f /etc/systemd/system ]; then
    cp $REMOTE_DIR/daymate.service /etc/systemd/system/daymate.service 2>/dev/null || true
    systemctl daemon-reload 2>/dev/null || true
    systemctl restart daymate 2>/dev/null || true
  else
    nohup node $REMOTE_DIR/server.js > $REMOTE_DIR/server.log 2>&1 &
  fi
'"

echo "==> Deployment completed successfully!"
echo "    Check logs on server: ssh $REMOTE_HOST 'pm2 logs daymate' (or 'journalctl -u daymate -f')"
