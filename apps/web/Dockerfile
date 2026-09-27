# syntax=docker/dockerfile:1.7
# Build from the repo root: docker build -f apps/web/Dockerfile -t kora-web .
FROM node:22.20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@kora/web...

FROM node:22.20-bookworm-slim AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
# IRTC R1-05: stamps the TCP peer address on each request so the /api proxy attributes clients correctly.
COPY --from=build --chown=node:node /repo/apps/web/peer-address.cjs ./apps/web/peer-address.cjs
USER node
EXPOSE 3000
CMD ["node", "--require", "./apps/web/peer-address.cjs", "apps/web/server.js"]
