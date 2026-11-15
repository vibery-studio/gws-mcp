# gws-mcp

**Vision:** Control your essential Google services from your phone through Claude, using the remote mode, and stay in control: writes are dry runs until you apply them, and each AI app gets only the accounts you allow.

[![CI](https://github.com/vibery-studio/gws-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vibery-studio/gws-mcp/actions/workflows/ci.yml)

A Google Workspace MCP server in code mode. Your AI app gets two tools, `search` and `execute`. With them it finds typed functions for Gmail, Drive, Calendar, Sheets, Docs, Forms, Tasks, Slides, Search Console, Analytics, Google Ads, Google Groups and Tag Manager, then runs a short JavaScript snippet against one or several of your Google accounts.

Project page: https://vibery.app/lab/gws-mcp

- **Two tools only.** `search(query)` returns compact TypeScript signatures, each with its effect and an example. `execute(code, { apply? })` runs a snippet whose only globals are `sdk` and `console`.
- **Generated SDK.** It is built from pinned Google Discovery documents, with zod-checked inputs and outputs. Methods that cannot be supported safely are listed in [`src/sdk/generated/UNSUPPORTED.md`](src/sdk/generated/UNSUPPORTED.md). The helpers are:
  - Workspace: `helpers.sendMailWithAttachment`, `helpers.todayAgenda`, `helpers.appendSheetRows`, `helpers.exportDocPdf`, `helpers.uploadDriveFile`, `tasks.addTask`, `slides.fillTemplate` and `forms.responsesToSheet`.
  - Calendar control: `calendar.share`, `calendar.unshare`, `calendar.findFreeSlots` (free time across several of your accounts), `calendar.respond` and `calendar.move`.
  - Search Console: `searchconsole.topQueries`, `searchconsole.topPages` and `searchconsole.inspect`.
  - Analytics: `analytics.report` and `analytics.properties`.
  - Google Ads: `ads.report` and `ads.accounts`.
  - Tag Manager: `tagmanager.containers`, `tagmanager.workspaceStatus` and `tagmanager.publish`.
- **Several accounts.** Every call takes an optional `account` (an email or an alias); without one, it uses your default account.
- **Writes are dry runs by default.** A write returns its request plan until the snippet is run again with `apply: true`. Deletes and public shares are flagged as destructive.

```js
// One snippet, two accounts.
const unread = await sdk.gmail.users.messages.list({ userId: "me", q: "is:unread", maxResults: 5, account: "work" });
const today = await sdk.helpers.todayAgenda({ account: "personal" });
return { unread: unread.messages?.length ?? 0, today };
```

## Inspired by

- **[Google Workspace CLI](https://github.com/googleworkspace/cli)** (`gws`, Apache-2.0) builds its commands from Google's Discovery documents and adds `+helper` shortcuts for common jobs. gws-mcp takes the same approach: its SDK is generated from pinned Discovery documents, with a small set of helpers on top. What it adds is MCP and several Google accounts in one call.
- **Cloudflare's Code Mode** ([Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/), [cloudflare/mcp](https://github.com/cloudflare/mcp)) puts the whole Cloudflare API behind two tools, `search` and `execute`, and runs the agent's code in a sandbox. gws-mcp uses the same two-tool shape for Google, and its remote mode runs snippets with [`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode) in a Dynamic Worker with no network access.

## Services, scopes and the Google Cloud APIs

gws-mcp asks Google only for the scopes of the services you connect to an account, and you can add services to an account later.

| Service | What it can do | Connected | Google Cloud API to enable |
|---|---|---|---|
| Gmail, Drive, Calendar, Sheets, Docs, Forms, Tasks, Slides | The original eight services. | one click | the service's own API |
| Search Console | Sites, sitemaps (submit and delete are writes), search analytics, URL inspection. | one click | Search Console API |
| Analytics | GA4 reports and the property list (read-only). | one click | Google Analytics Data API and Google Analytics Admin API |
| Analytics (edit) | Change Analytics accounts and properties (`analytics.edit`). Deletes are flagged. | added on purpose | Google Analytics Admin API |
| Google Ads | Read campaigns and reports, and change them. Every Ads change can spend money and is flagged as destructive. | added on purpose | Google Ads API, plus your [developer token](#google-ads-developer-token) |
| Google Groups | Groups, members and group settings. Works only for a Google Workspace admin; any other account gets `GWS_ADMIN_REQUIRED`. Removing a member or deleting a group is flagged as destructive, and so is opening a group to anyone. | added on purpose | Admin SDK API and Groups Settings API |
| Tag Manager (read) | Accounts, containers, workspaces, tags, triggers and variables. | one click | Tag Manager API |
| Tag Manager (edit), (publish), (admin) | Edit workspaces; create and publish versions; manage accounts, users and container deletion. Publishing, deleting and permission changes are flagged as destructive. | added on purpose | Tag Manager API |

The seven APIs for the new services are: **Search Console API, Google Analytics Data API, Google Analytics Admin API, Google Ads API, Admin SDK API, Groups Settings API and Tag Manager API.** Enable the ones for the services you will connect in your Google Cloud project; [docs/self-host-google-client.md](docs/self-host-google-client.md) lists the exact scope for each.

"One click" services are what a first sign-in, "Add Google account" and `accounts add` without `--services` ask for. "Added on purpose" services are never part of that: add them to an account on its Google services page (`/accounts/<id>/services`), with `accounts add --services <list>` (local), or through a connect link from `accounts.connect`. An AI app that makes the link only shows it to you: Google's consent screen is where you approve what it asks for.

Calendar sharing and the free-slot search need the `calendar` scope of the `full` preset. The `narrow` preset's calendar scopes do not cover access rules or free/busy time, so there those helpers answer with a missing-scope error.

### Google Ads developer token

Google Ads needs a developer token, which Google issues to your manager account (Google Ads → Admin → API Center). It is per person: one token serves every Google account you connect for Google Ads. An optional manager account ID can be saved beside it.
- **Remote:** open `/accounts/<id>` for an account connected to Google Ads and fill "Google Ads details". The page says "developer code", and never shows a saved value again: you replace or remove it.
- **Local:** `npx -y @bnqtoan/gws-mcp settings set ads.developer_token --stdin` (one line on stdin or a hidden prompt), and `settings set ads.login_customer_id` for the manager account ID. `settings clear <key>` removes one.
- **Where it is stored:** encrypted in your own database (D1 for remote, SQLite for local) with the same key as the refresh tokens. It is added to Google Ads requests by the server only. Snippets never see it, and it never appears in output, logs, audit rows or plans.
- **Not from a chat.** `sdk.settings.set` refuses to save it, because anything pasted into a chat stays in the AI app's history. `sdk.settings.get` tells a snippet only whether a value is set.
- **One-time link (remote).** `sdk.settings.requestLink({ key })` returns a link (10 minutes, single use) to `/settings/set`, where the signed-in person enters the value themselves; the missing-token error and the `settings.set` refusal carry one in `details.setLink`. Only the user it was made for can use it, and it stops working once the setting changes. Locally it answers `GWS_UNSUPPORTED_RUNTIME`: use `settings set`.
- **Missing token.** Until one is saved, an Ads call fails with `GWS_ADS_DEVELOPER_TOKEN_MISSING` before anything is sent to Google. If a saved value can no longer be decrypted (for example after a key change), the error is `GWS_SETTING_UNREADABLE`: save it again.
- Removing someone from the access list does not delete their saved details; deleting the user, or `reset-data`, does.

## Two ways to run it

| | Local | Remote (self-hosted) |
|---|---|---|
| Runs on | your computer (Node.js 22.13 or later) | your Cloudflare account (Workers Paid plan) |
| MCP transport | stdio | Streamable HTTP at `https://<your host>/mcp` |
| Snippet sandbox | QuickJS in a worker thread | a Dynamic Worker with no network access |
| Storage | SQLite in your config folder; refresh tokens encrypted with a key held in the OS keychain | D1 and KV; refresh tokens encrypted with a Worker secret |
| AI apps | the one that starts it (single user) | each app signs in through OAuth and is allowed only the accounts you choose |
| Cost | free | Cloudflare Workers Paid |

Both modes use your own Google OAuth client and share the same SDK, write guard, limits, search, helpers, audit and error codes. To create the client, see [docs/self-host-google-client.md](docs/self-host-google-client.md).

## Local quick start

1. Create a Google OAuth client of type **Desktop app** ([guide](docs/self-host-google-client.md)).
2. Save it. Setup asks for the client ID and secret without echoing them; it never takes them as arguments.
   ```bash
   npx @bnqtoan/gws-mcp setup
   # or install it once:  npm i -g @bnqtoan/gws-mcp && gws-mcp setup
   ```
3. Connect a Google account in your browser. Run it again for each account.
   ```bash
   npx -y @bnqtoan/gws-mcp accounts add
   ```
4. Add it to your AI app. Setup prints the exact command for your install; with npx it is:
   ```bash
   claude mcp add gws -- npx -y @bnqtoan/gws-mcp serve
   ```

Other commands are `accounts list`, `accounts alias <account> <name>`, `accounts default <account>`, `accounts disconnect <account>` (which revokes the grant at Google), `doctor` and `--version`. Run `--help` for the flags.

- **Config folder:** `~/Library/Application Support/gws-mcp` on macOS, `$XDG_CONFIG_HOME/gws-mcp` (by default `~/.config/gws-mcp`) on Linux and `%APPDATA%\gws-mcp` on Windows. Set `GWS_MCP_CONFIG_DIR` to use another one.
- **No usable keychain** (a headless Linux machine, say): run `setup --key-file` to keep the key in a mode-600 file instead. `doctor` reports this as weaker.
- **Web client:** `setup --client web --port 8787` uses the fixed redirect `http://localhost:8787/google/callback`.

## Remote quick start (Cloudflare)

You need a Cloudflare account on Workers Paid, Node.js 22.13 or later, and `npx wrangler login`.

```bash
git clone https://github.com/vibery-studio/gws-mcp && cd gws-mcp
npm ci
export CLOUDFLARE_ACCOUNT_ID=<your account id>   # or set "account_id" in wrangler.jsonc
npm run setup                                    # optional: npm run setup -- --prefix <name>
```

`npm run setup` can be run again safely. It does the following:
- creates `wrangler.jsonc` from `wrangler.example.jsonc`;
- creates the D1 database and the two KV namespaces;
- applies the migrations;
- asks for the owner's email when the access list is empty (prompt, or the first stdin line) and makes it the first admin;
- generates `TOKEN_ENC_KEY` and asks for the Google client ID and secret (hidden prompt, or two lines on stdin);
- deploys the Worker;
- prints the redirect URI to register on your Google **Web application** client.

Then:
1. Add the printed `https://<your host>/google/callback` to the client's Authorized redirect URIs.
2. Open `https://<your host>/` and sign in with Google. Manage your accounts at `/accounts` and your AI apps at `/apps`.
3. Connect an AI app to `https://<your host>/mcp`. For Claude Code: `claude mcp add --transport http gws https://<your host>/mcp`.

### Who can use it (the access list)

Only people on the access list can sign in and use the server. The list lives only in the D1 database, never in code, env vars or `wrangler.jsonc`. A rule is either an exact email (`ann@example.com`) or a whole domain (`@example.com`). A domain rule matches exactly the part after the `@`, so it never matches a subdomain or a lookalike name. It checks the address Google verified, not whether the account belongs to that domain's Google Workspace: a personal Google account registered with a work address counts too. Emails that are not plain ASCII are refused. Each rule is either `user` or `admin`, and admins also manage the list.
- **Who is checked.** A person is checked by the email they first signed in with. Signing in later through another of their own accounts doesn't change that, and a removed person can't get back in through another account.
- **First admin.** `npm run setup` asks for the owner's email while the list is empty and adds it as admin. If the list is still empty when the Worker runs, the first person to sign in becomes admin and the list then closes. A single conditional insert does this, so two people signing in at the same moment cannot both become admin. Run setup before sharing the URL. An upgraded deployment keeps working: the migration makes every existing user's sign-in email an admin.
- **Resetting data** (`npx tsx scripts/reset-data.ts --owner <email> --apply`, needed before switching from the fake Google to the real one) wipes the list along with everything else and writes the owner back as its only admin in the same database call, so the list is never left empty.
- **Managing it.** Admins see "Who can use this" at `/access`, where they can add an email or a domain, change its role or remove it. AI apps can use `sdk.access.list`, `sdk.access.add` and `sdk.access.remove`. Those calls are admin-only, and add and remove run only with `apply: true`. The last admin named by an exact email can't be removed or made a user; a domain admin rule doesn't count, because it names no particular person. Every change writes one audit row: who made it, how, the rule and its kind.
- **Removing someone.** Their next sign-in is refused straight away. Their AI apps are cut off in the same database change that removes the rule: those approvals are deleted, so the apps' tokens never work again, even if the person is added back later. This also holds when two rules covering the same person are removed at the same moment: the second removal to land sees no rule left and cuts them off. The apps' grants are then revoked too. If that step doesn't finish, the page and `sdk.access.remove` say so. Their open session is refused within a minute, which is how long each Worker caches a person's rule, but they can't approve a new AI app in that minute: approving reads the list fresh.
- **One person inside a domain rule** can't be excluded on their own: there are no deny rules. To shut out one person covered by `@example.com`, replace the domain rule with exact emails.
- **More Google accounts.** Someone on the list can connect any of their own Google accounts, including addresses the list doesn't name. The list controls who uses gws-mcp, not which Google accounts they connect.
- **Local mode** has the same tables but doesn't enforce them: it serves only the person running it, with no sign-in and no other users, so no list is needed. Like the remote server, it refuses a Google account whose email is not plain ASCII.

To upgrade, update your checkout, then run `npm run update`. It typechecks, checks the generated SDK, migrates, deploys, and confirms that `/version` reports this checkout's SDK hash.

## Self-host on a VPS (Docker)

The same server also runs on Node 22 in one Docker container with a single SQLite file, behind Caddy for TLS. You build the image yourself; none is published. See [docs/self-host-vps.md](docs/self-host-vps.md) for the Google redirect URI, the secrets file and `TOKEN_ENC_KEY` custody, backups and upgrades. Compose and Caddy examples are in [`deploy/`](deploy/).

## Security model

- **Credentials stay on the host.** Snippets never see a token, a secret or the environment. Their only globals are `sdk` and `console`, and they have no network access. Token-shaped text in console output and error messages is redacted.
- **Tokens at rest are encrypted.** Refresh tokens use AES-GCM. The key is a Worker secret (remote), or is held in the OS keychain (local), with an optional mode-600 key file flagged as weaker.
- **Two separate permissions.** Your AI app's access to gws-mcp and gws-mcp's access to each Google account are granted separately. In remote mode, each AI app may use only the accounts you allowed, checked on every call, and connecting a new account never widens an existing app's access.
- **Writes need a second step.** A write runs only when the snippet is executed with `apply: true`. Whether you are asked first depends on your AI app.
- **High-impact steps need you, not the AI app (remote).** A step that spends money in Google Ads, makes something public, hands over ownership, changes who has access or publishes (the `GWS_HUMAN_APPROVAL` var: a comma list of these reasons, or `off`) is marked `needsApproval`. Its dry run returns a one-time link (10 minutes) to `/plan/approve`, where you, signed in, approve or decline exactly those steps; `apply: true` then runs them once, within 10 minutes, for that exact code and input. Without your approval it answers `GWS_APPROVAL_REQUIRED` and writes nothing. To check, an `apply: true` run first repeats the dry run, so its reads run twice. The page shows each such step in full (or offers only Decline when it is too large to show), names the AI app, and lists the change's other writes. A step that uses the result of a write that has not run yet cannot be approved: apply that write first; for the same reason `sdk.tagmanager.publish` then refuses and names the two runs to use instead. The local server has no such page, so the var must stay `off` there.
- **The audit keeps metadata only:** one row per SDK call (function, account, effect, status, duration), never message bodies or file contents.
- **Local sign-in** listens on 127.0.0.1 only, with PKCE, a single-use state and a browser-bound start link.

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability. See [PRIVACY.md](PRIVACY.md) for data flows: there is no telemetry.

## Limits

| Limit | Default |
|---|---|
| SDK calls per `execute` | 50 |
| `execute` wall time | 45 s |
| Result returned to the AI app | 200 KB |
| One Google response | 4 MB; 16 MB per `execute` |
| One call's input | 5 MB |
| Rate | 120 calls a minute per AI app; 300 a minute per user |

Each limit, when hit, returns a structured error.

What it does not do:
- Chat and People are not supported. Of the Admin SDK only Google Groups and their members are.
- There is no raw HTTP and no `fetch` from snippets.
- Jobs cannot run longer than the `execute` timeout.
- Push-notification (`watch`) methods are not supported.

Google's own limits also apply:
- In testing mode, refresh tokens expire after 7 days.
- The Gmail read scopes and the full Drive scope are restricted. The scopes of the marketing services have their own verification classes: check Google's scope list before offering your client to other people.

Both are covered in [docs/self-host-google-client.md](docs/self-host-google-client.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
