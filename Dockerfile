# ---- Builder stage ----
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Native build tools for better-sqlite3 + corepack for reproducible pnpm.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/* && \
    corepack enable

# ---- Install bot deps (cached on package.json + lockfile) ----
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- Build dashboard SPA BEFORE copying bot src so src/ edits don't bust this layer ----
COPY dashboard/package.json dashboard/pnpm-lock.yaml dashboard/
RUN pnpm --dir dashboard install --frozen-lockfile
COPY dashboard/ ./dashboard/
RUN pnpm --dir dashboard build

# ---- Copy bot source last (changes here only invalidate the runtime image, not dashboard) ----
COPY tsconfig.json ./
COPY src/ ./src/

# ---- Runtime stage ----
FROM node:20-bookworm-slim

WORKDIR /app

# Playwright browser install path
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright

# Bot node_modules (built in builder stage with pnpm)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
RUN npx playwright install --with-deps chromium

# Bot source + config
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/src ./src

# Built dashboard SPA (only dist — dashboard node_modules NOT carried)
COPY --from=builder /app/dashboard/dist ./dashboard/dist

# Persistent SQLite directory
ENV DB_PATH=/app/data/db.sqlite
RUN mkdir -p /app/data

# Non-root runtime user
RUN groupadd --gid 1001 botuser && \
    useradd --uid 1001 --gid 1001 --create-home botuser && \
    chown -R botuser:botuser /app
USER botuser

EXPOSE 8080

CMD ["npx", "tsx", "src/main.ts"]
