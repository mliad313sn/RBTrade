# syntax=docker/dockerfile:1.7
# Build from the repo root: docker build -f services/bot-runner/Dockerfile -t kora-bot-runner .
FROM node:22.20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@kora/bot-runner...
RUN pnpm --filter=@kora/bot-runner deploy --prod --legacy /out

FROM node:22.20-bookworm-slim AS run
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
CMD ["node", "dist/main.js"]
