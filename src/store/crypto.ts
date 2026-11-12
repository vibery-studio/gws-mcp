import { requireSecret, type SecretName } from "../config";
import { GwsError } from "../errors";

/**
 * Version of the key that seals stored tokens. It is part of every AAD and stored per row
 * (`accounts.key_version`), so a future key rotation can tell old ciphertexts from new ones.
 */
export const KEY_VERSION = 1;

const KEY_BYTES = 32;
const IV_BYTES = 12;
/** Strict standard base64 with canonical padding; anything else is not a key we issued. */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface Sealed {
  /** Base64 AES-GCM ciphertext including the 16-byte tag. */
  ct: string;
  /** Base64 12-byte IV, random per encryption. */
  iv: string;
}

export type TokenKind = "refresh" | "access";

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Decodes strict base64; undefined for anything malformed. */
export function base64ToBytes(text: string): Uint8Array | undefined {
  if (!BASE64_RE.test(text)) return undefined;
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/**
 * Imports `TOKEN_ENC_KEY` as a non-extractable AES-256-GCM key. The secret must base64-decode to
 * exactly 32 bytes; anything else (including the `<generate>` placeholder) fails closed with
 * GWS_INTERNAL naming the secret, never its value.
 */
export async function importKey(env: { readonly [K in SecretName]?: unknown }): Promise<CryptoKey> {
  const raw = base64ToBytes(requireSecret(env, "TOKEN_ENC_KEY").trim());
  if (raw === undefined || raw.length !== KEY_BYTES) {
    throw new GwsError("GWS_INTERNAL", "invalid secret TOKEN_ENC_KEY: must be base64 of exactly 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Additional authenticated data for a stored token. It binds the ciphertext to its purpose, owner,
 * account and key version, so a ciphertext copied to another row, user or purpose fails to decrypt.
 * JSON encoding keeps the fields unambiguous whatever characters the ids contain.
 */
export function tokenAad(kind: TokenKind, ids: { userId: string; accountId: string; keyVersion: number }): string {
  return JSON.stringify([kind, ids.keyVersion, ids.userId, ids.accountId]);
}

/**
 * Additional authenticated data for a stored setting value: purpose, key version, user and setting key, so a value
 * copied to another user, another key, or a token column fails to decrypt.
 */
export function settingAad(ids: { userId: string; key: string; keyVersion: number }): string {
  return JSON.stringify(["setting", ids.keyVersion, ids.userId, ids.key]);
}

export async function encrypt(key: CryptoKey, plaintext: string, aad: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(plaintext),
  );
  return { ct: bytesToBase64(new Uint8Array(ct)), iv: bytesToBase64(iv) };
}

/** Fails with GWS_INTERNAL for a wrong key, wrong AAD, tampering or malformed fields. */
export async function decrypt(key: CryptoKey, sealed: Sealed, aad: string): Promise<string> {
  const ct = base64ToBytes(sealed.ct);
  const iv = base64ToBytes(sealed.iv);
  if (ct === undefined || iv === undefined || iv.length !== IV_BYTES) {
    throw new GwsError("GWS_INTERNAL", "stored token is malformed");
  }
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, ct);
  } catch {
    throw new GwsError("GWS_INTERNAL", "stored token failed to decrypt");
  }
  return dec.decode(plain);
}
