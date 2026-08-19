# LacityCars dashboard (Next.js) — build from the repo root:
#   docker build -f apps/web/Dockerfile --build-arg API_URL=https://api.internal .
FROM node:22-slim

RUN corepack enable
WORKDIR /app

# API_URL is baked into the /api/* rewrite at build time — set it to the
# internal URL of the API service before building.
ARG API_URL=http://localhost:4000
ENV API_URL=$API_URL

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @lacity/shared build \
  && pnpm --filter @lacity/web build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@lacity/web", "start"]
