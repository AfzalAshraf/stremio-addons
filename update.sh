#!/usr/bin/env bash
# update.sh — one-command updater for Fast Combo on any platform
# Usage: bash update.sh
set -euo pipefail

echo "⚡ Fast Combo Updater"
echo "====================="
echo ""

# Detect platform
if [ -f "/etc/fastcombo/fastcombo.env" ] || systemctl is-active --quiet fastcombo 2>/dev/null; then
  PLATFORM="vps"
elif command -v docker &> /dev/null && docker ps --format '{{.Names}}' | grep -q fastcombo; then
  PLATFORM="docker"
elif [ -f "server.js" ] && [ -f "package.json" ]; then
  PLATFORM="node"
else
  echo "❌ Could not detect your installation."
  echo "   Are you running this from the stremio-addons folder?"
  exit 1
fi

echo " Detected platform: $PLATFORM"
echo ""

BACKUP_DIR="/tmp/fastcombo-backup-$(date +%Y%m%d-%H%M%S)"

update_vps() {
  echo " Pulling latest code..."
  bash /opt/fastcombo/install.sh --update
  echo ""
  echo "✅ VPS updated! Service restarted automatically."
  echo "   Check: sudo journalctl -u fastcombo -f"
}

update_docker() {
  echo "🔄 Pulling latest code..."
  cd "$(dirname "$0")"
  git pull origin main
  
  echo " Building new image..."
  docker build -t fast-combo .
  
  echo "🔄 Restarting container..."
  docker rm -f fastcombo
  docker run -d --name fastcombo --restart unless-stopped \
    -p 7000:7000 \
    -v fastcombo-data:/app/data \
    fast-combo
  
  echo ""
  echo "✅ Docker updated!"
  echo "   Check: docker logs -f fastcombo"
}

update_node() {
  echo " Pulling latest code..."
  cd "$(dirname "$0")"
  git pull origin main
  
  echo "📦 Installing dependencies..."
  npm install
  
  echo "⚡ Restarting server..."
  if pgrep -f "node server.js" > /dev/null; then
    pkill -f "node server.js"
    sleep 2
    node server.js &
  else
    echo "   Server wasn't running, starting it now..."
    node server.js &
  fi
  
  echo ""
  echo "✅ Node.js updated!"
  echo "   Check: node server.js"
}

# Run the update
case "$PLATFORM" in
  vps)    update_vps ;;
  docker) update_docker ;;
  node)   update_node ;;
esac

echo ""
echo "🎉 Update complete! Your addons and settings are intact."
