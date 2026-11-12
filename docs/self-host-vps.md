# Self-host on a VPS (Docker)

The same server as the Cloudflare deployment, run on Node 22 in one container with one SQLite file. Caddy in front provides TLS. Owners: [Dockerfile](../Dockerfile), [deploy/docker-compose.example.yml](../deploy/docker-compose.example.yml), [deploy/Caddyfile.example](../deploy/Caddyfile.example), the host's config in `src/runtime/node/config.ts`, its commands in `src/runtime/node/access-command.ts` and `backup-command.ts`.

No image is published. You build it from a checkout.

## Requirements

- A host with Docker and Docker Compose, and a public DNS name pointing at it, with ports 80 and 443 reachable (Caddy gets the certificate itself).
- A Google Cloud project with a **Web application** OAuth client. Consent screen, APIs and scopes: [self-host-google-client.md](self-host-google-client.md).

## 1. Google OAuth client

Register this redirect URI on the client, exactly (scheme, host, path):

```
https://<your domain>/google/callback
```

It is always `PUBLIC_BASE_URL` plus `/google/callback`; the server never derives it from the request.

## 2. Secrets file

The server reads three secrets from a file named by `GWS_SECRETS_FILE`, one `NAME=value` per line (`#` comments allowed): `TOKEN_ENC_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. A secret may instead be in the environment, but never in both places (the server refuses to start). Do not put them in the compose file, the image or the repo.

```bash
openssl rand -base64 32        # the value of TOKEN_ENC_KEY: 32 random bytes, base64
```

Write the file with an editor (not a shell line that lands in history), then:

```bash
sudo chown 10001:10001 secrets.env && sudo chmod 400 secrets.env
```

The container runs as uid/gid 10001. The server refuses a secrets file that is not a regular file or that group or others can read or write (mode 0400 and 0600 pass). Compose mounts the file as it is on the host, so the host ownership matters. On macOS with colima a bind-mounted file cannot be owned by 10001, so this flow is Linux-oriented.

### Key custody

- `TOKEN_ENC_KEY` encrypts the Google refresh tokens and per-user settings (for example the Ads developer token) in SQLite. Keep an offline copy, separate from database backups.
- Losing it, or changing it, makes those values unreadable: every person must reconnect Google and re-enter settings. There is no in-place rotation; rotating means a new key and everyone reconnecting. The access list, OAuth records and audit rows are not encrypted by it and stay valid.
- A backup holds the encrypted values plus the access list and OAuth records. Restoring needs the key that was current when the backup was taken. Store backups owner-only and off the host, never next to the key.
- `GOOGLE_CLIENT_SECRET` is never committed or logged; the secrets file is the one place for all three.

## 3. Compose and Caddy

1. Build the image from the repo root: `docker build -t gws-mcp .`
2. Copy `deploy/docker-compose.example.yml` and `deploy/Caddyfile.example` side by side (the compose file mounts `./Caddyfile.example`), put `secrets.env` there, and create `.env` with `GWS_DOMAIN=gws.example.com`.
3. `docker compose up -d`

What the example sets, and why:

- Only Caddy publishes ports (80, 443). The app listens on `0.0.0.0:8787` inside the container network only.
- `GWS_TRUSTED_PROXIES=172.28.0.2` (Caddy's pinned address) and `GWS_CLIENT_IP_HEADER=x-real-ip`. The server takes the client address from the socket and honours a forwarded header only when the peer is a trusted proxy. The Caddyfile's `header_up X-Real-IP {remote_host}` overwrites the client's own value; the trusted header must be one the proxy overwrites, never passes through or appends to. `X-Forwarded-For` is read right to left, so only the hop the proxy appended counts.
- Startup warnings (JSON log lines): `GWS_TRUSTED_PROXIES is not set` (behind a proxy every client then shares one per-address rate-limit bucket), and `GWS_CLIENT_IP_HEADER is not set` while proxies are trusted (the default `x-forwarded-for` is read). Act on either.
- `read_only` root, `tmpfs /tmp`, all capabilities dropped, `no-new-privileges`. Data lives on the `gws-data` volume at `/data` (database at `/data/gws-mcp.db`). Caddy's `flush_interval -1` keeps MCP responses streaming.
- The server logs one JSON object per line to stdout: `docker compose logs gws-mcp`. A configuration problem logs `configuration error` and exits 78; it names keys, never values.

## 4. First admin

The access list decides who may sign in. Seed the owner before anyone signs in; otherwise the first person to sign in becomes admin.

```bash
docker compose exec gws-mcp node /app/server.js access add you@example.com --admin
docker compose exec gws-mcp node /app/server.js access list
```

`access add <email | @domain> [--admin | --no-admin] [--note <text>]`, `access remove <email | @domain>` (also cuts off that person's AI apps). Same rules as the access page: [README, Who can use it](../README.md#who-can-use-it-the-access-list). Then open `https://<your domain>/` and sign in, and add the MCP URL `https://<your domain>/mcp` in your AI app.

## 5. Health

`GET /healthz` answers `200 {"ok":true,"version":...}` when the database answers, else `503 {"ok":false}`. It needs no sign-in and reveals nothing else. The image's `HEALTHCHECK` calls it, so `docker compose ps` shows `healthy`.

## 6. Backup and restore

```bash
docker compose exec gws-mcp mkdir -p /data/backups
docker compose exec gws-mcp node /app/server.js backup /data/backups/gws-$(date +%F).db
```

- Safe while the server runs. It refuses to overwrite an existing file and requires the folder to exist. The copy is owner-only (0600) and still sensitive.
- Copy it off the host, away from the key (for example `docker cp`).

Restore: stop the server first.

```bash
docker compose stop gws-mcp
docker compose run --rm --no-deps gws-mcp restore /data/backups/<file>
docker compose start gws-mcp
```

The backup file must be inside the container (the data volume). Restore refuses while any process has the database open, checks the file is an undamaged gws-mcp database, and refuses one written by a newer version. An older one is accepted and migrated at the next start. The replaced database is kept next to it as `<db>.before-restore-<timestamp>`.

Exit codes of `access`, `backup` and `restore`: 0 done, 1 refused (existing destination, server running, not a gws-mcp database, newer version, no such access rule), 64 usage, 70 internal failure, 75 database busy (try again), 78 configuration or database version.

## 7. Upgrades

1. Back up (section 6).
2. Update the checkout, `docker build -t gws-mcp .`, then `docker compose up -d`. The server applies new migrations itself at boot (it logs `migrations applied`); there is no separate migrate step.
3. Check `docker compose ps` shows healthy.

The `access` command does not migrate an existing database: it refuses (exit 78) when the file's recorded migrations differ from the build's, so start the new server first. A server refuses a database migrated by a newer build.

Rollback: stop the server, run the previous image, and restore the pre-upgrade backup (section 6). The newer database is kept as `.before-restore-*`.

## 8. Human approval

`GWS_HUMAN_APPROVAL` is a comma list of destructive reasons, or `off`. Unset means `spend,public-share,owner-transfer,permission-change,publish`. A plan with such a step returns a one-time link to `/plan/approve`; the signed-in person approves it and only then does `apply: true` run those steps. Behaviour and rationale: README Security model and `docs/decisions.md` (O74). The same page mechanism backs the one-time setting link (`/settings/set`). Both links need `PUBLIC_BASE_URL` to be the address people open.

## 9. Environment variables

Set under `environment:` in compose, or `-e`. Defaults are those in `src/runtime/node/config.ts` and `src/config.ts`; the Dockerfile overrides `GWS_HOST`, `GWS_PORT` and `GWS_DB_FILE` as shown.

| Name | Default | Meaning |
|---|---|---|
| `PUBLIC_BASE_URL` | required | Public origin, no path. https; http only for loopback. Every URL (OAuth issuer, callback, links) is built from it. |
| `GOOGLE_UPSTREAM` | required | `google`. `fake` is for tests only. |
| `GWS_SECRETS_FILE` | none | Path of the secrets file (section 2). |
| `GWS_DB_FILE` | required (image: `/data/gws-mcp.db`) | The SQLite file. |
| `GWS_HOST` | `127.0.0.1` (image: `0.0.0.0`) | Listen address. |
| `GWS_PORT` | `8787` | Listen port. |
| `GWS_TRUSTED_PROXIES` | none | Comma list of proxy IPs or CIDRs whose forwarded client address is trusted. |
| `GWS_CLIENT_IP_HEADER` | `x-forwarded-for` | `x-forwarded-for`, `x-real-ip` or `cf-connecting-ip`; read only from a trusted proxy. |
| `GWS_MAX_BODY_BYTES` | `1048576` | Request body cap (1 KiB to 32 MiB); larger gets 413. |
| `GWS_SHUTDOWN_TIMEOUT_MS` | `25000` | How long in-flight requests may drain on SIGTERM. Keep the container stop timeout above it. |
| `GWS_SANDBOX_CONCURRENCY` | `4` | Snippets running at once (1 to 32). |
| `GWS_HUMAN_APPROVAL` | the five reasons above | Reasons needing a person's approval, or `off`. |
| `GOOGLE_SCOPE_PRESET` | `narrow` | `narrow` or `full` scopes; see the Google client guide. |
| `LOGIN_ACCOUNTS` | `primary` | `primary`, or `active` to let a user's other active accounts sign in. |
| `CALLS_PER_EXECUTE` | `50` | SDK calls per `execute`. |
| `EXECUTE_TIMEOUT_MS` | `45000` | `execute` wall time. |
| `RESULT_MAX_BYTES` | `200000` | Result returned to the AI app. |
| `CALL_RESPONSE_MAX_BYTES` | `4000000` | One Google response. |
| `EXECUTE_RESPONSE_MAX_BYTES` | `16000000` | All Google responses of one `execute`. |
| `CALL_INPUT_MAX_BYTES` | `5000000` | One call's input. |
| `UPSTREAM_CONCURRENCY` | `4` | Google calls in flight in one `execute` (max 6). |
| `SEARCH_MAX_BYTES` | `8000` | Size of a `search` result. |
| `RATE_CLIENT_PER_MIN` | `120` | Calls per minute per AI app. |
| `RATE_USER_PER_MIN` | `300` | Calls per minute per user. |
| `FAKE_GOOGLE_PUBLIC_URL`, `GWS_FAKE_GOOGLE_URL` | none | Test harness only (fake Google); leave unset. |

`TOKEN_ENC_KEY`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are secrets (section 2); the server removes them from its process environment after loading. Limits are bounded: a value above its maximum fails the configuration load.

## Known limits

- The compose example has not been run end to end here (no `docker compose` available); the same container settings were run with `docker run` by `npm run e2e:docker`, against a fake Google.
- Linux host networking is untested; the e2e run used colima on macOS.
- The snippet sandbox on Node has no timers (`setTimeout` is undefined), as in the local runtime.
- Client ID metadata documents (CIMD) are off on Node: an AI app registers itself dynamically instead, and a URL as client id is refused.
- Only SQLite (no Postgres). There is no built-in backup schedule: schedule the backup command yourself.
