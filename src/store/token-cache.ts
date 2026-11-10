import { z } from "zod";
import { GwsError, isGwsError } from "../errors";
import { googleOAuth, type OAuthEnv, type Transport } from "../google/oauth";
import { KEY_VERSION, decrypt, encrypt, importKey, tokenAad } from "./crypto";
import { openStore, type Account, type StoreEnv } from "./db";

export type TokenCacheEnv = StoreEnv & OAuthEnv & { readonly CACHE_KV: KVNamespace };

/** KV's minimum `expirationTtl`. */
const MIN_TTL_S = 60;
/** Upper bound on a cache entry's life, whatever `expires_in` claims (Google issues 3600 s tokens). */
const MAX_TTL_S = 3300;
/** Cache entries expire this long before Google's expiry. */
const EARLY_EXPIRY_S = 300;
/** Never hand out a token in its last minute of life. */
const SAFETY_S = 60;

const CacheValue = z.object({ v: z.literal(KEY_VERSION), ct: z.string(), iv: z.string() });
/** `g` is the account's token generation when the entry was written. */
const CachePlain = z.object({ t: z.string().min(1), exp: z.number(), g: z.string().min(1) });

const cacheKey = (accountId: string) => `at:${accountId}`;

/**
 * The cached access token, or undefined on a miss, expiry, an entry written under another token
 * generation, or an entry that fails to authenticate.
 */
async function readCache(env: TokenCacheEnv, key: CryptoKey, account: Account, generation: string): Promise<string | undefined> {
  const raw = await env.CACHE_KV.get(cacheKey(account.id));
  if (raw === null) return undefined;
  try {
    const sealed = CacheValue.parse(JSON.parse(raw));
    const plain = await decrypt(key, sealed, tokenAad("access", { userId: account.userId, accountId: account.id, keyVersion: sealed.v }));
    const entry = CachePlain.parse(JSON.parse(plain));
    return entry.exp > Date.now() && entry.g === generation ? entry.t : undefined;
  } catch {
    // Foreign, stale or tampered entries are a miss; the refresh below overwrites them.
    return undefined;
  }
}

async function writeCache(
  env: TokenCacheEnv,
  key: CryptoKey,
  account: Account,
  generation: string,
  token: string,
  expiresIn: number,
): Promise<void> {
  const usable = expiresIn - SAFETY_S;
  if (usable <= 0) return;
  const ttl = Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, expiresIn - EARLY_EXPIRY_S));
  const plain = JSON.stringify({ t: token, exp: Date.now() + Math.min(ttl, usable) * 1000, g: generation });
  const aad = tokenAad("access", { userId: account.userId, accountId: account.id, keyVersion: KEY_VERSION });
  const sealed = await encrypt(key, plain, aad);
  await env.CACHE_KV.put(cacheKey(account.id), JSON.stringify({ v: KEY_VERSION, ...sealed }), { expirationTtl: ttl });
}

/**
 * Returns a short-lived Google access token for the account: from the encrypted KV cache, else by
 * refreshing with the stored refresh token.
 *
 * `account` must come from D1 (`accounts.resolve` or `get`) in the same call; never cache an Account
 * across calls. D1 stays the authority: an account that is not `active` fails with
 * GWS_RECONNECT_REQUIRED even on a cache hit, and entries are bound to the account's token
 * generation, so a refresh that lands after a disconnect leaves nothing a later reconnect can serve.
 * A revoked or expired grant marks the account `reconnect`, drops the cache entry and fails with
 * GWS_RECONNECT_REQUIRED; it is never retried.
 * Host-internal: the returned token must never reach a snippet, log or error.
 */
export async function getAccessToken(env: TokenCacheEnv, account: Account, transport: Transport): Promise<string> {
  const generation = account.tokenGeneration;
  if (account.status !== "active" || generation === null) {
    throw new GwsError("GWS_RECONNECT_REQUIRED", "this account must be reconnected", { account: account.email });
  }
  const key = await importKey(env);
  const cached = await readCache(env, key, account, generation);
  if (cached !== undefined) return cached;

  const store = openStore(env);
  const refreshToken = await store.accounts.getRefreshToken(account.userId, account.id);
  let tokens;
  try {
    tokens = await googleOAuth(env, transport).refresh(refreshToken);
  } catch (e) {
    if (isGwsError(e) && e.code === "GWS_RECONNECT_REQUIRED") {
      await invalidate(env, account.id);
      await store.accounts.markStatus(account.userId, account.id, "reconnect");
    }
    throw e;
  }
  await writeCache(env, key, account, generation, tokens.accessToken, tokens.expiresIn);
  return tokens.accessToken;
}

/** Drops the cached access token of an account (disconnect, reconnect, revoke). */
export async function invalidate(env: { readonly CACHE_KV: KVNamespace }, accountId: string): Promise<void> {
  await env.CACHE_KV.delete(cacheKey(accountId));
}
