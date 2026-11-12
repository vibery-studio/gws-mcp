# Your own Google OAuth client

gws-mcp has no shared Google app. You create an OAuth client in your own Google Cloud project, and your accounts grant access to that client only. This takes about ten minutes in the [Google Cloud console](https://console.cloud.google.com/).

## 1. Project and APIs

Create a project, or choose an existing one. Then enable, under **APIs & Services → Library**, the APIs you will use:
- **The original services:** Gmail API, Google Drive API, Google Calendar API, Google Sheets API, Google Docs API, Google Forms API, Google Tasks API and Google Slides API.
- **The marketing and admin services:** Search Console API, Google Analytics Data API, Google Analytics Admin API, Google Ads API, Admin SDK API, Groups Settings API and Tag Manager API.

Enable only the APIs of the services you will connect. A service whose API is off fails with a Google error that says the API has not been used or is disabled in your project; enable it, wait a minute, and try again. The Calendar API also serves the calendar helpers (sharing, free time, replies, moving events), and the Admin SDK API serves Google Groups only.

## 2. Consent screen

Open **Google Auth Platform** (formerly the OAuth consent screen):

- **Branding:** an app name and your support email.
- **Audience:**
  - **External** works for any Google account.
  - **Internal** is available only inside a Google Workspace organization. It limits sign-in to that organization, and needs neither test users nor verification.
- **Test users** (External, Testing): add every Google account you will connect.

You don't need to list scopes on the consent screen. gws-mcp asks for them per service when you connect an account.

## 3. Create the client

Go to **Clients → Create client**, then copy the client ID and secret. gws-mcp asks for them on a hidden prompt, or reads them as two lines on stdin. Never pass them as arguments.

| Mode | Application type | Authorized redirect URI to register | gws-mcp setup |
|---|---|---|---|
| Local (recommended) | **Desktop app** | none: gws-mcp uses `http://127.0.0.1:<random port>/google/callback`, which Google allows for Desktop clients | `gws-mcp setup` |
| Local, fixed port | **Web application** | `http://localhost:<port>/google/callback` (port 8787 by default) | `gws-mcp setup --client web --port <port>` |
| Remote (Cloudflare) | **Web application** | `https://<your host>/google/callback`, printed by `npm run setup` | `npm run setup` |
| Remote, `npm run dev` | **Web application** | `http://localhost:8787/google/callback` | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.dev.vars` |

Above, `gws-mcp` stands for however you run the CLI, for example `npx -y @bnqtoan/gws-mcp`.

The redirect URI must match exactly: scheme, host, port and path. A mismatch shows Google's `redirect_uri_mismatch` error.

One Web client can hold several redirect URIs, for example your Worker's URI and `localhost:8787` for development.

## 4. Testing or In production

The **Audience** page sets the publishing status:

- **Testing:**
  - Only the listed test users (up to 100) can connect.
  - **Refresh tokens expire after 7 days.** After that, calls fail with a reconnect error. Reconnect with `gws-mcp accounts add --account <email>` (local), or with the account's Connect button on `/accounts` (remote).
- **In production, unverified:**
  - Tokens no longer expire after 7 days.
  - Users see Google's "Google hasn't verified this app" screen, and continue through **Advanced**.
  - An unverified app is capped at 100 users.

  For your own accounts, this is the usual choice.
- **In production, verified:** this needs Google's review (below). It is needed only if you offer your client to people outside your control.

## 5. Scopes, and the restricted ones

gws-mcp asks only for the scopes of the services you connect, and adds scopes to an account later without dropping the ones it has. Two presets exist. Choose one with `gws-mcp setup --preset narrow|full` (local), or `GOOGLE_SCOPE_PRESET` in `wrangler.jsonc` (remote). The default is `narrow`.

| Service | narrow | full |
|---|---|---|
| Gmail | `gmail.readonly` (restricted), `gmail.send` | `https://mail.google.com/` (restricted) |
| Drive | `drive.file` (only files the app created or opened) | `drive` (restricted) |
| Calendar | `calendar.events`, `calendar.calendarlist.readonly` | `calendar` |
| Sheets, Docs, Slides | `spreadsheets`, `documents`, `presentations` | same |
| Forms | `forms.body`, `forms.responses.readonly` | same |
| Tasks | `tasks` | same |
| Search Console | `webmasters.readonly` | `webmasters` (also adds and removes sites and sitemaps) |
| Analytics | `analytics.readonly` | same |
| Analytics (edit) | `analytics.edit` | same |
| Google Ads | `adwords` | same |
| Google Groups | `admin.directory.group.readonly`, `admin.directory.group.member.readonly`, `apps.groups.settings` | `admin.directory.group`, `admin.directory.group.member`, `apps.groups.settings` |
| Tag Manager (read) | `tagmanager.readonly` | same |
| Tag Manager (edit) | `tagmanager.edit.containers` | same |
| Tag Manager (publish) | `tagmanager.edit.containerversions`, `tagmanager.publish` | same |
| Tag Manager (admin) | `tagmanager.manage.accounts`, `tagmanager.manage.users`, `tagmanager.delete.containers` | same |

A first sign-in, "Add Google account" and `accounts add` without `--services` connect only these services: Gmail, Drive, Calendar, Sheets, Docs, Forms, Tasks, Slides, Search Console, Analytics and Tag Manager (read). Google Ads (it can spend money), Google Groups (Workspace admins only), Analytics (edit) and the Tag Manager edit, publish and admin levels are added to an account on purpose: on its Google services page (remote), or with `accounts add --services <list> --account <email>` (local).

The calendar helpers for sharing a calendar and finding free time need the `calendar` scope, so they work with the `full` preset. The `narrow` preset's calendar scopes do not cover them.

An account connected by an older build's first sign-in may hold scopes you did not choose, because that sign-in asked for every service. To drop them, Disconnect the account (remote: `/accounts`; local: `accounts disconnect <account> --yes`), which revokes the grant at Google, and connect it again for the services you want. You can also remove gws-mcp at https://myaccount.google.com/permissions and connect again.

Restricted scopes (Gmail read access, and full Drive) need Google's verification **plus a yearly third-party security assessment** before an app can be offered to the public. They work without either for test users in Testing, for your own accounts in unverified production (with the warning screen), and for Internal apps. The other scopes above are sensitive (verification only) or, for `drive.file`, not sensitive.

## 6. Google Ads developer token

Google Ads also needs a developer token, which Google issues to your Google Ads manager account (Google Ads → Admin → API Center). It is not part of the OAuth client and is never set in code, environment variables or `wrangler.jsonc`:
- **Remote:** save it on the account's page at `/accounts/<id>` (Google Ads is shown once the account is connected for it). The page calls it the developer code and never shows it again.
- **Local:** `gws-mcp settings set ads.developer_token --stdin`; an optional manager account ID goes in `settings set ads.login_customer_id`.
- It is stored encrypted in your own D1 database or SQLite file, with the key that protects refresh tokens, and applies to every Google account the same person connects for Google Ads. It reaches Google only in the Ads requests the server makes. An AI app can ask whether one is set, never read it, and cannot save one from a chat.
- Until it is saved, Ads calls fail with `GWS_ADS_DEVELOPER_TOKEN_MISSING`.

## Troubleshooting

- **`redirect_uri_mismatch`:** register the exact URI from the table above. For the Web client, check the port.
- **`access_denied`, or "has not completed the Google verification process":** add the account as a test user, or move the app to In production.
- **A reconnect error after about a week:** the app is in Testing, so the refresh token expired (section 4).
- **`GWS_ADMIN_REQUIRED` on Google Groups:** "Google Groups works only for a Google Workspace admin. Personal Gmail accounts and Workspace users who are not admins can't use it; connect an admin account of the organization instead."
- **`GWS_ADS_DEVELOPER_TOKEN_MISSING` or `GWS_SETTING_UNREADABLE`:** save the developer token again (section 6).
- **A scope-missing error on one service:** connect that service, with `gws-mcp accounts add --services <service> --account <email>` (local) or Connect on `/accounts` (remote).
