# Standalone @alter-dsh/space server image.
#
# Build stage compiles the shared Host runtime + the HTTP entry with the same
# sources and TypeScript configuration the plugin uses. Runtime stage carries
# only Node, the compiled `lib/` and package metadata, so the image has no
# build tooling or DSH dependencies.

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.host.json ./
COPY host ./host
COPY server ./server
COPY vendor/service/src ./vendor/service/src
COPY vendor/protocol/src ./vendor/protocol/src
RUN pnpm build:host

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    SPACE_DATA_DIR=/data \
    SPACE_HOST=0.0.0.0 \
    SPACE_PORT=8787
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/lib ./lib
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SPACE_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "lib/server/index.js"]
