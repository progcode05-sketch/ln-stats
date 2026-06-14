# LinkedIn Stats SaaS — Node 24 (built-in node:sqlite) + Chromium for Puppeteer.
FROM node:24-bookworm-slim

# Chromium runtime libraries required by Puppeteer's bundled browser.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 \
      libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc-s1 libglib2.0-0 \
      libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
      libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
      libxrandr2 wget xdg-utils \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Keep Puppeteer's Chromium inside the image so it is present at runtime.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

WORKDIR /app

COPY package*.json ./
RUN npm ci
# Explicitly download Chrome for Testing into the cache dir.
# This runs after npm ci so it always succeeds even if the postinstall was skipped.
RUN npx puppeteer browsers install chrome

COPY . .

# Render injects PORT; this is just a local default.
ENV PORT=10000
EXPOSE 10000

CMD ["npm", "run", "start"]
