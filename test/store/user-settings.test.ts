import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { KEY_VERSION, decrypt, importKey, settingAad, tokenAad } from "../../src/store/crypto";
import { openStore } from "../../src/store/db";
import { openUserSettings } from "../../src/store/user-settings";
import { stringViews } from "../helpers/accounts";

/** The per-user settings store: AES-GCM sealed under the token key, bound to user, key and key version. */

const settings = openUserSettings(env);
const store = openStore(env);

async function user(prefix: string): Promise<string> {
  const sub = `${prefix}-${crypto.randomUUID()}`;
  return (await store.users.create({ sub, email: `${sub}@settings.test` })).id;
}

const fakeToken = () => `FAKE-dev-token-${crypto.randomUUID().slice(0, 8)}`;

async function rows(userId: string): Promise<Array<Record<string, unknown>>> {
  return (await env.DB.prepare("SELECT * FROM user_settings WHERE user_id = ? ORDER BY key").bind(userId).all<Record<string, unknown>>()).results;
}

async function rejection(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("expected a rejection");
}

describe("user settings", () => {
  it("stores, reads, reports and clears each key per user", async () => {
    const a = await user("set-a");
    const b = await user("set-b");
    const token = fakeToken();
    expect(await settings.isSet(a, "ads.developer_token")).toBe(false);
    expect(await settings.get(a, "ads.developer_token")).toBeNull();
    await settings.set(a, "ads.developer_token", `  ${token} `);
    await settings.set(a, "ads.login_customer_id", "123-456-7890");
    expect(await settings.get(a, "ads.developer_token")).toBe(token);
    expect(await settings.get(a, "ads.login_customer_id")).toBe("1234567890");
    expect(await settings.isSet(a, "ads.login_customer_id")).toBe(true);
    // Another user sees nothing of them.
    expect(await settings.isSet(b, "ads.developer_token")).toBe(false);
    expect(await settings.get(b, "ads.developer_token")).toBeNull();
    expect(await settings.clear(b, "ads.developer_token")).toBe(false);

    const replaced = fakeToken();
    await settings.set(a, "ads.developer_token", replaced);
    expect(await settings.get(a, "ads.developer_token")).toBe(replaced);
    expect(await settings.clear(a, "ads.developer_token")).toBe(true);
    expect(await settings.clear(a, "ads.developer_token")).toBe(false);
    expect(await settings.get(a, "ads.developer_token")).toBeNull();
    expect(await settings.get(a, "ads.login_customer_id")).toBe("1234567890");
  });

  it("holds only ciphertext, sealed with the token key and an AAD of purpose, key version, user and key", async () => {
    const id = await user("set-ct");
    const token = fakeToken();
    await settings.set(id, "ads.developer_token", token);
    const [row] = await rows(id);
    expect(row).toMatchObject({ user_id: id, key: "ads.developer_token", key_version: KEY_VERSION });
    for (const v of Object.values(row ?? {})) for (const view of stringViews(v)) expect(view.includes(token)).toBe(false);
    const key = await importKey(env);
    const sealed = { ct: String(row?.value_ct), iv: String(row?.value_iv) };
    expect(await decrypt(key, sealed, settingAad({ userId: id, key: "ads.developer_token", keyVersion: KEY_VERSION }))).toBe(token);
    // The same ciphertext under a refresh token's AAD does not open.
    await expect(decrypt(key, sealed, tokenAad("refresh", { userId: id, accountId: "ads.developer_token", keyVersion: KEY_VERSION }))).rejects.toMatchObject({
      code: "GWS_INTERNAL",
    });
  });

  it("fails closed, as an unreadable setting, when a ciphertext is copied to another user or another key", async () => {
    const from = await user("set-from");
    const to = await user("set-to");
    await settings.set(from, "ads.developer_token", fakeToken());
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, key, value_ct, value_iv, key_version, updated_at)
       SELECT ?, key, value_ct, value_iv, key_version, updated_at FROM user_settings WHERE user_id = ? AND key = 'ads.developer_token'`,
    )
      .bind(to, from)
      .run();
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, key, value_ct, value_iv, key_version, updated_at)
       SELECT user_id, 'ads.login_customer_id', value_ct, value_iv, key_version, updated_at FROM user_settings WHERE user_id = ? AND key = 'ads.developer_token'`,
    )
      .bind(from)
      .run();
    for (const [u, k] of [[to, "ads.developer_token"], [from, "ads.login_customer_id"]] as const) {
      const e = await rejection(settings.get(u, k));
      expect([e.code, (e as { details?: unknown }).details]).toEqual(["GWS_SETTING_UNREADABLE", { setting: k }]);
      expect(await settings.state(u, k)).toBe("unreadable");
    }
  });

  it("reports a corrupted value or another key version as unreadable (never an internal error), and saving again fixes it", async () => {
    const id = await user("set-corrupt");
    const token = fakeToken();
    await settings.set(id, "ads.developer_token", token);
    await settings.set(id, "ads.login_customer_id", "5550003333");
    await env.DB.prepare("UPDATE user_settings SET value_ct = ? WHERE user_id = ? AND key = 'ads.developer_token'").bind("A".repeat(40), id).run();
    await env.DB.prepare("UPDATE user_settings SET key_version = key_version + 1 WHERE user_id = ? AND key = 'ads.login_customer_id'").bind(id).run();
    for (const k of ["ads.developer_token", "ads.login_customer_id"] as const) {
      const e = await rejection(settings.get(id, k));
      expect(e.code).toBe("GWS_SETTING_UNREADABLE");
      expect(e.message).toContain(`Save it again in gws-mcp under Google accounts → the account → Google Ads, or, when gws-mcp runs on your computer, with \`gws-mcp settings set ${k}\``);
      expect(e.message.includes(token)).toBe(false);
      expect(await settings.state(id, k)).toBe("unreadable");
      expect(await settings.isSet(id, k)).toBe(true);
    }
    await settings.set(id, "ads.developer_token", token);
    expect([await settings.state(id, "ads.developer_token"), await settings.get(id, "ads.developer_token")]).toEqual(["saved", token]);
    expect(await settings.state(id, "ads.login_customer_id")).toBe("unreadable");
    expect(await settings.state(await user("set-none"), "ads.developer_token")).toBe("missing");
  });

  it("refuses an unknown key or a value outside the key's rule, never echoing the value", async () => {
    const id = await user("set-bad");
    const unknown = await rejection(settings.set(id, "ads.other" as "ads.developer_token", fakeToken()));
    expect(unknown).toMatchObject({ code: "GWS_INVALID_INPUT", message: "key must be one of: ads.developer_token, ads.login_customer_id" });
    for (const [key, value] of [
      ["ads.developer_token", "short"],
      ["ads.developer_token", "FAKE token with spaces"],
      ["ads.developer_token", "FAKE-line\r\nx-injected: 1"],
      ["ads.developer_token", `FAKE-${"x".repeat(200)}`],
      ["ads.login_customer_id", "999-888-777"],
      ["ads.login_customer_id", "12345678901"],
      ["ads.login_customer_id", "abcdefghij"],
    ] as const) {
      const e = await rejection(settings.set(id, key, value));
      expect([key, e.code]).toEqual([key, "GWS_INVALID_INPUT"]);
      expect(e.message.includes(value)).toBe(false);
    }
    expect(await rows(id)).toEqual([]);
    // The table's own CHECK refuses another key too.
    await expect(
      env.DB.prepare("INSERT INTO user_settings (user_id, key, value_ct, value_iv, key_version, updated_at) VALUES (?, 'other', 'x', 'y', 1, 0)").bind(id).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("goes with its user: deleting the user deletes the settings", async () => {
    const id = await user("set-gone");
    await settings.set(id, "ads.developer_token", fakeToken());
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
    expect(await rows(id)).toEqual([]);
  });
});
