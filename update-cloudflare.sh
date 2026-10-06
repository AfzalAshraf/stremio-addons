#!/usr/bin/env bash
# update-cloudflare.sh — update your Cloudflare Worker with the latest Fast Combo
# Usage: bash update-cloudflare.sh <worker-name>
# Prerequisites: npm install -g wrangler && wrangler login

set -euo pipefail

WORKER_NAME="${1:-fast-combo}"

echo "⚡ Fast Combo Cloudflare Updater"
echo "================================"
echo "   Worker: $WORKER_NAME"
echo ""

# Download latest fastcombo.js
echo " Downloading latest fastcombo.js from GitHub..."
curl -fsSL https://raw.githubusercontent.com/AfzalAshraf/stremio-addons/main/fastcombo.js -o fastcombo.js

echo " Deploying to Cloudflare..."
wrangler deploy --name "$WORKER_NAME"

echo ""
echo "✅ Cloudflare Worker updated!"
echo "   Your variables and KV storage are untouched."
