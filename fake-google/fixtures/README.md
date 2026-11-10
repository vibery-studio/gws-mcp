# Fake Google: HTTP contract and fixture format

Code: `fake-google/src/`. Handler: `createFakeGoogle({store, signingKey, clientId, clientSecret, adminToken?, redirectUris?, loginSecret?, routes?})` → `(Request) => Promise<Response>`. Web Crypto + fetch API only (runs in Node, workerd, Durable Object). `redirectUris` = exact-match allowlist (byte equality, like a real Google client). `adminToken` set (deployed fake) ⇒ `redirectUris` (non-empty) and `loginSecret` (≥16 chars) required, else construction throws.

## Addressing
Host-prefixed paths: `https://{host}/{path}?q` is served at `{fake}/{host}/{path}?q`.
Tests: `env.FAKE_GOOGLE.fetch("http://fake-google/{host}/{path}")` (helper `test/helpers/fake.ts`). Deployed: `FAKE_GOOGLE_PUBLIC_URL`.

## OAuth endpoints (client = `FAKE_CLIENT_ID` / `FAKE_CLIENT_SECRET` from `src/config.ts`)
| Route | Behaviour |
|---|---|
| `GET /accounts.google.com/o/oauth2/v2/auth` | HTML picker of seeded accounts. Bad `client_id` / `redirect_uri` (not absolute http(s), has fragment, or not in `redirectUris`) → 400 page, never a redirect. With `loginSecret`: page has a `login_secret` password field. Other problems → 302 `redirect_uri?error=...&state`: `response_type!=code` → `unsupported_response_type`; missing scope/state, PKCE missing or not `S256`, bad `access_type`/`include_granted_scopes`/`prompt` → `invalid_request`. |
| `POST .../auth/approve` | Form: echoed authorize params + `email` (must be seeded) + `decision=allow\|deny` (+ `login_secret` when configured; wrong/missing → 401 page, constant-time compare). Params re-validated. Deny → `error=access_denied`. Allow → 302 `redirect_uri?code&state&scope`. Code = HMAC-signed blob (email, client, scopes, redirect_uri, challenge, issueRefresh, exp 5 min), single use. Grant (per account + client) = union of every scope approved since the last revoke. Granted scopes (code, token response `scope`, its refresh token) = prior grant + requested when `include_granted_scopes=true`, else requested only. Another client's grant never counts; after a revoke the next consent starts from the requested scopes. gws-mcp stores the token response `scope` as is (no local merge). |
| `POST /oauth2.googleapis.com/token` | Form; client auth via body or HTTP Basic (bad → 401 `invalid_client`). `authorization_code`: checks signature, expiry, `redirect_uri` equality, PKCE verifier, single use (→ 400 `invalid_grant`). Returns `{access_token:"ya29.fake-…", expires_in:3600, token_type:"Bearer", scope, refresh_token:"1//fake-…"}`; `refresh_token` only when `access_type=offline` AND (no prior grant for account+client, or `prompt` contains `consent`), as real Google. Re-consent adds a token; older ones stay valid. After revoke the next grant is a first grant.`. `refresh_token`: unknown/revoked → 400 `{"error":"invalid_grant"}`; no new refresh token. Other grant → `unsupported_grant_type`. |
| `POST /oauth2.googleapis.com/revoke` | `token` in form body or query (refresh or access). Revokes all tokens of that account+client and the grant. Unknown → 400 `invalid_token`. |
| `GET\|POST /openidconnect.googleapis.com/v1/userinfo` | Needs one of `openid`, `email`, `…/auth/userinfo.email` → `{sub,email,email_verified:true}`. Include `openid email` in connect-flow scopes if userinfo is needed. |

Tokens are stored only as SHA-256 hashes (`oauth:token:<hash>`).

## API routes (service files `routes/<svc>.ts`)
`export const routes: FakeRoute[]` with `FakeRoute = {method, pattern: RegExp (host-prefixed path, no g/y flag), scopes: string[], handle(ctx)}`.
Before `handle`, the app enforces a valid access token holding any one of `scopes` (the method's Discovery scopes): 401 `UNAUTHENTICATED` or 403 `PERMISSION_DENIED` with `details[].reason = "ACCESS_TOKEN_SCOPE_INSUFFICIENT"`.
`ctx = {req, url, path, match, store, email (token owner), scopes, now()}`; `now()` = seeded clock for the account, else wall time.
Helpers from `../oauth`: `googleError(status, message, googleStatus, {errors?, details?, headers?})`, `requireAccess(ctx, anyOfScopes)`.
Unknown route → 404 `{"error":{"code":404,"message":…,"status":"NOT_FOUND"}}`.
Optional `export const presets: SeedPresets` = `{ <presetName>: [{key, value}] }`; `{email}` in keys and string values is replaced by the seeded account.

## Store key convention
`<svc>:<kind>:<email>:<id>`, e.g. `drive:file:a@fake.test:abc`, `gmail:message:a@fake.test:m1`. All account state carries the email, so reset/state work per account and parallel tests with unique emails never collide. A service may write another service's kind (docs registers `drive:file:<email>:<id>` with mimeType `application/vnd.google-apps.document`) without editing that service's file.
Reserved namespaces (fake-internal, not seedable): `oauth`, `log`, `fault`, `clock`.

## Control routes `/__fake/*`
Need header `x-fake-admin: <adminToken>` when an admin token is configured (deployed fake); otherwise 401. Tests run without one.
| Route | Body / query | Result |
|---|---|---|
| `POST reset` | `{email?}` | Deletes that account's state (or everything; never do that in shared test runs). |
| `POST seed` | `{accounts:[{email, sub, preset?}], resources?:[{key, value}], now?}` | Account emails must end in a reserved TLD (`.test`, `.example`, `.invalid`), else 400. Upserts accounts, applies presets/resources, fixes clock (`now`, ms) for the listed accounts. |
| `POST faults` | `{email?, method ("*" ok), pathRegex, times, response:{status, headers?, body?, padBytes?}}` | Next `times` matching requests (bearer owner = `email` when set) get `response`. Checked before routing. `padBytes` (integer 1–8000000) adds `padding: "x"×padBytes` to the JSON object body (or `{}`) when the fault fires; only the number is stored. |
| `GET requests?email=` | | `{requests:[{ts, method, path, query}]}` for Google-host requests attributed to the account (bearer owner, approve email, code/refresh owner). Never bodies; credential-like query values (`token`, `code`, `client_secret`, …) → `[REDACTED]`. Use it to prove a dry-run sent no write. |
| `GET state?email=` | | `{email, now?, account?, grants:{clientId: scopes}, resources:{key: value}}`. |

## Fixture files
Request/response pair (`fake-google/fixtures/<svc>/*.json`), validated by `parseFixture`:
```json
{ "id": "gmail-messages-list", "source": "synthesized", "provenance": "Discovery gmail v1 rev 20261102 ListMessagesResponse",
  "request": { "method": "GET", "path": "/gmail.googleapis.com/gmail/v1/users/me/messages", "query": { "maxResults": "10" } },
  "response": { "status": 200, "headers": {}, "body": { "messages": [] } } }
```
`source`: `synthesized` (from pinned Discovery schemas, before the real-account gate) or `recorded` (after it). Bodies must validate against the generated zod output schema.
Seed file (`fixtures/seed/*.json`): same shape as the `POST seed` body; `loadSeedFixture("default")`.
Fixture sets: `gmail/`, `drive/`, `calendar/` (calendarList.list, calendars.get, events.list/insert), `sheets/` (spreadsheets.create/get, values.get/append/clear), `docs/` (documents.create/get/batchUpdate), `forms/` (forms.get/create/batchUpdate, responses.list), `tasks/` (tasklists.list/insert, tasks.list/get/insert/patch), `slides/` (presentations.get/create/batchUpdate).
Slides keeps a presentation's content in its Drive blob (`drive:blob:<email>:<id>`, base64 JSON), so `drive.files.copy`/`delete` copy/delete the slides; a `drive:file` record, when present, supplies the title.

## Preset `default`
Per seeded account: Gmail messages + label `Label_1`; Drive folder `seed-folder-projects`, `README.txt`, doc `seed-doc-notes`, trashed `old-draft.txt`; Calendar `primary` (time zone Asia/Saigon) with events around 2026-11-09; Sheets spreadsheet "Budget" (`Sheet1`: Item/Amount, Coffee/4); Docs document `seed-doc-notes` ("Meeting notes"); Forms form `seed-form-feedback` (2 questions, 2 responses); Tasks default list `seed-tasklist-default` ("My Tasks", `@default`, 2 tasks); Slides presentation `seed-slides-template` (`{{name}}` placeholders, Slides only: not in Drive listings).
Preset `templates`: `seed-slides-template` registered as a Drive file too, so `drive.files.copy` can copy it. Seed it after (or instead of) `default`.
Calendar events are written against `SEED_NOW` (exported from `routes/calendar.ts`, 2026-11-09 12:00 Asia/Saigon): seed it as `now` for the account so "today" helpers see the seeded day.

## Deployed fake (Worker `gws-mcp-fake-google`)
- `src/worker.ts`: default export forwards every request to the Durable Object `FakeState` instance `idFromName("fake")`. Module start-up throws (no start, no deploy) unless `FAKE_ADMIN_TOKEN`, `FAKE_SIGNING_KEY` and `FAKE_LOGIN_SECRET` are set (≥32 chars; generated as 32 random bytes, base64). Error names the keys only.
- `src/do-store.ts`: `FakeState` serves `createFakeGoogle({store: DoStore, signingKey, clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, adminToken, redirectUris, loginSecret})`. `redirectUris` come from the `GWS_MCP_CALLBACKS` var (space-separated, canonical http(s) URLs, matched byte for byte; malformed fails startup); unset means only `http://localhost:8787/google/callback`. The operator's local config lists production, local dev and the fake-mode E2E Worker. `loginSecret` (picker password, form field `login_secret`) is separate from `adminToken` (header `x-fake-admin` on `/__fake/*`).
- `DoStore` = `FakeStore` over SQLite-backed DO storage: JSON text per value, values over 256 K chars split into chunks (DO value limit 2 MB; max value 16 M chars), list sorted like `MemoryStore`. Request log bounded: newest 1000 entries per seeded account; entries attributed to an unseeded email (e.g. any `login_hint`) go to the unattributed log `_`, bounded the same way. Each entry is size-capped (`capLogEntry`): strings ≤ 512 chars, fields kept in order while the entry's JSON fits 2048 chars; anything cut adds `truncated: true` (normal entries unchanged). A shrinking value deletes its stale chunks, also when it becomes inline.
- Config: the operator's untracked `fake-google/wrangler.jsonc`, template `fake-google/wrangler.example.jsonc` (`secrets.required` = the three keys; `vars.GWS_MCP_CALLBACKS`). Local secrets: `fake-google/.dev.vars` from `scripts/dev-secrets.ts` (gitignored, mode 600). Local run: `npm run dev:fake` (port 8788).
- Not modelled: Drive `drive.file` app-created-only access (any file of the account is reachable with `drive.file`); `drive.files.update` with media has no route.
