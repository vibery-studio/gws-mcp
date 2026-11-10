# gws-mcp

[![CI](https://github.com/vibery-studio/gws-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vibery-studio/gws-mcp/actions/workflows/ci.yml)

A Google Workspace MCP server in code mode. Your AI app gets two tools, `search` and `execute`. With them it finds typed functions for Gmail, Drive, Calendar, Sheets, Docs, Forms, Tasks and Slides, then runs a short JavaScript snippet against one or several of your Google accounts.

Project page: https://arealisticdreamer.com/gws-mcp

- **Two tools only.** `search(query)` returns compact TypeScript signatures, each with its effect and an example. `execute(code, { apply? })` runs a snippet whose only globals are `sdk` and `console`.
- **Generated SDK.** It is built from pinned Google Discovery documents, with zod-checked inputs and outputs. Methods that cannot be supported safely are listed in [`src/sdk/generated/UNSUPPORTED.md`](src/sdk/generated/UNSUPPORTED.md). The helpers are `helpers.sendMailWithAttachment`, `helpers.todayAgenda`, `helpers.appendSheetRows`, `helpers.exportDocPdf`, `helpers.uploadDriveFile`, `tasks.addTask`, `slides.fillTemplate` and `forms.responsesToSheet`.
- **Several accounts.** Every call takes an optional `account` (an email or an alias); without one, it uses your default account.
- **Writes are dry runs by default.** A write returns its request plan until the snippet is run again with `apply: true`. Deletes and public shares are flagged as destructive.

```js
// One snippet, two accounts.
const unread = await sdk.gmail.users.messages.list({ userId: "me", q: "is:unread", maxResults: 5, account: "work" });
const today = await sdk.helpers.todayAgenda({ account: "personal" });
return { unread: unread.messages?.length ?? 0, today };
```

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
- generates `TOKEN_ENC_KEY` and asks for the Google client ID and secret (hidden prompt, or two lines on stdin);
- deploys the Worker;
- prints the redirect URI to register on your Google **Web application** client.

Then:
1. Add the printed `https://<your host>/google/callback` to the client's Authorized redirect URIs.
2. Open `https://<your host>/` and sign in with Google. Manage your accounts at `/accounts` and your AI apps at `/apps`.
3. Connect an AI app to `https://<your host>/mcp`. For Claude Code: `claude mcp add --transport http gws https://<your host>/mcp`.

To upgrade, update your checkout, then run `npm run update`. It typechecks, checks the generated SDK, migrates, deploys, and confirms that `/version` reports this checkout's SDK hash.

## Security model

- **Credentials stay on the host.** Snippets never see a token, a secret or the environment. Their only globals are `sdk` and `console`, and they have no network access. Token-shaped text in console output and error messages is redacted.
- **Tokens at rest are encrypted.** Refresh tokens use AES-GCM. The key is a Worker secret (remote), or is held in the OS keychain (local), with an optional mode-600 key file flagged as weaker.
- **Two separate permissions.** Your AI app's access to gws-mcp and gws-mcp's access to each Google account are granted separately. In remote mode, each AI app may use only the accounts you allowed, checked on every call, and connecting a new account never widens an existing app's access.
- **Writes need a second step.** A write runs only when the snippet is executed with `apply: true`. Whether you are asked first depends on your AI app.
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
- Chat, People and Admin are not supported.
- There is no raw HTTP and no `fetch` from snippets.
- Jobs cannot run longer than the `execute` timeout.
- Push-notification (`watch`) methods are not supported.

Google's own limits also apply:
- In testing mode, refresh tokens expire after 7 days.
- The Gmail read scopes and the full Drive scope are restricted.

Both are covered in [docs/self-host-google-client.md](docs/self-host-google-client.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
