import { describe, expect, it } from "vitest";
import { isGwsError } from "../../src/errors";
import { KEY_VERSION, decrypt, encrypt, importKey, tokenAad } from "../../src/store/crypto";

/** A fresh throwaway AES-256 key, base64 encoded, never used outside this test run. */
function throwawayKey(bytes = 32): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) s += String.fromCharCode(b);
  return btoa(s);
}

async function codeOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    if (!isGwsError(e)) throw e;
    return { code: e.code, message: e.message };
  }
  throw new Error("expected a rejection");
}

const PLAINTEXT = "1//fake-plaintext-refresh-token";
const AAD = tokenAad("refresh", { userId: "u_1", accountId: "a_1", keyVersion: KEY_VERSION });

describe("token encryption key", () => {
  it("imports a base64 key that decodes to exactly 32 bytes", async () => {
    const key = await importKey({ TOKEN_ENC_KEY: throwawayKey() });
    expect(key.algorithm.name).toBe("AES-GCM");
    expect(key.extractable).toBe(false);
  });

  it("fails closed on a missing key without echoing anything", async () => {
    const err = await codeOf(importKey({}));
    expect(err.code).toBe("GWS_INTERNAL");
    expect(err.message).toContain("TOKEN_ENC_KEY");
  });

  it.each([
    ["the unreplaced placeholder", "<generate>"],
    ["a 31-byte key", throwawayKey(31)],
    ["a 33-byte key", throwawayKey(33)],
    ["a 16-byte key", throwawayKey(16)],
    ["a 64-byte key", throwawayKey(64)],
    ["a non-base64 string", "not base64 at all!!"],
    ["base64url instead of base64", throwawayKey().replace(/\+/g, "-").replace(/\//g, "_") + "-_"],
    ["a raw 32-character passphrase", "0123456789abcdef0123456789abcdef"],
  ])("rejects %s with GWS_INTERNAL and never echoes the value", async (_label, value) => {
    const err = await codeOf(importKey({ TOKEN_ENC_KEY: value }));
    expect(err.code).toBe("GWS_INTERNAL");
    expect(err.message.includes(value)).toBe(false);
  });

  it("accepts surrounding whitespace, such as a trailing newline from stdin", async () => {
    await expect(importKey({ TOKEN_ENC_KEY: `${throwawayKey()}\n` })).resolves.toBeDefined();
  });
});

describe("AES-GCM token encryption", () => {
  it("round-trips with the same key and AAD", async () => {
    const key = await importKey({ TOKEN_ENC_KEY: throwawayKey() });
    const sealed = await encrypt(key, PLAINTEXT, AAD);
    expect(await decrypt(key, sealed, AAD)).toBe(PLAINTEXT);
  });

  it("produces base64 fields with a 12-byte IV and never contains the plaintext", async () => {
    const key = await importKey({ TOKEN_ENC_KEY: throwawayKey() });
    const sealed = await encrypt(key, PLAINTEXT, AAD);
    expect(atob(sealed.iv).length).toBe(12);
    expect(sealed.ct).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(sealed.ct.includes("1//")).toBe(false);
    expect(atob(sealed.ct).includes("1//")).toBe(false);
  });

  it("uses a fresh IV per call, so equal plaintexts give different ciphertexts", async () => {
    const key = await importKey({ TOKEN_ENC_KEY: throwawayKey() });
    const a = await encrypt(key, PLAINTEXT, AAD);
    const b = await encrypt(key, PLAINTEXT, AAD);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("fails to decrypt under another key", async () => {
    const key = await importKey({ TOKEN_ENC_KEY: throwawayKey() });
    const other = await importKey({ TOKEN_ENC_KEY: throwawayKey() });
    const sealed = await encrypt(key, PLAINTEXT, AAD);
    const err = await codeOf(decrypt(other, sealed, AAD));
    expect(err.code).toBe("GWS_INTERNAL");
    expect(err.message.includes(PLAINTEXT)).toBe(false);
  });

  it.each([
    ["another account", tokenAad("refresh", { userId: "u_1", accountId: "a_2", keyVersion: KEY_VERSION })],
    ["another user", tokenAad("refresh", { userId: "u_2", accountId: "a_1", keyVersion: KEY_VERSION })],
    ["another key version", tokenAad("refresh", { userId: "u_1", accountId: "a_1", keyVersion: KEY_VERSION + 1 })],
    ["the access-token purpose", tokenAad("access", { userId: "u_1", accountId: "a_1", keyVersion: KEY_VERSION })],
  ])("fails to decrypt when the AAD names %s", async (_label, otherAad) => {
    const key = await importKey({ TOKEN_ENC_KEY: throwawayKey() });
    const sealed = await encrypt(key, PLAINTEXT, AAD);
    expect((await codeOf(decrypt(key, sealed, otherAad))).code).toBe("GWS_INTERNAL");
  });

  it("encodes the AAD unambiguously, so ids containing separators cannot collide", () => {
    const a = tokenAad("refresh", { userId: "u_1:a", accountId: "b", keyVersion: 1 });
    const b = tokenAad("refresh", { userId: "u_1", accountId: "a:b", keyVersion: 1 });
    expect(a).not.toBe(b);
  });

  it("rejects a tampered ciphertext or a malformed IV", async () => {
    const key = await importKey({ TOKEN_ENC_KEY: throwawayKey() });
    const sealed = await encrypt(key, PLAINTEXT, AAD);
    const bytes = Uint8Array.from(atob(sealed.ct), (c) => c.charCodeAt(0));
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const tampered = btoa(String.fromCharCode(...bytes));
    expect((await codeOf(decrypt(key, { ct: tampered, iv: sealed.iv }, AAD))).code).toBe("GWS_INTERNAL");
    expect((await codeOf(decrypt(key, { ct: sealed.ct, iv: btoa("short") }, AAD))).code).toBe("GWS_INTERNAL");
    expect((await codeOf(decrypt(key, { ct: "%%%", iv: sealed.iv }, AAD))).code).toBe("GWS_INTERNAL");
  });
});
