# Local-mode E2E

Drives the bundled `gws-mcp` command (the package `bin`) end to end against a fake Google served by this process on `127.0.0.1` (random port).

```bash
npm run build:local && npm run e2e:local
```

- Fresh config folders under the OS temp dir, removed afterwards. `GWS_MCP_NO_KEYCHAIN=1` (key file; the OS keychain is never touched) and `GWS_MCP_NO_BROWSER=1` (the harness plays the browser at the fake consent screen).
- `setup` gets the client ID and secret on stdin. The settings file gets `limits` (`EXECUTE_TIMEOUT_MS=10000`, `CALL_INPUT_MAX_BYTES=2000000`).
- Checks: SETUP (Done 18: setup, `accounts add|list|alias|default`; the loopback flow's one-time start link, browser cookie, state, PKCE and 127.0.0.1 binding; the new-account confirmation and the `--account` match with revoke; the Web-client fixed-port path on 127.0.0.1 and [::1]; the printed invocation is never `npx`), tools/list, Done 3, 4, 5, SERVICES (one read each for Search Console, Analytics data and admin, Tag Manager and Groups, then the Google Ads missing-developer-token error before any request reaches the fake, `settings set ads.developer_token --stdin`, and the Ads read; account a connects those services explicitly), 7, 9, 10, 8 (rate limit in a second config folder with its own counters), and disconnect (revoke at the fake, then `GWS_RECONNECT_REQUIRED`).
- Skipped items are printed (the access list, which local mode does not enforce, client approval, per-client allowlists, HTTP 401, moved-row decryption, real keychain).
- Output: `<CHECK> PASS|FAIL` with evidence, then `SUMMARY <k>/<n> PASS`. Run time is about 1 minute (it may wait for a fresh 60 s rate window).
