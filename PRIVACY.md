# Privacy

gws-mcp is software you run yourself, on your own computer (local mode) or your own Cloudflare account (remote mode). It is not a hosted service.

- **No telemetry.** gws-mcp sends no analytics, crash reports or usage data anywhere. It does not check for updates.
- **The maintainer never receives your data.** There is no maintainer server in any data path. The maintainer cannot see your accounts, tokens, files, messages or logs, and cannot reach your deployment.
- **Where data flows.** Data moves only between you, your runtime and Google:
  - **you ↔ your runtime:** your AI app talks to gws-mcp on your machine (stdio), or on your Worker (HTTPS);
  - **your runtime ↔ Google:** gws-mcp calls Google's OAuth and Workspace APIs with the OAuth client you created.

  Your AI app's provider sees what the AI app sends it, including the results of the snippets it runs. That is governed by your AI app's own terms, not by gws-mcp.
- **What is stored, and where:**
  - **Local:** a SQLite database and a settings file in your config folder, plus the encryption key in your OS keychain (or a key file, if you chose one).
  - **Remote:** D1 and KV in your Cloudflare account, plus Worker secrets.

  Both hold:
  - the connected accounts (email, alias, granted scopes);
  - the refresh tokens, encrypted (remote mode also caches short-lived access tokens, encrypted, in KV; local mode keeps them in memory only);
  - an audit log of SDK calls, with metadata only (function, account, effect, status, duration), never message bodies or file contents;
  - remote only: the MCP client registrations and approvals.
- **Deleting data:**
  - `gws-mcp accounts disconnect <account>` (local), or Disconnect on `/accounts` (remote), revokes the grant at Google and deletes the stored token.
  - Deleting the local config folder, or the Worker with its D1 and KV, removes everything else.
  - You can also remove access at https://myaccount.google.com/permissions.
