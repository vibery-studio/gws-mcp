// A browser plus an MCP OAuth client, driving gws-mcp and the fake Google the way a person and an app would:
// a manual cookie jar, no automatic redirects, the fake's account picker (with its login secret), the consent
// page, the forms of the Google accounts and AI apps pages (session, Origin and CSRF; they post to the
// /connections/* actions), and the client's DCR + PKCE + token exchange.

/** Thrown when a step of a flow does not go as a real browser or client would expect. */
export class FlowError extends Error {
  override name = "FlowError";
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken();
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

const unescapeHtml = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The value of a hidden form field, or undefined. */
export function hiddenField(page: string, name: string): string | undefined {
  const m = new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`).exec(page);
  return m?.[1] === undefined ? undefined : unescapeHtml(m[1]);
}

function location(res: Response, what: string): string {
  const loc = res.headers.get("location");
  if (res.status < 300 || res.status > 399 || !loc) throw new FlowError(`${what}: expected a redirect, got ${res.status}`);
  return loc;
}

/** A browser on one origin: keeps cookies by name, follows nothing on its own. */
export class Browser {
  readonly cookies = new Map<string, string>();

  constructor(readonly base: string) {}

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url, this.base);
    const headers = new Headers(init.headers);
    // Cookies belong to this origin only; the fake is another origin and gets none.
    if (target.origin === new URL(this.base).origin && this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const res = await fetch(target, { ...init, headers, redirect: "manual" });
    if (target.origin === new URL(this.base).origin) {
      for (const line of res.headers.getSetCookie()) {
        const [pair = "", ...attrs] = line.split(";");
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "") this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    }
    return res;
  }

  /** A same-origin form POST, as a browser sends it (with this site's Origin). */
  postForm(path: string, fields: Array<[string, string]>): Promise<Response> {
    return this.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(this.base).origin },
      body: new URLSearchParams(fields).toString(),
    });
  }

  /** Cookie values (secrets for evidence redaction). */
  cookieValues(): string[] {
    return [...this.cookies.values()];
  }
}

// ---------- fake Google ----------

export interface FakeSecrets {
  adminToken: string;
  loginSecret: string;
}

/** The fake's admin API (`/__fake/*`, admin header) and its account picker. */
export class FakeGoogle {
  constructor(
    readonly base: string,
    private readonly secrets: FakeSecrets,
  ) {}

  async #control(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(new URL(path, this.base), {
      method,
      headers: { "x-fake-admin": this.secrets.adminToken, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new FlowError(`fake ${method} ${path.split("?")[0]}: ${res.status}`);
    return JSON.parse(text) as unknown;
  }

  seed(body: unknown): Promise<unknown> {
    return this.#control("POST", "/__fake/seed", body);
  }

  fault(body: unknown): Promise<unknown> {
    return this.#control("POST", "/__fake/faults", body);
  }

  async requests(email: string): Promise<Array<{ ts: number; method: string; path: string }>> {
    const out = (await this.#control("GET", `/__fake/requests?email=${encodeURIComponent(email)}`)) as { requests?: unknown };
    return Array.isArray(out.requests) ? (out.requests as Array<{ ts: number; method: string; path: string }>) : [];
  }

  async state(email: string): Promise<{ resources: Record<string, unknown>; grants: Record<string, string[]> }> {
    return (await this.#control("GET", `/__fake/state?email=${encodeURIComponent(email)}`)) as {
      resources: Record<string, unknown>;
      grants: Record<string, string[]>;
    };
  }

  /** Status of a control route called without the admin header (must be refused). */
  async unauthenticatedControlStatus(): Promise<number> {
    const res = await fetch(new URL("/__fake/state?email=nobody%40fake.test", this.base));
    await res.body?.cancel();
    return res.status;
  }

  /**
   * Proves the target is a deployed-shape fake before any secret goes to it: its control route, called without
   * the admin header, must answer 401. Anything else (a 404 from some other Worker, a fake without an admin
   * token, a network error) throws, and no admin or login secret has been sent. Returns the status.
   */
  async requireGuarded(): Promise<number> {
    const status = await this.unauthenticatedControlStatus();
    if (status !== 401) throw new FlowError(`the fake's control route without the admin header returned ${status}, not 401; no secret was sent`);
    return status;
  }

  /**
   * The account picker: loads the page Google's auth URL points to (it must ask for the login secret), then
   * approves as `email`. Returns the callback URL the fake redirects to.
   */
  async pick(authUrl: string, email: string): Promise<string> {
    const url = new URL(authUrl);
    if (url.origin !== new URL(this.base).origin) throw new FlowError("the auth URL does not point at the fake Google");
    const page = await fetch(url, { redirect: "manual" });
    const html = await page.text();
    if (page.status !== 200 || !html.includes('name="login_secret"')) throw new FlowError(`fake picker page: ${page.status}`);
    const res = await fetch(new URL(`${url.pathname}/approve`, this.base), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...Object.fromEntries(url.searchParams),
        email,
        decision: "allow",
        login_secret: this.secrets.loginSecret,
      }).toString(),
    });
    await res.body?.cancel();
    return location(res, "fake picker approve");
  }
}

// ---------- gws-mcp web flows ----------

/** True when a gws-mcp response sends the browser to the fake Google. */
function toFake(res: Response, fake: FakeGoogle): boolean {
  const loc = res.headers.get("location");
  return res.status === 302 && loc !== null && new URL(loc, "http://relative.invalid").origin === new URL(fake.base).origin;
}

/**
 * Completes a Google round trip that `res` started: picks `email` at the fake and lands on the gws-mcp
 * callback. A first sign-in continues straight into connecting the account, which is completed as the same
 * account. Returns the last gws-mcp response.
 */
export async function completeGoogle(browser: Browser, fake: FakeGoogle, res: Response, email: string): Promise<Response> {
  let current = res;
  for (let hop = 0; hop < 2 && toFake(current, fake); hop++) {
    await current.body?.cancel();
    const callback = await fake.pick(location(current, "to Google"), email);
    if (new URL(callback).origin !== new URL(browser.base).origin) throw new FlowError("the fake redirected outside gws-mcp");
    current = await browser.fetch(callback);
  }
  return current;
}

/** Signs in (and on a first sign-in, connects) as `email`; returns where gws-mcp sent the browser. */
export async function signIn(browser: Browser, fake: FakeGoogle, email: string): Promise<string> {
  const res = await completeGoogle(browser, fake, await browser.fetch("/login"), email);
  await res.body?.cancel();
  return location(res, "sign-in callback");
}

/** A signed-in page (200) and the session's CSRF token, which every form on it carries. */
export async function signedInPage(browser: Browser, path: string): Promise<{ html: string; csrf: string }> {
  const res = await browser.fetch(path);
  const html = await res.text();
  const csrf = hiddenField(html, "csrf");
  if (res.status !== 200 || !csrf) throw new FlowError(`${path.split("?")[0]}: ${res.status}`);
  return { html, csrf };
}

/** The Google accounts page and the session's CSRF token. */
export function accountsPage(browser: Browser): Promise<{ html: string; csrf: string }> {
  return signedInPage(browser, "/accounts");
}

/** Where the old management page sends a browser now: its status and Location. */
export async function connectionsRedirect(browser: Browser): Promise<{ status: number; location: string | null }> {
  const res = await browser.fetch("/connections");
  await res.body?.cancel();
  return { status: res.status, location: res.headers.get("location") };
}

/** A /connections action with the session, this site's Origin and the CSRF token (read from Google accounts). Returns the response. */
export async function connectionsPost(browser: Browser, path: string, fields: Array<[string, string]>): Promise<Response> {
  const { csrf } = await accountsPage(browser);
  return browser.postForm(path, [["csrf", csrf], ...fields]);
}

/** The hidden fields of the page's POST form to `action`, in order, or undefined when the page has no such form. */
export function formFields(html: string, action: string): Array<[string, string]> | undefined {
  const escaped = action.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const form = new RegExp(`<form method="post" action="${escaped}"[^>]*>([\\s\\S]*?)</form>`).exec(html)?.[1];
  if (form === undefined) return undefined;
  return [...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m): [string, string] => [m[1] ?? "", unescapeHtml(m[2] ?? "")]);
}

/** Submits the POST form to `action` on the signed-in page `path`, exactly as the page renders it. */
export async function submitPageForm(browser: Browser, path: string, action: string): Promise<{ fields: Array<[string, string]>; res: Response }> {
  const { html } = await signedInPage(browser, path);
  const fields = formFields(html, action);
  if (!fields) throw new FlowError(`${path}: no form posting to ${action}`);
  return { fields, res: await browser.postForm(action, fields) };
}

/**
 * Connects `email` for `services` through the existing connect action. Google accounts must offer it (its
 * "Add another Google account" form posts there); the harness chooses the services itself.
 */
export async function connectFromAccounts(browser: Browser, fake: FakeGoogle, email: string, services: readonly string[]): Promise<string> {
  const { html, csrf } = await accountsPage(browser);
  if (!formFields(html, "/connections/connect")) throw new FlowError("Google accounts offers no way to connect another account");
  const start = await browser.postForm("/connections/connect", [["csrf", csrf], ...services.map((s): [string, string] => ["service", s])]);
  const res = await completeGoogle(browser, fake, start, email);
  await res.body?.cancel();
  return location(res, "connect callback");
}

/** Opens a single-use connect link (from `accounts.connect`) and connects `email`. */
export async function connectFromLink(browser: Browser, fake: FakeGoogle, url: string, email: string): Promise<string> {
  if (new URL(url).origin !== new URL(browser.base).origin) throw new FlowError("the connect link is not on gws-mcp");
  const res = await completeGoogle(browser, fake, await browser.fetch(url), email);
  await res.body?.cancel();
  return location(res, "connect callback");
}

/** Confirms a client's grant request (`accounts.grant` link) for `accountId` on /connections/confirm. */
export async function confirmGrant(browser: Browser, confirmUrl: string, accountId: string): Promise<Response> {
  if (new URL(confirmUrl).origin !== new URL(browser.base).origin) throw new FlowError("the confirm link is not on gws-mcp");
  const page = await browser.fetch(confirmUrl);
  const html = await page.text();
  const csrf = hiddenField(html, "csrf");
  const t = hiddenField(html, "t");
  if (page.status !== 200 || !csrf || !t) throw new FlowError(`confirm page: ${page.status}`);
  if (!html.includes(`name="account" value="${accountId}"`)) throw new FlowError("the confirm page does not offer the account");
  return browser.postForm("/connections/confirm-grant", [
    ["csrf", csrf],
    ["t", t],
    ["decision", "allow"],
    ["account", accountId],
  ]);
}

// ---------- MCP OAuth client ----------

export const CLIENT_REDIRECT = "https://e2e-client.invalid/callback";

export interface ConsentAccount {
  id: string;
  label: string;
  checked: boolean;
}

export interface ConsentPage {
  html: string;
  handle: string;
  csrf: string;
  accounts: ConsentAccount[];
}

export interface ApprovedClient {
  clientId: string;
  accessToken: string;
}

/** Registers a public client by dynamic client registration. */
export async function registerClient(base: string, clientName: string): Promise<string> {
  const res = await fetch(new URL("/oauth/register", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const body = (await res.json()) as { client_id?: unknown };
  if (res.status !== 201 || typeof body.client_id !== "string") throw new FlowError(`client registration: ${res.status}`);
  return body.client_id;
}

export function parseConsent(html: string): ConsentPage {
  const handle = hiddenField(html, "handle");
  const csrf = hiddenField(html, "csrf");
  if (!handle || !csrf) throw new FlowError("the consent page has no form");
  const accounts = [...html.matchAll(/<label><input type="checkbox" name="account" value="([^"]*)"( checked)?> ([^<]*)<\/label>/g)].map((m) => ({
    id: unescapeHtml(m[1] ?? ""),
    label: unescapeHtml(m[3] ?? ""),
    checked: m[2] !== undefined,
  }));
  return { html, handle, csrf, accounts };
}

/** Starts authorization for `clientId` in a signed-in browser and returns the consent page plus the PKCE verifier. */
export async function openConsent(browser: Browser, clientId: string): Promise<{ page: ConsentPage; verifier: string }> {
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    scope: "gws",
    state: randomToken(16),
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: new URL("/mcp", browser.base).toString(),
  });
  const res = await browser.fetch(`/authorize?${q.toString()}`);
  const html = await res.text();
  if (res.status !== 200) throw new FlowError(`consent page: ${res.status}`);
  return { page: parseConsent(html), verifier };
}

/** Approves the consent page for exactly `accountIds` (nothing is pre-checked) and exchanges the code. */
export async function approveConsent(browser: Browser, clientId: string, page: ConsentPage, verifier: string, accountIds: readonly string[]): Promise<ApprovedClient> {
  const approved = await browser.postForm("/authorize", [
    ["handle", page.handle],
    ["csrf", page.csrf],
    ["decision", "approve"],
    ...accountIds.map((id): [string, string] => ["account", id]),
  ]);
  await approved.body?.cancel();
  const redirect = new URL(location(approved, "consent approve"));
  const code = redirect.searchParams.get("code");
  if (redirect.origin + redirect.pathname !== CLIENT_REDIRECT || !code) throw new FlowError("consent approve returned no code");
  const res = await fetch(new URL("/oauth/token", browser.base), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLIENT_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: new URL("/mcp", browser.base).toString(),
    }).toString(),
  });
  const body = (await res.json()) as { access_token?: unknown };
  if (res.status !== 200 || typeof body.access_token !== "string") throw new FlowError(`token exchange: ${res.status}`);
  return { clientId, accessToken: body.access_token };
}

/** Registers, consents for `accountEmails` (picked by email on the page) and returns the client and its token. */
export async function approveClient(browser: Browser, clientName: string, accountEmails: readonly string[]): Promise<ApprovedClient & { page: ConsentPage }> {
  const clientId = await registerClient(browser.base, clientName);
  const { page, verifier } = await openConsent(browser, clientId);
  const ids = accountEmails.map((email) => {
    const found = page.accounts.find((a) => a.label.split(" ")[0] === email);
    if (!found) throw new FlowError("the consent page does not list a requested account");
    return found.id;
  });
  return { ...(await approveConsent(browser, clientId, page, verifier, ids)), page };
}
