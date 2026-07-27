# Polish Rent & Items Bot

Personal Telegram bot for monitoring Polish rental listings and searching for used items across Polish platforms.

> **This project is for personal use only.** It is not a scraping service, data aggregator, or commercial tool. It uses official APIs where available and respects platform terms of service. Do not use this software for mass data collection, republishing listings on competing platforms, or any commercial purpose.

## What it does

- **Rental monitoring** — watches OLX and Otodom for new apartment listings matching your criteria (city, price range, rooms, etc.) and sends Telegram notifications
- **Used items search** — searches OLX and Allegro for items you're looking for (electronics, furniture, etc.)
- **AI analysis** (planned) — extracts deposit (kaucja) from descriptions, estimates utility costs, scores nearby amenities via Google Maps

## Platforms

| Platform | Method | Auth needed | Use case |
|----------|--------|-------------|----------|
| OLX.pl | REST API (`/api/v1/offers/`) | None | Rentals + items |
| Otodom.pl | Playwright + `__NEXT_DATA__` | None (phone needs login) | Rentals |
| Allegro | Official REST API (OAuth 2.0) | Device Flow | Items |

## Setup

### Prerequisites

- Node.js 20+
- An Allegro account + registered app at [apps.developer.allegro.pl](https://apps.developer.allegro.pl)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### Install

```bash
git clone <this-repo>
cd polish-rent-bot
npm install
npx playwright install chromium
```

### Configure

Copy and fill in your credentials:

```bash
cp .env.example .env
# Edit .env with your keys
```

Required environment variables:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_TOKEN` | Telegram bot token from @BotFather |
| `BOT_PASSWORD` | Password users must send to get whitelisted |
| `ALLEGRO_CLIENT_ID` | From Allegro Developer Portal |
| `ALLEGRO_CLIENT_SECRET` | From Allegro Developer Portal |
| `ANTHROPIC_API_KEY` | For AI-powered listing analysis |
| `GOOGLE_MAPS_API_KEY` | For amenity/transport scoring |

### Allegro authorization

First run will prompt you to authorize via Device Flow:

```bash
npx tsx src/experiments/test-allegro.ts
```

Open the displayed URL in your browser, enter the code. Token is saved and auto-refreshes.

## Deployment (Revo server)

Runs on Docker at `/opt/polish-rent-bot` on the Revo home server.

**Automatic:** push to `main` → GitHub Actions builds `ghcr.io/andrewkirkovski/polish-rent-bot:latest` → Watchtower on Revo recreates the container.

**Manual pull on Revo:**

```bash
cd /opt/polish-rent-bot
docker compose pull bot
docker compose up -d bot
docker compose logs -f bot --tail 100
```

Dashboard: `http://<revo-lan-ip>:8090` (host 8090 → container 8080).

Optional `.env` flags:

All authorized bot users share one conversation and receive every message and monitor alert.

| Variable | Default | Description |
|----------|---------|-------------|
| `STRICT_WALKING_AMENITIES` | `false` | Global default for hard metro/tram/bus walking filter |
| `LISTING_DEDUP_ENABLED` | `true` | Cross-platform duplicate merge (OLX + Otodom) |
| `DASHBOARD_ADMIN_TOKEN` | `BOT_PASSWORD` | Dedicated token for destructive dashboard operations |

### Operations API

The dashboard exposes JSON APIs on port 8090. Its read routes are intended for a trusted LAN and are not authenticated; destructive operations require an admin token.

`GET /api/stats?range=24h` returns aggregate operational statistics. Supported ranges are `24h`, `7d`, `30d`, and `all`. The response includes:

- AI API calls, local cache hits, errors, token categories, total tokens, and estimated USD cost
- average cost per API call, local cache hit rate, prompt-cache read share, and API latency (average, p50, p95, maximum)
- usage grouped by feature and model
- models with recorded tokens but no price, so zero-cost gaps are visible
- monitor runs, failures, found/unseen/delivered listings, active monitors, and current cache sizes

Costs are estimates calculated from the static per-model price table in `src/ai/pricing.ts`; they are not provider invoices. The response identifies unpriced models separately.

`POST /api/cache/reset` clears derived caches. It requires `DASHBOARD_ADMIN_TOKEN`, or `BOT_PASSWORD` when a dedicated token is not configured, plus an exact confirmation string:

```bash
curl -X POST "http://<revo-lan-ip>:8090/api/cache/reset" \
  -H "Authorization: Bearer $DASHBOARD_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"confirm":"RESET_CACHES","scope":"all"}'
```

Scopes:

| Scope | Cleared data |
|-------|--------------|
| `all` | Parsed listings, AI rejection decisions, and Google Maps responses |
| `location` | Parsed listings and Google Maps responses |
| `maps` | Google Maps responses only |
| `ai` | Parsed listings and AI rejection decisions |

Every scope preserves seen listings, notification fingerprints, cached result cards, monitor history, conversations, and AI usage telemetry. A reset therefore refreshes derived analysis without replaying historical alerts or erasing cost statistics.

## Deployment (local)

Runs on Docker with Watchtower auto-updates:

```bash
# On the server
docker compose up -d
```

Push to `main` triggers GitHub Actions build, Watchtower pulls the new image automatically.

## Project structure

```
src/
├── crawlers/
│   ├── olx.ts          # OLX rental crawler (HTTP)
│   ├── olx-items.ts    # OLX items search (HTTP)
│   ├── otodom.ts        # Otodom rental crawler (Playwright)
│   └── allegro.ts       # Allegro items search (REST API)
├── types.ts             # Shared data types
└── experiments/         # Test scripts
```

## Legal disclaimer

This software is provided for **personal, non-commercial use only**. By using this software you agree to:

- Use it only to find listings for your own purchasing/renting needs
- Not republish, resell, or redistribute data obtained through this tool
- Not use it for mass data collection or scraping
- Comply with each platform's terms of service
- Not use it to contact sellers in bulk or for spam
- Accept full responsibility for how you use the tool

The authors are not responsible for any misuse of this software or any consequences arising from violating platform terms of service.

This project uses official APIs (Allegro REST API, OLX public API) and browser automation (Otodom) at minimal, human-like request rates for personal use. It does not bypass authentication, CAPTCHAs, or rate limits.
