import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { createFakeGoogle } from "../../fake-google/src/app";
import { MemoryStore } from "../../fake-google/src/store";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, loadConfig, type Config, type ConfigEnv } from "../../src/config";
import type { Account } from "../../src/core/ports";
import { createGoogleOAuth } from "../../src/google/oauth";
import { createTransport } from "../../src/google/transport";
import { ensurePrivateDir } from "../../src/local/paths";
import { openSecrets, type Keyring, type LocalSecrets } from "../../src/local/secrets";
import { LOCAL_USER_ID, openLocalStore, type LocalStore } from "../../src/local/store";

/** Where the fake Google "listens" in these tests. Nothing listens there: `fetch` is routed in-process. */
export const FAKE_URL = "http://127.0.0.1:9";
export const PUBLIC_BASE_URL = "http://localhost:8787";

export function localConfig(overrides: ConfigEnv = {}): Config {
  return loadConfig({ GOOGLE_UPSTREAM: "fake", PUBLIC_BASE_URL, FAKE_GOOGLE_PUBLIC_URL: FAKE_URL, ...overrides });
}

/** A fresh private temp directory and its removal. */
export function tempDir(): { dir: string; cleanup: () => void } {
  const base = mkdtempSync(path.join(os.tmpdir(), "gws-mcp-local-"));
  return { dir: path.join(base, "config"), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** An in-memory keyring: tests never touch the real keychain. */
export function memoryKeyring(): Keyring & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  const k = (s: string, a: string) => `${s}\u0000${a}`;
  return {
    entries,
    get: async (s, a) => entries.get(k(s, a)) ?? null,
    set: async (s, a, v) => void entries.set(k(s, a), v),
    delete: async (s, a) => entries.delete(k(s, a)),
  };
}

/** A keyring whose every call fails, like a Linux desktop without a Secret Service. */
export function brokenKeyring(): Keyring {
  const fail = () => Promise.reject(new Error("org.freedesktop.secrets was not provided by any .service files"));
  return { get: fail, set: fail, delete: fail };
}

export interface FakeGoogle {
  handler: (req: Request) => Promise<Response>;
  /** Every request that reached the fake, as "METHOD /host/path". */
  seen: string[];
}

/**
 * An in-process fake Google, reached through a stubbed global `fetch` at FAKE_URL (any other URL is refused, so a
 * test can never call real Google). Undo with `vi.unstubAllGlobals()`.
 */
export function stubFakeGoogle(opts: { anyRedirectUri?: boolean } = {}): FakeGoogle {
  const handler = createFakeGoogle({
    store: new MemoryStore(),
    signingKey: "gws-mcp-local-test-signing-key",
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    // A Desktop client's loopback redirect has a random port, so a fake for it accepts any redirect URI.
    ...(opts.anyRedirectUri === true ? {} : { redirectUris: [`${PUBLIC_BASE_URL}/google/callback`] }),
  });
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== FAKE_URL) throw new Error(`test fetch refused: ${url.origin}`);
    seen.push(`${req.method} ${url.pathname}`);
    return handler(new Request(`http://fake-google${url.pathname}${url.search}`, req));
  });
  return { handler, seen };
}

/** Opens secrets (memory keyring, fresh key) and the store in `dir`. */
export async function openLocal(dir: string, upstream: "fake" | "google" = "fake"): Promise<{ secrets: LocalSecrets; store: LocalStore; keyring: ReturnType<typeof memoryKeyring> }> {
  const keyring = memoryKeyring();
  ensurePrivateDir(dir);
  const secrets = await openSecrets({ dir, keyring: { keyring } });
  await secrets.ensureEncryptionKey();
  const store = openLocalStore({ dir, upstream, secrets: secrets.source, redactor: secrets.redactor });
  return { secrets, store, keyring };
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Connects `email` at the fake as the local user: seed, consent (approve), code exchange, userinfo, then the
 * store's upsert. Returns the account and its plaintext refresh token (for leak checks only).
 */
export async function connectAtFake(
  fake: FakeGoogle,
  config: Config,
  store: LocalStore,
  email: string,
  scopes: readonly string[],
  sub = `${Date.now()}${Math.floor(Math.random() * 1e9)}`,
): Promise<{ account: Account; refreshToken: string; sub: string }> {
  const control = await fake.handler(
    new Request("http://fake-google/__fake/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accounts: [{ email, sub }] }),
    }),
  );
  if (!control.ok) throw new Error(`fake seed failed: ${control.status}`);
  const send = createTransport({ FAKE_GOOGLE: { fetch: (u, init) => fake.handler(new Request(u, init)) } }, config);
  const oauth = createGoogleOAuth(config, { get: () => undefined }, send);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const authUrl = new URL(oauth.buildAuthUrl({ scopes: ["openid", "email", ...scopes], state: "st-local", codeChallenge: challenge, loginHint: email }));
  const approve = await fake.handler(
    new Request(`http://fake-google${authUrl.pathname}/approve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...Object.fromEntries(authUrl.searchParams), email, decision: "allow" }).toString(),
      redirect: "manual",
    }),
  );
  const code = new URL(approve.headers.get("location") ?? "http://x/").searchParams.get("code");
  if (approve.status !== 302 || !code) throw new Error(`fake approve failed: ${approve.status}`);
  const tokens = await oauth.exchangeCode({ code, codeVerifier: verifier });
  if (!tokens.refreshToken) throw new Error("the fake issued no refresh token");
  const who = await oauth.userinfo(tokens.accessToken);
  const account = await store.accounts.upsertConnected({
    userId: LOCAL_USER_ID,
    email: who.email,
    sub: who.sub,
    scopes: tokens.scopes,
    refreshToken: tokens.refreshToken,
  });
  return { account, refreshToken: tokens.refreshToken, sub };
}
