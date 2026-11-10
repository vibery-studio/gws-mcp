import { env } from "cloudflare:workers";
import { googleOAuth, type Transport } from "../../src/google/oauth";
import { openStore, type Account } from "../../src/store/db";
import { FAKE_ORIGIN, fake, fakeFetch } from "./fake";

/**
 * Test transport for `fake` upstream mode: rewrites `https://{host}/{path}?q` onto the FAKE_GOOGLE
 * service binding, the same mapping the production transport uses.
 */
export const fakeTransport: Transport = (url, init) => {
  const u = new URL(url);
  return env.FAKE_GOOGLE.fetch(`${FAKE_ORIGIN}/${u.host}${u.pathname}${u.search}`, { ...init, redirect: "manual" });
};

/** Wraps a transport and records each call as "METHOD https://host/path". */
export function recordingTransport(inner: Transport = fakeTransport): { transport: Transport; calls: string[] } {
  const calls: string[] = [];
  const transport: Transport = (url, init) => {
    const u = new URL(url);
    calls.push(`${init?.method ?? "GET"} ${u.origin}${u.pathname}`);
    return inner(url, init);
  };
  return { transport, calls };
}

export interface AuthorizeOptions {
  email: string;
  scopes: readonly string[];
  /**
   * Drops `prompt=consent`, the way a returning user re-consents without it. Google (and the fake)
   * then answers the code exchange without a refresh token.
   */
  withoutConsentPrompt?: boolean;
}

/** Runs the account picker at the fake with the URL `buildAuthUrl` produced; returns a fresh code. */
export async function authorizeAtFake(opts: AuthorizeOptions): Promise<{ code: string; codeVerifier: string }> {
  const codeVerifier = randomVerifier();
  const authUrl = new URL(
    googleOAuth(env, fakeTransport).buildAuthUrl({
      scopes: opts.scopes,
      state: `st-${crypto.randomUUID()}`,
      codeChallenge: await s256(codeVerifier),
      loginHint: opts.email,
    }),
  );
  const params = authUrl.searchParams;
  if (opts.withoutConsentPrompt) params.delete("prompt");
  const res = await fakeFetch(`${authUrl.pathname}/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(params), email: opts.email, decision: "allow" }).toString(),
  });
  const location = res.headers.get("location");
  if (res.status !== 302 || !location) throw new Error(`fake approve failed: ${res.status}`);
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("fake approve returned no code");
  return { code, codeVerifier };
}

export interface SeedOptions {
  email: string;
  /** Google scopes to grant; `openid email` are added for the userinfo call. */
  scopes: readonly string[];
  alias?: string;
  /** true: make it the default. false: leave the user with no default. Omitted: the store's rule applies. */
  isDefault?: boolean;
  /** Attach the account to this existing user instead of creating a new one. */
  userId?: string;
}

export interface SeededAccount {
  userId: string;
  account: Account;
  sub: string;
  /** Plaintext fake refresh token, for tests that revoke it at the fake. Never stored in plaintext. */
  refreshToken: string;
}

/**
 * Seeds a fake Google account, obtains a real fake refresh token through the code exchange and stores
 * it through `upsertConnected`, so the row holds real ciphertext rather than hand-written values.
 */
export async function seedUserWithAccount(testEnv: Env, opts: SeedOptions): Promise<SeededAccount> {
  const sub = `${Date.now()}${Math.floor(Math.random() * 1e9)}`;
  await fake.seed({ accounts: [{ email: opts.email, sub }] });
  const oauth = googleOAuth(testEnv, fakeTransport);
  const grant = await authorizeAtFake({ email: opts.email, scopes: ["openid", "email", ...opts.scopes] });
  const tokens = await oauth.exchangeCode(grant);
  if (!tokens.refreshToken) throw new Error("fake issued no refresh token on a first consent");
  const who = await oauth.userinfo(tokens.accessToken);

  const store = openStore(testEnv);
  const userId = opts.userId ?? (await store.users.create({ sub: who.sub, email: who.email })).id;
  let account = await store.accounts.upsertConnected({
    userId,
    email: who.email,
    sub: who.sub,
    scopes: tokens.scopes,
    refreshToken: tokens.refreshToken,
  });
  if (opts.alias !== undefined) account = await store.accounts.setAlias(userId, account.id, opts.alias);
  if (opts.isDefault === true) account = await store.accounts.setDefault(userId, account.id);
  if (opts.isDefault === false && account.isDefault) {
    // Test-only state with no default account; the store has no "unset default" operation.
    await testEnv.DB.prepare("UPDATE accounts SET is_default = 0 WHERE id = ? AND user_id = ?").bind(account.id, userId).run();
    account = { ...account, isDefault: false };
  }
  return { userId, account, sub: who.sub, refreshToken: tokens.refreshToken };
}

/**
 * A stored string plus the decoding of each base64-looking run inside it, so a leak scan sees through
 * both a base64 encoding and embedding in a longer value.
 */
export function stringViews(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const out = [value];
  for (const run of value.match(/[A-Za-z0-9+/]{8,}={0,2}/g) ?? []) {
    const body = run.replace(/=+$/, "");
    try {
      out.push(atob(body.slice(0, body.length - (body.length % 4))));
    } catch {
      // not base64 after all
    }
  }
  return out;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
