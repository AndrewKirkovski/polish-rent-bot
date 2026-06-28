#!/usr/bin/env bash
# Server setup script for Polish Rent Bot
# Run on the Ubuntu deployment box to bootstrap the project directory.

set -euo pipefail

APP_DIR="/opt/polish-rent-bot"
COMPOSE_URL="https://raw.githubusercontent.com/andrewkirkovski/polish-rent-bot/main/docker-compose.yml"

echo "==> Creating application directory at ${APP_DIR}"
sudo mkdir -p "${APP_DIR}"
sudo chown "$(whoami):$(whoami)" "${APP_DIR}"
cd "${APP_DIR}"

echo "==> Logging in to GHCR (you will need a GitHub PAT with read:packages scope)"
echo "    Generate one at: https://github.com/settings/tokens/new?scopes=read:packages"
read -rp "GitHub username: " GH_USER
read -rsp "GitHub PAT: " GH_PAT
echo
echo "${GH_PAT}" | docker login ghcr.io -u "${GH_USER}" --password-stdin

echo "==> Downloading docker-compose.yml"
curl -fsSL -o docker-compose.yml "${COMPOSE_URL}"

echo "==> Creating .env template"
if [ ! -f .env ]; then
  cat > .env << 'ENVEOF'
# Telegram Bot API token from @BotFather
TELEGRAM_TOKEN=

# Password to authorize access to the bot
BOT_PASSWORD=

# SQLite database path (mapped via Docker volume)
DB_PATH=/app/data/db.sqlite

# Optional: hard-reject metro/tram/bus beyond walking limit (default off)
# STRICT_WALKING_AMENITIES=false

# Cross-platform dedup OLX+Otodom (default on)
# LISTING_DEDUP_ENABLED=true
ENVEOF
  echo "    Created .env template. Fill in your values before starting."
else
  echo "    .env already exists, skipping."
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit .env with your Telegram bot token and chat IDs:"
echo "     nano ${APP_DIR}/.env"
echo ""
echo "  2. Start the bot:"
echo "     cd ${APP_DIR} && docker compose up -d"
echo ""
echo "  3. Check logs:"
echo "     docker compose logs -f bot"
echo ""
echo "Watchtower will auto-update the container when new images are pushed to GHCR."
