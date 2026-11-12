#!/usr/bin/env bash
# E2E against the Docker image of the Node host, with the fake Google run locally. One command, cleans up after itself:
#   bash scripts/e2e/docker.sh            (build the image, run, remove everything it created)
#   E2E_DOCKER_KEEP_IMAGE=1 bash ...      (keep the image tag for a quick rerun)
#
# Needs a running Docker daemon (colima: `colima start`), `openssl`, and free ports 8787 and 8788 on this machine.
# Everything it starts or creates is named gws-mcp-e2e-*: image, container, two volumes. Other containers are never
# touched. The values it generates (token key, fake Google secrets) are throwaway, live in a mode-700 folder and are
# deleted on exit; no real secret and no .env file is read.
#
# What it does, in order:
#   1. builds the image; runs it as the compose file does (read-only root, tmpfs /tmp, all capabilities dropped,
#      no-new-privileges, uid 10001, /data volume) with its one secret in a file (GWS_SECRETS_FILE, owner 10001,
#      mode 0400, on a volume mounted at /run/secrets);
#   2. runs the fake Google as `wrangler dev` on port 8788 (its own throwaway secrets and state folder);
#   3. seeds the access list with the container's own `access add`;
#   4. runs scripts/e2e/run.ts (the same checks as the deployed run) against it, and during the run checks /healthz and
#      takes a backup with `docker exec`, then opens the backup;
#   5. restarts the container and checks that the sign-in, the AI app's token and the stored Google token survive;
#   6. `docker stop`: must exit 0 within the grace period and log a clean stop.
#
# Fake Google from the container: the browser-facing URL is http://localhost:8788 (FAKE_GOOGLE_PUBLIC_URL), and the
# fake's default callback http://localhost:8787/google/callback is the published app port. The server's own calls use
# GWS_FAKE_GOOGLE_URL=http://host.docker.internal:8788, which colima resolves to the host (E2E_DOCKER_FAKE_HOST
# overrides the name for another Docker setup).
set -u
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE=gws-mcp-e2e-image
APP=gws-mcp-e2e-app
DATA_VOLUME=gws-mcp-e2e-data
SECRETS_VOLUME=gws-mcp-e2e-secrets
APP_PORT=8787
FAKE_PORT=8788
FAKE_HOST_FROM_CONTAINER="${E2E_DOCKER_FAKE_HOST:-host.docker.internal}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/gws-mcp-e2e-docker.XXXXXX")"
chmod 700 "$WORK"
FAKE_PID=""
STATUS=0

say() { printf '==> %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; STATUS=1; }

remove_containers_and_volumes() {
  docker rm -f "$APP" >/dev/null 2>&1
  docker volume rm "$DATA_VOLUME" "$SECRETS_VOLUME" >/dev/null 2>&1
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$rc" -ne 0 ] || [ "$STATUS" -ne 0 ]; then
    say "container log (last 25 lines)"
    docker logs --tail 25 "$APP" 2>&1 | cut -c1-300
    say "fake Google log (last 15 lines)"
    tail -15 "$WORK/fake.log" 2>/dev/null | cut -c1-300
  fi
  say "cleanup"
  if [ -n "$FAKE_PID" ] && kill -0 "$FAKE_PID" 2>/dev/null; then
    kill "$FAKE_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$FAKE_PID" 2>/dev/null || break; sleep 1; done
    kill -0 "$FAKE_PID" 2>/dev/null && kill -9 "$FAKE_PID" 2>/dev/null
  fi
  remove_containers_and_volumes
  [ "${E2E_DOCKER_KEEP_IMAGE:-}" = 1 ] || docker rmi "$IMAGE" >/dev/null 2>&1
  rm -rf "$WORK"
  if lsof -nP -iTCP:"$FAKE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "WARN port $FAKE_PORT is still held after cleanup"; fi
  exit "$([ "$rc" -ne 0 ] && echo "$rc" || echo "$STATUS")"
}
trap cleanup EXIT INT TERM

# --- preflight ---------------------------------------------------------------------------------------------------
docker info >/dev/null 2>&1 || { echo "no Docker daemon (colima: run 'colima start')"; exit 2; }
command -v openssl >/dev/null || { echo "openssl is needed to generate the throwaway keys"; exit 2; }
for port in "$APP_PORT" "$FAKE_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port is in use: stop its owner first (lsof -i :$port)"; exit 2; fi
done
remove_containers_and_volumes   # leftovers of an earlier interrupted run of this script, by exact name

# --- 1. image ---------------------------------------------------------------------------------------------------
say "build image $IMAGE"
docker build -q -t "$IMAGE" "$ROOT" >/dev/null || { echo "docker build failed"; exit 2; }

# --- throwaway secrets -------------------------------------------------------------------------------------------
umask 077
key() { openssl rand -base64 32; }
printf 'TOKEN_ENC_KEY=%s\n' "$(key)" > "$WORK/container.secrets"
{
  printf 'FAKE_ADMIN_TOKEN=%s\n' "$(key)"
  printf 'FAKE_SIGNING_KEY=%s\n' "$(key)"
  printf 'FAKE_LOGIN_SECRET=%s\n' "$(key)"
} > "$WORK/fake.vars"
cat "$WORK/fake.vars" "$WORK/container.secrets" > "$WORK/run.vars"   # what the harness reads, by path

# --- 2. fake Google (local wrangler dev) -------------------------------------------------------------------------
say "fake Google on port $FAKE_PORT"
mkdir -p "$WORK/fake"
# The tracked example config, with the worker path made absolute; the secrets file beside it is what wrangler dev reads.
sed -E "s#\"main\": \"src/worker.ts\"#\"main\": \"$ROOT/fake-google/src/worker.ts\"#; /\\\$schema/d" "$ROOT/fake-google/wrangler.example.jsonc" > "$WORK/fake/wrangler.jsonc"
cp "$WORK/fake.vars" "$WORK/fake/.dev.vars"
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false "$ROOT/node_modules/.bin/wrangler" dev --config "$WORK/fake/wrangler.jsonc" --local \
  --port "$FAKE_PORT" --persist-to "$WORK/fake-state" > "$WORK/fake.log" 2>&1 &
FAKE_PID=$!
ready=0
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$FAKE_PORT/__fake/state" 2>/dev/null)"
  [ "$code" = 401 ] && { ready=1; break; }
  kill -0 "$FAKE_PID" 2>/dev/null || break
  sleep 1
done
[ "$ready" = 1 ] || { echo "the fake Google did not come up (control route did not answer 401)"; exit 2; }
echo "fake Google up (pid $FAKE_PID, port $FAKE_PORT)"

# --- the app container --------------------------------------------------------------------------------------------
say "start $APP"
docker volume create "$DATA_VOLUME" >/dev/null && docker volume create "$SECRETS_VOLUME" >/dev/null || exit 2
# The secrets file as an orchestrator's secret mount has it: a file owned by 10001, mode 0400.
docker run --rm -i --user 0 -v "$SECRETS_VOLUME":/s --entrypoint sh "$IMAGE" \
  -c 'umask 077; cat > /s/gws_secrets && chown 10001:10001 /s/gws_secrets && chmod 400 /s/gws_secrets' < "$WORK/container.secrets" || exit 2
docker run -d --name "$APP" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -p "127.0.0.1:$APP_PORT:8787" \
  -v "$DATA_VOLUME":/data -v "$SECRETS_VOLUME":/run/secrets:ro \
  -e PUBLIC_BASE_URL="http://localhost:$APP_PORT" -e GOOGLE_UPSTREAM=fake -e GOOGLE_SCOPE_PRESET=narrow \
  -e FAKE_GOOGLE_PUBLIC_URL="http://localhost:$FAKE_PORT" -e GWS_FAKE_GOOGLE_URL="http://$FAKE_HOST_FROM_CONTAINER:$FAKE_PORT" \
  -e GWS_SECRETS_FILE=/run/secrets/gws_secrets \
  "$IMAGE" >/dev/null || exit 2
healthy=0
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$APP_PORT/healthz" 2>/dev/null)" = 200 ] && { healthy=1; break; }
  [ "$(docker inspect -f '{{.State.Running}}' "$APP" 2>/dev/null)" = true ] || break
  sleep 1
done
[ "$healthy" = 1 ] || { echo "$APP did not answer /healthz 200"; exit 2; }
echo "uid: $(docker exec "$APP" id -u); secrets file: $(docker exec "$APP" sh -c 'ls -ln /run/secrets/gws_secrets | cut -d" " -f1,3')"
write_attempt="$(docker exec "$APP" sh -c 'touch /app/x' 2>&1)"
case "$write_attempt" in *"Read-only file system"*) echo "root filesystem is read-only" ;; *) fail "root filesystem is writable" ;; esac

# --- 3. access list -----------------------------------------------------------------------------------------------
say "seed the access list with 'access add'"
docker exec "$APP" node /app/server.js access add @fake.test --note e2e 2>/dev/null || exit 2

# --- 4. the e2e run, with a healthz probe and a backup during it --------------------------------------------------
say "scripts/e2e/run.ts against $APP"
cd "$ROOT" || exit 2
npx tsx scripts/e2e/run.ts --base "http://localhost:$APP_PORT" --fake "http://localhost:$FAKE_PORT" --docker "$APP" \
  --env-file "$WORK/run.vars" > "$WORK/e2e.log" 2>&1 &
E2E_PID=$!
for _ in $(seq 1 180); do
  grep -q '^DONE-3 ' "$WORK/e2e.log" 2>/dev/null && break
  kill -0 "$E2E_PID" 2>/dev/null || break
  sleep 1
done
echo "during the run: /healthz -> $(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$APP_PORT/healthz")"
docker exec "$APP" node /app/server.js backup /data/e2e-backup.db 2>/dev/null | tail -1
verify='const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("/data/e2e-backup.db", { readOnly: true });
const ok = db.prepare("PRAGMA integrity_check").get().integrity_check; const users = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
console.log("backup opens: integrity_check=" + ok + ", users=" + users); process.exit(ok === "ok" && users > 0 ? 0 : 1)'
docker exec "$APP" node --disable-warning=ExperimentalWarning -e "$verify" 2>&1 | grep -v '^{' || fail "the backup taken during the run did not verify"
wait "$E2E_PID"; E2E_RC=$?
cat "$WORK/e2e.log"
[ "$E2E_RC" = 0 ] || fail "e2e run exited $E2E_RC"

# --- 5. restart keeps the data ------------------------------------------------------------------------------------
say "restart check"
npx tsx scripts/e2e/docker-restart.ts --base "http://localhost:$APP_PORT" --fake "http://localhost:$FAKE_PORT" --container "$APP" \
  --env-file "$WORK/run.vars" || fail "restart check failed"

# --- 6. clean stop ------------------------------------------------------------------------------------------------
say "docker stop"
stop_started=$(date +%s)
docker stop --time 30 "$APP" >/dev/null || fail "docker stop failed"
echo "stopped in $(( $(date +%s) - stop_started )) s, exit code $(docker inspect -f '{{.State.ExitCode}}' "$APP"), oom-killed $(docker inspect -f '{{.State.OOMKilled}}' "$APP")"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$APP")" = 0 ] || fail "the container did not exit 0 on docker stop"
docker logs --tail 3 "$APP" 2>&1 | cut -c1-200
docker logs --tail 3 "$APP" 2>&1 | grep -q '"msg":"stopped"' || fail "no clean 'stopped' line in the log"

[ "$STATUS" = 0 ] && say "docker e2e: all checks passed" || say "docker e2e: FAILED"
exit "$STATUS"
