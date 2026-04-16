# ---- Builder stage ----
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install native build tools for better-sqlite3
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Install dependencies (separate layer for caching)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# ---- Runtime stage ----
FROM node:20-bookworm-slim

WORKDIR /app

# Playwright browser install path
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright

# Install Playwright Chromium and its system dependencies (fonts, libs)
# This must happen before copying node_modules so npx can find playwright
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npx playwright install --with-deps chromium

# Copy source and config
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/src ./src

# Persistent data directory for SQLite
ENV DB_PATH=/app/data/db.sqlite
RUN mkdir -p /app/data

# Run as non-root
RUN groupadd --gid 1001 botuser && \
    useradd --uid 1001 --gid 1001 --create-home botuser && \
    chown -R botuser:botuser /app
USER botuser

CMD ["npx", "tsx", "src/main.ts"]
