FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS base
WORKDIR /app
FROM base AS packages
RUN npm install --global pnpm@12.4.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
FROM packages AS dependencies
RUN --mount=type=cache,target=/pnpm-store pnpm install --store-dir /pnpm-store --frozen-lockfile
FROM packages AS production-dependencies
RUN --mount=type=cache,target=/pnpm-store pnpm install --store-dir /pnpm-store --prod --frozen-lockfile
FROM dependencies AS contract-client
COPY clients/ clients/
COPY docs/openapi.json docs/openapi.json
COPY test/integration/contract.mjs test/integration/contract.mjs
FROM dependencies AS compile
COPY tsconfig*.json nest-cli.json ./
COPY src/ src/
RUN pnpm run build
FROM base AS release
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=compile /app/dist ./dist
COPY package.json ./
ARG REVISION
LABEL org.opencontainers.image.revision=$REVISION
USER node
CMD ["node","dist/main.js"]
