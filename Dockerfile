FROM node:22-bookworm-slim

# OS-level shared libraries Chromium needs. Puppeteer still ships and manages its
# own Chrome build, so no chromium package is installed here.
# dumb-init reaps the Chrome child processes that would otherwise pile up as zombies.
# fonts-thai-tlwg is required, not optional: without a Thai font every Thai glyph
# renders as a tofu box, since the pages this service captures are largely Thai.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    dumb-init \
    fonts-liberation \
    fonts-thai-tlwg \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxkbcommon0 \
    libxss1 \
    libxtst6 \
    lsb-release \
    unzip \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# uid/gid 1001, not the old 999: on bookworm the apt step above already hands 999
# to a Debian system group (dbus/dconf), which allocates downward from 999.
RUN groupadd -g 1001 pptruser \
    && useradd -u 1001 -g pptruser -G audio,video -m pptruser \
    && mkdir -p /home/pptruser \
    && chown -R pptruser:pptruser /home/pptruser

WORKDIR /app

# puppeteer >= 19 downloads Chrome into a cache dir instead of node_modules;
# pin it inside /app so it survives the chown below and is readable by pptruser.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./

RUN chown -R pptruser:pptruser /app

USER pptruser

ENV NODE_ENV=production \
    PORT=3333 \
    TZ=Asia/Bangkok \
    MAX_CONCURRENCY=2 \
    NODE_OPTIONS=--max_old_space_size=2048

EXPOSE 3333

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
