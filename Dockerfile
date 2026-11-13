# syntax=docker/dockerfile:1

# ── Dependencies (needs build tools for better-sqlite3) ──
FROM node:22-bookworm-slim AS deps
ENV PUPPETEER_SKIP_DOWNLOAD=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Runtime ──
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    CHROMIUM_PATH=/usr/bin/chromium \
    DB_PATH=/data/kamila.db \
    WHATSAPP_AUTH_DIR=/data/wwebjs_auth
# Chromium runs WhatsApp Web; the fonts render emoji and non-Latin names.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-color-emoji fonts-noto-core ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
