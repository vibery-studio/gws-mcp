# E2E harness: Done 1–10, 16

Drives a running fake-mode gws-mcp and its fake Google as a real MCP client plus browser would. The fake-mode Worker has its own config: the operator's untracked `wrangler.e2e.jsonc` (template `wrangler.e2e.example.jsonc`; production's `wrangler.jsonc` never binds the fake). Locally `npm run dev:e2e`, deployed `gws-mcp-e2e`. Any other `--base` is refused (`target.ts`).

## Local run
```bash
npx tsx scripts/dev-secrets.ts            # once: .dev.vars + fake-google/.dev.vars (mode 600, values never printed)
npm run db:migrate:e2e:local              # local D1 of the E2E config (gws-mcp-e2e)
lsof -i :8787 -i :8788                    # must be free (or held by your own earlier dev servers: stop them)
npm run dev:fake                          # background, port 8788 (fake Google Worker, Durable Object state)
npm run dev:e2e                           # background, port 8787 (E2E config; .dev.vars overrides the URLs; FAKE_GOOGLE via the dev registry)
npx tsx scripts/e2e/run.ts --base http://localhost:8787 --fake http://localhost:8788
```
Stop both dev servers afterwards. Deployed: `--base <PUBLIC_BASE_URL> --fake <FAKE_GOOGLE_PUBLIC_URL> --remote-d1`, both exactly as set in `vars` of the local `wrangler.e2e.jsonc`; without that file (or its `PUBLIC_BASE_URL`) deployed runs are refused.

`--base`/`--fake` must be `https:`; plain `http:` only for loopback (`localhost`, `127.0.0.1`, `[::1]`), refused before any secret is read or sent.
`--fake` is pinned to the target: a loopback fake for a loopback base, exactly the config's `FAKE_GOOGLE_PUBLIC_URL` for the E2E Worker. Setup then requires the fake's control route to answer 401 without the admin header before any admin or login secret is sent.
D1: `wrangler d1 execute gws-mcp-e2e --local` (loopback) or `--remote` (the E2E Worker), always with `--config` of the E2E config (`scripts/wrangler.ts`; remote needs the local file); never the production database. `--remote-d1` with a loopback base is refused.
Options: `--env-file <path>` (repeatable; default loopback → `.dev.vars`, `fake-google/.dev.vars`; E2E Worker → `.env`), `--only 1,5` (subset, same order).
Secrets read by path: `FAKE_ADMIN_TOKEN` (fake control routes), `FAKE_LOGIN_SECRET` (picker `login_secret`), the target's token key for the Done 9 moved-row test: `TOKEN_ENC_KEY` locally, `E2E_TOKEN_ENC_KEY` for the E2E Worker (the production key is never read). Never in argv or output.

## Output
`SETUP ok|FAIL` + lines, then per check `DONE-<n> PASS|FAIL` with evidence lines (`ok …` / `FAIL …` / notes), then `SUMMARY <k>/<n> PASS`. Exit 0 only when all pass. Evidence is run through `src/core/redact.ts` patterns plus every secret the run holds (env secrets, MCP access tokens, cookies).

## Setup (every run, fresh state)
Seeds `e2e-<runId>-a|b|c@fake.test` (preset `default`) via `/__fake/seed`; signs in as a (first sign-in → connect, lands on Home `/`); connects b through the connect action Google accounts offers (`/connections/connect`, CSRF read from `/accounts`); approves the main client for a only (consent pre-checks nothing, so the harness ticks a).

## Checks (files `checks/done-NN.ts`, run order 1,2,3,4,5,6,7,9,10,16,8)
1. `tools/list` = `["execute","search"]`; `POST /mcp` without token → 401 + `WWW-Authenticate: Bearer … resource_metadata`.
2. Consent page: client name, capabilities text, account checkbox, nothing pre-checked; approved token → 200; remove it by submitting the `/apps/<id>/remove` page's form as rendered (it posts this app and the session CSRF to `/connections/client-revoke`, + Origin) → 303 `/apps`, same token 401.
3. Search: top hit has signature/effect/example; one query per service (8, incl. forms/tasks/slides) finds its method in the top 3; ≤10 results, ≤8000 bytes.
4. Read returns data; unknown method / bad input / bad response shape (fault) / missing scope → 4 distinct codes.
5. Dry-run create + public share: plan with destructive, incomplete dependent step; after the dry-run `/__fake/state` has no `E2E-DOC-<runId>` file and no new permission; account a's request log, read immediately before and after each step, grows by 0 API writes (dry-run) / 2 (apply), and the earlier entries must stay its exact prefix (an eviction fails the check; no clock comparison); `apply:true` → file + `anyone` permission in `/__fake/state`.
6. Client (a only) → `GWS_ACCOUNT_DENIED` on b; `accounts.connect` link → connect c (lands on `/accounts`); `accounts.list` hides c (`hiddenCount` +1), `client_grants` unchanged, c denied; `accounts.grant(c)` → `/connections/confirm` link; denied until the human confirms (session + CSRF POST), allowed after.
7. Isolation probes (`fetch`, `env`, `this.env`, `process.env`, `globalThis`, `sdk`, `__gws`) leak no secret/token shape, and their output holds no `[REDACTED]` (the probe emits no credential, so server redaction there means it reached one); logged `ya29.` → `[REDACTED]` (expected). Abuse probes: 300 KB JWT-prefix log+result → `GWS_RESPONSE_TOO_LARGE` fast; 1 MB planned body → `{bytes,truncated:true}`; 6 MB input → `GWS_INVALID_INPUT input-too-large`; `setTimeout` replaced → `GWS_EXECUTION_TIMEOUT` at the host deadline (~45 s), no late call; applied write then flood → structured error + audit row present.
9. One applied execute (labels.list, messages.send with body marker, files.create with content marker): audit rows = calls; D1 scan of every `sqlite_master` table (exact-prefix skip of `_cf_*`, filtered in code) finds no marker, `ya29.`, `1//`, `Bearer `, `GOCSPX-`, PEM header, JWT shape, nor any run secret value (exact match, never printed); refresh ciphertexts don't decode to a token prefix; b's row moved to another `user_id` no longer decrypts (restored after).
10. `gen:check` byte-identical hash = `/version.sdkHash`; `UNSUPPORTED.md` exists; `/version.upstream == "fake"`.
16. Forms/Tasks/Slides: the 3 new-service queries of Done 3 rank ≤3; forms.get + responses.list + tasklists.list + presentations.get (account a) ok; a one-shot bad-shape fault on `tasks.tasklists.list` → `GWS_RESPONSE_SHAPE`, the next call ok; `tasks.tasks.insert` and Slides `replaceAllText` dry-run (plan, 0 API writes, state unchanged) then `apply:true` (1 write, visible in `/__fake/state` / `presentations.get`); a dry-run of tasks.delete + Slides `deleteObject` + Forms `deleteItem` is destructive on every step, 0 writes; `gen:check` = `/version.sdkHash` and the 3 generated files exist. Older account: seeds `e2e-<runId>-d`, connects it for gmail/drive/calendar/sheets/docs only (lands on `/accounts`); the old `/connections` → 303 `/accounts`; d's `/accounts/<id>/services` lists the 5 as already connected and offers exactly forms, tasks, slides as checkboxes with Continue to Google, while a's offers nothing ("All available Google services are connected."); a client for d sees those 3 `false` in `accounts.list`, gets `GWS_SCOPE_MISSING` (connect hint `tasks`) on `tasks.tasklists.list`, and Forms/Slides reads pass on d's `drive.file` (Discovery scopes).
8. **Must run last** (spends the user's rate window): fresh client; waits for a fresh 60 s window; 51 calls → `GWS_CALL_BUDGET_EXCEEDED`; ~5 MB fault body (generated by the fake from `padBytes`, so the request is tiny) → `GWS_RESPONSE_TOO_LARGE`; waits for another fresh window; 3 × 45 calls → `GWS_RATE_LIMITED` (first 45 → none; all in one window); codes distinct. Default limits, no redeploy, pinned from error details (no route exposes the config): budget `limit=50`, response `scope=call max=4000000`, rate `scope=client limit=120`.

## Files
`run.ts` (args, secrets, setup, order, printing) · `oauth-driver.ts` (cookie-jar browser, fake admin + picker, consent, signed-in pages and their forms posting to `/connections/*`, DCR/PKCE/token) · `mcp.ts` (`@modelcontextprotocol/client` Streamable HTTP + raw status probes) · `target.ts` (allowed `--base` targets, D1 mode, env files, token key name) · `d1-scan.ts` (`wrangler d1 execute gws-mcp-e2e --local|--remote --json --config <E2E config>`; standalone: `npx tsx scripts/e2e/d1-scan.ts --local [--marker X]`, no run secrets).

Run time ≈ 2–3 min locally (Done 7 waits for the 45 s host deadline, Done 8 for a fresh rate window).
