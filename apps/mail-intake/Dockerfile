# LacityCars mail-intake service — build from the repo root:
#   docker build -f apps/mail-intake/Dockerfile .
FROM node:22-slim

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @lacity/shared build \
  && pnpm --filter @lacity/mail-intake build

ENV NODE_ENV=production
CMD ["node", "apps/mail-intake/dist/index.js"]
