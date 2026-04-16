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

## Deployment

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
