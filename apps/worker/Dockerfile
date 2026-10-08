FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/infrastructure/package.json packages/infrastructure/package.json
RUN --mount=type=secret,id=npm-ca \
    if [ -f /run/secrets/npm-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm-ca; fi; \
    npm ci --no-audit --no-fund --fetch-retries=0 --fetch-timeout=30000
COPY apps/worker apps/worker
COPY packages packages
COPY netlify netlify
COPY tools/dev/build.mjs tools/dev/build.mjs
RUN npm run build:server && npm prune --omit=dev --no-audit --no-fund
FROM node:24.19.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/dist/worker.mjs dist/worker.mjs
USER node
CMD ["node", "dist/worker.mjs"]
