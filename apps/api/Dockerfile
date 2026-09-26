# syntax=docker/dockerfile:1.7
# Build from the repo root: docker build -f apps/api/Dockerfile -t kora-api .
FROM node:22.20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@kora/api...
RUN pnpm --filter=@kora/api deploy --prod --legacy /out

FROM node:22.20-bookworm-slim AS run
ENV NODE_ENV=production KORA_ENV=production API_HOST=0.0.0.0 API_PORT=4000 KORA_SKIP_ENV_FILE=1
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
