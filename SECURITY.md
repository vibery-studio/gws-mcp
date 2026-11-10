# Security

## Reporting a vulnerability

Report it privately through GitHub: https://github.com/vibery-studio/gws-mcp/security/advisories/new. Do not open a public issue.

Include the affected mode (local or remote), the version (`gws-mcp --version` or `/version`), the steps to reproduce, and the impact. Never include real tokens, client secrets or account data. Fixes go into the latest release only.

## What gws-mcp protects

gws-mcp holds OAuth refresh tokens for your Google accounts, and the OAuth client secret you created. With these, an AI app can read and change your Gmail, Drive, Calendar, Sheets, Docs, Forms, Tasks and Slides data, within the scopes you granted. The main assets are therefore the tokens and the secret, followed by the integrity of writes (nothing is changed that the AI app did not apply) and the separation between accounts and between AI apps.

## Threat model summary

| Threat | Mitigation |
|---|---|
| A snippet (prompt-injected or buggy) tries to steal credentials or reach the network | The sandbox's only globals are `sdk` and `console`, with no network and no environment: a Dynamic Worker with no outbound access (remote), or QuickJS in a worker thread with an empty env (local). Tokens are attached host-side and never enter the sandbox. Token-shaped text in console output and errors is redacted. |
| A snippet exhausts resources | Host-side caps on CPU, wall time, memory, calls per execute, input size, response size and rate. Local runs also have a JSON node and depth cap, and a cap on concurrent sandboxes. |
| An AI app writes without the user knowing | Writes are dry runs that return a plan, until the snippet is re-run with `apply: true`. Deletes and public shares are flagged as destructive. Writes are never retried automatically. Whether the user is asked between the two steps is up to the AI app. |
| An AI app reaches an account it was not given (remote) | MCP clients sign in through OAuth 2.1 on the server's consent page. Each client has an allowlist of accounts, checked on every call. Connecting a new account never widens an existing client's access, and revoking a client takes effect on its next request. |
| Theft of the database | Refresh tokens are encrypted with AES-GCM. The key is a Worker secret (remote), or is held in the OS keychain (local). The local key-file option is mode 600 and is reported as weaker. The audit log holds metadata only, never bodies or file contents. |
| Interception of the local sign-in | The loopback listener binds 127.0.0.1 only (plus `[::1]` for a fixed-port Web client). It uses PKCE (S256), a single-use state compared in constant time, an exact Host check and a one-time, browser-bound start link. It closes when the flow ends. A returned account that differs from the one requested is refused and its grant revoked. |
| Secrets leaking through the shell or the logs | Client IDs, secrets and keys are read from a hidden prompt or from stdin, never from command-line arguments, and are never printed. The local config files are mode 600, in a mode-700 folder. |
| Cross-site attacks on the remote pages | Same-origin form posts with CSRF checks, escaped output, a strict CSP with no inline scripts, `__Host-` cookies, and per-IP limits on sign-in and client registration. |

## Out of scope, by design

- **Local mode trusts your OS account.** Anything that runs as you can read the config folder and ask the keychain for the key. Local mode has no per-app permissions: the AI app that starts `gws-mcp serve` uses every connected account.
- **Results are not redacted.** Whatever Google returns for the scopes you granted can reach the AI app.
- **Google-side risks** are outside this project: an unverified OAuth app, testing-mode token expiry, and scope approval. See [docs/self-host-google-client.md](docs/self-host-google-client.md).
