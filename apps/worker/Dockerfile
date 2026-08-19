# LacityCars worker service — build from the repo root:
#   docker build -f apps/worker/Dockerfile .
FROM node:22-slim

# Prisma engines need OpenSSL.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @lacity/shared build \
  && pnpm --filter @lacity/freight build \
  && pnpm --filter @lacity/database build \
  && pnpm --filter @lacity/worker build

ENV NODE_ENV=production
CMD ["node", "apps/worker/dist/index.js"]
