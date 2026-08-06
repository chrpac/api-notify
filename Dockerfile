FROM node:12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
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
    libgcc1 \
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
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r -g 999 pptruser \
    && useradd -r -u 999 -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser \
    && chown -R pptruser:pptruser /home/pptruser

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY index.js ./

RUN chown -R pptruser:pptruser /app

USER pptruser

ENV NODE_ENV=production \
    PORT=3333 \
    TZ=Asia/Bangkok \
    NODE_OPTIONS=--max_old_space_size=2048

EXPOSE 3333

CMD ["node", "index.js"]
