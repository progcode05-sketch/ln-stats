# LinkedIn Stats SaaS — Node 24 + system Chromium (no runtime download).
FROM node:24-bookworm-slim

# Install Chromium from the Debian package manager.
# apt pulls in every runtime library Chromium needs, so no need to list them manually.
# This is far more reliable than downloading Chrome-for-Testing at build time.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Skip Puppeteer's own Chrome download — we use the system binary instead.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Render injects PORT; this is just a local default.
ENV PORT=10000
EXPOSE 10000

CMD ["npm", "run", "start"]
