# gws-mcp on Node: the same Worker app, one SQLite file, no other service.
#   docker build -t gws-mcp .
# The runtime image holds only the bundle (server.js, sandbox-worker.js, the QuickJS wasm). It needs no node_modules.
# No secret is baked in: pass them with GWS_SECRETS_FILE (see deploy/docker-compose.example.yml).

FROM node:22.23.5-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:node

FROM node:22.23.5-bookworm-slim
# Fixed ids, so a bind-mounted data folder can be owned to match: chown 10001:10001 <folder>.
RUN groupadd --gid 10001 gws \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin gws \
 && mkdir /data && chown 10001:10001 /data && chmod 700 /data
WORKDIR /app
COPY --from=build /src/dist/node-host/ /app/

# Listen on every interface of the container; only the reverse proxy reaches it. The database lives on the volume.
ENV NODE_ENV=production \
    GWS_HOST=0.0.0.0 \
    GWS_PORT=8787 \
    GWS_DB_FILE=/data/gws-mcp.db
VOLUME /data
USER 10001:10001
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.GWS_PORT||8787)+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
# `docker exec <container> node /app/server.js access|backup|restore ...` runs the operator commands.
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/app/server.js"]
