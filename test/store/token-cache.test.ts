import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isGwsError, toWire } from "../../src/errors";
import { googleOAuth, type Transport } from "../../src/google/oauth";
import { omitSecrets } from "../../src/runtime/workers/env";
import { openStore, type Account } from "../../src/store/db";
import { getAccessToken, invalidate } from "../../src/store/token-cache";
import { authorizeAtFake, fakeTransport, recordingTransport, seedUserWithAccount, stringViews } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const GMAIL_RO = "https://www.googleapis.com/auth/gmail.readonly";
const TOKEN_URL = "POST https://oauth2.googleapis.com/token";
const TOKEN_PATH = "/oauth2.googleapis.com/token";

const store = openStore(env);

async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (!isGwsError(e)) throw e;
    return e;
  }
  throw new Error("expected a rejection");
}

async function cacheEntry(accountId: string): Promise<{ value: string | null; expiration?: number }> {
  const key = `at:${accountId}`;
  const listed = await env.CACHE_KV.list({ prefix: key });
  const meta = listed.keys.find((k) => k.name === key);
  const out: { value: string | null; expiration?: number } = { value: await env.CACHE_KV.get(key) };
  if (meta?.expiration !== undefined) out.expiration = meta.expiration;
  return out;
}

/** Answers token calls with a canned short-lived token; everything else goes to the fake. */
function shortLivedTokens(expiresIn: number): Transport {
  return async (url, init) => {
    if (new URL(url).pathname === "/token") {
      return Response.json({ access_token: `ya29.short-${crypto.randomUUID()}`, expires_in: expiresIn, token_type: "Bearer" });
    }
    return fakeTransport(url, init);
  };
}

/** The account as `accounts.get` reads it now; tests pass a fresh one per call, as the dispatcher must. */
async function current(a: Account): Promise<Account> {
  const fresh = await store.accounts.get(a.userId, a.id);
  if (!fresh) throw new Error("account missing");
  return fresh;
}

describe("access token cache", () => {
  it("refreshes once, then serves the cached token (a single token call at the fake)", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("tc-hit"), scopes: [GMAIL_RO] });
    const before = (await fake.requests(s.account.email)).filter((r) => r.path === TOKEN_PATH).length;
    const { transport, calls } = recordingTransport();
    const first = await getAccessToken(env, s.account, transport);
    const second = await getAccessToken(env, s.account, transport);
    expect(first.startsWith("ya29.")).toBe(true);
    expect(second).toBe(first);
    expect(calls).toEqual([TOKEN_URL]);
    const after = (await fake.requests(s.account.email)).filter((r) => r.path === TOKEN_PATH).length;
    expect(after - before).toBe(1);
  });

  it("stores only ciphertext in KV: no access token, no refresh token", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("tc-kv"), scopes: [GMAIL_RO] });
    const access = await getAccessToken(env, s.account, fakeTransport);
    const { value } = await cacheEntry(s.account.id);
    expect(value).not.toBeNull();
    for (const view of stringViews(value)) {
      expect(view.includes("ya29.")).toBe(false);
      expect(view.includes(access)).toBe(false);
      expect(view.includes("1//")).toBe(false);
      expect(view.includes(s.refreshToken)).toBe(false);
    }
  });

  it("expires the cache entry five minutes before the token does", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("tc-ttl"), scopes: [] });
    const now = Math.floor(Date.now() / 1000);
    await getAccessToken(env, s.account, fakeTransport);
    const { expiration } = await cacheEntry(s.account.id);
    expect(expiration).toBeGreaterThanOrEqual(now + 3600 - 300 - 5);
    expect(expiration).toBeLessThanOrEqual(now + 3600 - 300 + 5);
  });

  it("caps the cache TTL below an hour whatever expires_in claims", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("tc-cap"), scopes: [] });
    const now = Math.floor(Date.now() / 1000);
    await getAccessToken(env, s.account, shortLivedTokens(31_536_000));
    const { expiration } = await cacheEntry(s.account.id);
    expect(expiration).toBeGreaterThanOrEqual(now + 3300 - 5);
    expect(expiration).toBeLessThanOrEqual(now + 3300 + 5);
  });

  it("clamps the cache TTL to KV's 60 second minimum for a short-lived token", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("tc-clamp"), scopes: [] });
    const now = Math.floor(Date.now() / 1000);
    await getAccessToken(env, s.account, shortLivedTokens(200));
    const { expiration } = await cacheEntry(s.account.id);
    expect(expiration).toBeGreaterThanOrEqual(now + 60 - 5);
    expect(expiration).toBeLessThanOrEqual(now + 60 + 5);
  });

  it("does not cache a token that is about to expire", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("tc-nocache"), scopes: [] });
    const { transport, calls } = recordingTransport(shortLivedTokens(30));
    await getAccessToken(env, s.account, transport);
    await getAccessToken(env, s.account, transport);
    expect((await cacheEntry(s.account.id)).value).toBeNull();
    expect(calls).toEqual([TOKEN_URL, TOKEN_URL]);
  });

  it("invalidate drops the entry, so the next call refreshes again", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("tc-inval"), scopes: [] });
    const { transport, calls } = recordingTransport();
    await getAccessToken(env, s.account, transport);
    await invalidate(env, s.account.id);
    expect((await cacheEntry(s.account.id)).value).toBeNull();
    await getAccessToken(env, s.account, transport);
    expect(calls).toEqual([TOKEN_URL, TOKEN_URL]);
  });

  it("ignores a cache entry copied from another account and refreshes instead", async () => {
    const a = await seedUserWithAccount(env, { email: uniqueEmail("tc-swap-a"), scopes: [] });
    const b = await seedUserWithAccount(env, { email: uniqueEmail("tc-swap-b"), scopes: [], userId: a.userId });
    const tokenA = await getAccessToken(env, a.account, fakeTransport);
    await env.CACHE_KV.put(`at:${b.account.id}`, (await cacheEntry(a.account.id)).value ?? "");

    const { transport, calls } = recordingTransport();
    const tokenB = await getAccessToken(env, b.account, transport);
    expect(tokenB).not.toBe(tokenA);
    expect(calls).toEqual([TOKEN_URL]);
  });

  it("does not serve an entry to a caller naming another user", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("tc-user"), scopes: [] });
    await getAccessToken(env, s.account, fakeTransport);
    const err = await rejection(getAccessToken(env, { ...s.account, userId: "u_someone-else" }, fakeTransport));
    expect(err.code).toBe("GWS_ACCOUNT_UNKNOWN");
  });
});

describe("revoked grants", () => {
  it("after a revoke at Google and invalidation, marks the account for reconnection and throws without retrying", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("tc-revoked"), scopes: [GMAIL_RO] });
    await getAccessToken(env, s.account, fakeTransport);
    await googleOAuth(env, fakeTransport).revoke(s.refreshToken);
    await invalidate(env, s.account.id);

    const { transport, calls } = recordingTransport();
    const err = await rejection(getAccessToken(env, s.account, transport));
    expect(err.code).toBe("GWS_RECONNECT_REQUIRED");
    expect(calls).toEqual([TOKEN_URL]);
    expect((await current(s.account)).status).toBe("reconnect");
    expect((await cacheEntry(s.account.id)).value).toBeNull();
    const wire = JSON.stringify(toWire(err));
    expect(wire.includes(s.refreshToken)).toBe(false);
    expect(wire.includes("1//")).toBe(false);

    // Later calls fail fast from the stored status, without another token call.
    const again = await rejection(getAccessToken(env, await current(s.account), transport));
    expect(again.code).toBe("GWS_RECONNECT_REQUIRED");
    expect(calls).toEqual([TOKEN_URL]);
  });

  it("drops a cached token when the refresh says the grant is gone", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("tc-stale"), scopes: [] });
    // A stale entry that fails to decrypt is treated as a miss and replaced by a refresh attempt.
    await env.CACHE_KV.put(`at:${s.account.id}`, JSON.stringify({ v: 1, ct: "AAAA", iv: "AAAAAAAAAAAAAAAA" }));
    await googleOAuth(env, fakeTransport).revoke(s.refreshToken);
    expect((await rejection(getAccessToken(env, s.account, fakeTransport))).code).toBe("GWS_RECONNECT_REQUIRED");
    expect((await cacheEntry(s.account.id)).value).toBeNull();
  });
});

describe("account status gates every call", () => {
  it("never serves a cached token for an account marked for reconnection", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("tc-gate-recon"), scopes: [] });
    await getAccessToken(env, s.account, fakeTransport);
    await store.accounts.markStatus(s.userId, s.account.id, "reconnect");
    const { transport, calls } = recordingTransport();
    expect((await rejection(getAccessToken(env, await current(s.account), transport))).code).toBe("GWS_RECONNECT_REQUIRED");
    expect(calls).toEqual([]);
  });

  it("never serves a cached token for a disconnected account, even when the cache entry was not dropped", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("tc-gate-disc"), scopes: [] });
    await getAccessToken(env, s.account, fakeTransport);
    await store.accounts.wipeToken(s.userId, s.account.id);
    expect((await cacheEntry(s.account.id)).value).not.toBeNull();
    const { transport, calls } = recordingTransport();
    expect((await rejection(getAccessToken(env, await current(s.account), transport))).code).toBe("GWS_RECONNECT_REQUIRED");
    expect(calls).toEqual([]);
  });

  it("leaves no usable cache entry when a refresh completes after a disconnect", async () => {
    const s = await seedUserWithAccount(env, { email: uniqueEmail("tc-race"), scopes: [] });
    // The refresh reaches Google first; the whole disconnect then runs before the cache write.
    const disconnectDuringRefresh: Transport = async (url, init) => {
      const res = await fakeTransport(url, init);
      if (new URL(url).pathname === "/token") {
        await googleOAuth(env, fakeTransport).revoke(s.refreshToken);
        await store.accounts.wipeToken(s.userId, s.account.id);
        await invalidate(env, s.account.id);
      }
      return res;
    };
    const raced = await getAccessToken(env, s.account, disconnectDuringRefresh);
    expect((await cacheEntry(s.account.id)).value).not.toBeNull();
    expect((await rejection(getAccessToken(env, await current(s.account), fakeTransport))).code).toBe("GWS_RECONNECT_REQUIRED");

    // Reconnecting the same Google account must not revive the entry written by the raced refresh.
    const fresh = await googleOAuth(env, fakeTransport).exchangeCode(await authorizeAtFake({ email: s.account.email, scopes: ["openid"] }));
    const back = await store.accounts.upsertConnected({
      userId: s.userId,
      email: s.account.email,
      sub: s.sub,
      scopes: fresh.scopes,
      refreshToken: fresh.refreshToken,
    });
    expect(back.status).toBe("active");
    const { transport, calls } = recordingTransport();
    const next = await getAccessToken(env, back, transport);
    expect(next).not.toBe(raced);
    expect(calls).toEqual([TOKEN_URL]);
  });
});

describe("token cache env type", () => {
  it("does not accept the secret-stripped host env", () => {
    const host = omitSecrets(env);
    // Never invoked: the assertion is the compile error below.
    const call = (a: Account) =>
      // @ts-expect-error the token cache needs the secrets the host env deliberately lacks
      getAccessToken(host, a, fakeTransport);
    expect(typeof call).toBe("function");
  });
});
