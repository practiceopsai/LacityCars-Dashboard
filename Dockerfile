FROM node:22-slim

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

ARG API_URL=http://localhost:4000
ENV API_URL=$API_URL

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

ENV NODE_ENV=production
EXPOSE 3000 4000
CMD ["node", "scripts/start-service.mjs"]
