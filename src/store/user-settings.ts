import {
  invalidSettingKey,
  isSettingKey,
  normalizeSettingValue,
  settingUnreadable,
  type SettingKey,
  type UserSettingsPort,
} from "../core/settings-capability";
import type { AuditRow } from "../contracts";
import { consumeLinkStatements, isLinkUsed } from "../core/links";
import { SETTING_LINK_PURPOSE } from "../core/setting-links";
import { GwsError, isGwsError } from "../errors";
import { KEY_VERSION, decrypt, encrypt, importKey, settingAad } from "./crypto";
import { auditInsert, type StoreEnv } from "./db";

/**
 * Per-user settings (`user_settings`): the Google Ads developer token and login customer id. Each value is sealed with
 * AES-GCM under TOKEN_ENC_KEY, the refresh tokens' key, with an AAD binding it to the user, the setting key and the key
 * version. Only this module touches the ciphertext. The local runtime runs the same code over SQLite.
 *
 * Every save and every clear also bumps the user's `users.settings_version` in the same batch, so a one-time setting
 * link bound to the version never applies after any change, wherever it was made (page, CLI, snippet).
 */

/** What a save through a one-time setting link did. */
export type LinkSaveResult = "saved" | "used" | "stale";

/** The link a save consumes: its `linkKey`, the settings version it was made at, and the audit row of its use. */
export interface LinkSave {
  tokenHash: string;
  version: number;
  now: number;
  audit: AuditRow;
}

interface SettingRow {
  value_ct: string;
  value_iv: string;
  key_version: number;
}

function invalidValue(key: SettingKey): GwsError {
  const rule =
    key === "ads.developer_token"
      ? "a Google Ads developer token is one run of letters, digits, - and _"
      : "a Google Ads customer id has 10 digits, like 123-456-7890";
  // Never the value itself.
  return new GwsError("GWS_INVALID_INPUT", `invalid value for ${key}: ${rule}`, { details: { fields: ["value"] } });
}

function checkedKey(key: unknown): SettingKey {
  if (!isSettingKey(key)) throw invalidSettingKey();
  return key;
}

export function openUserSettings(env: StoreEnv) {
  const db = env.DB;
  const aad = (userId: string, key: SettingKey, keyVersion: number) => settingAad({ userId, key, keyVersion });

  const bump = (userId: string) => db.prepare("UPDATE users SET settings_version = settings_version + 1 WHERE id = ?").bind(userId);

  const row = (userId: string, key: SettingKey) =>
    db.prepare("SELECT value_ct, value_iv, key_version FROM user_settings WHERE user_id = ? AND key = ?").bind(userId, key).first<SettingRow>();

  /** Validates, normalizes and seals a value. A refused value is never echoed. */
  async function seal(userId: string, key: SettingKey, value: string) {
    const normalized = normalizeSettingValue(key, value);
    if (normalized === null) throw invalidValue(key);
    return encrypt(await importKey(env), normalized, aad(userId, key, KEY_VERSION));
  }

  const settings = {
    async isSet(userId: string, key: SettingKey): Promise<boolean> {
      const k = checkedKey(key);
      const r = await db.prepare("SELECT 1 AS ok FROM user_settings WHERE user_id = ? AND key = ?").bind(userId, k).first<{ ok: number }>();
      return r !== null;
    },

    /**
     * Host-internal: gws-mcp never puts the plaintext in a snippet, result, log, audit row, error or plan step. A saved
     * value that no longer decrypts (or uses another key version) gives GWS_SETTING_UNREADABLE; a key that cannot be
     * loaded at all stays GWS_INTERNAL, as for tokens.
     */
    async get(userId: string, key: SettingKey): Promise<string | null> {
      const k = checkedKey(key);
      const r = await row(userId, k);
      if (r === null) return null;
      if (r.key_version !== KEY_VERSION) throw settingUnreadable(k);
      const cryptoKey = await importKey(env);
      try {
        return await decrypt(cryptoKey, { ct: r.value_ct, iv: r.value_iv }, aad(userId, k, r.key_version));
      } catch {
        throw settingUnreadable(k);
      }
    },

    /** Whether a value is saved and still decrypts. Decrypts and discards it: for showing the state, never the value. */
    async state(userId: string, key: SettingKey): Promise<"missing" | "saved" | "unreadable"> {
      try {
        return (await settings.get(userId, key)) === null ? "missing" : "saved";
      } catch (e) {
        if (isGwsError(e) && e.code === "GWS_SETTING_UNREADABLE") return "unreadable";
        throw e;
      }
    },

    /**
     * Validates, normalizes and stores a value, replacing any earlier one. Only the account page and the local CLI call
     * it: a snippet can never set a value. A refused value is never echoed.
     */
    async set(userId: string, key: SettingKey, value: string): Promise<void> {
      const k = checkedKey(key);
      const sealed = await seal(userId, k, value);
      try {
        await db.batch([
          db
            .prepare(
              `INSERT INTO user_settings (user_id, key, value_ct, value_iv, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (user_id, key) DO UPDATE SET value_ct = excluded.value_ct, value_iv = excluded.value_iv,
                 key_version = excluded.key_version, updated_at = excluded.updated_at`,
            )
            .bind(userId, k, sealed.ct, sealed.iv, KEY_VERSION, Date.now()),
          bump(userId),
        ]);
      } catch (e) {
        if (e instanceof Error && /FOREIGN KEY constraint failed/i.test(e.message)) throw new GwsError("GWS_INTERNAL", "settings owner does not exist");
        throw e;
      }
    },

    /**
     * Saves a value through a one-time setting link, atomically with the link's use: in one batch the link's token
     * hash goes into `used_links`, the value is saved, the audit row is written and the version is bumped, each only
     * while the user's settings version is still the one the link was made at. A second use of the link fails the
     * whole batch, or finds the version moved by the first ("used"); a version changed otherwise makes it change nothing
     * ("stale"). Nothing is written in either case,
     * and a failed batch leaves the link unused. A refused value is never echoed.
     */
    async saveFromLink(userId: string, key: SettingKey, value: string, link: LinkSave): Promise<LinkSaveResult> {
      const k = checkedKey(key);
      const sealed = await seal(userId, k, value);
      const when = { sql: "(SELECT settings_version FROM users WHERE id = ?) = ?", params: [userId, link.version] };
      let results: Array<{ meta: { changes: number } }>;
      try {
        results = await db.batch([
          ...consumeLinkStatements(db, { tokenHash: link.tokenHash, purpose: SETTING_LINK_PURPOSE, userId, now: link.now, when }),
          db
            .prepare(
              `INSERT INTO user_settings (user_id, key, value_ct, value_iv, key_version, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${when.sql}
               ON CONFLICT (user_id, key) DO UPDATE SET value_ct = excluded.value_ct, value_iv = excluded.value_iv,
                 key_version = excluded.key_version, updated_at = excluded.updated_at`,
            )
            .bind(userId, k, sealed.ct, sealed.iv, KEY_VERSION, link.now, ...when.params),
          auditInsert(db, link.audit, when),
          db.prepare("UPDATE users SET settings_version = settings_version + 1 WHERE id = ? AND settings_version = ?").bind(userId, link.version),
        ]);
      } catch (e) {
        // The token hash's primary key refused a second use; nothing of this batch was written.
        if (await isLinkUsed(db, link.tokenHash)) return "used";
        throw e;
      }
      if (results[results.length - 1]?.meta.changes === 1) return "saved";
      // Nothing applied: the version moved. A concurrent use of this link that committed first moves it too, and must
      // get the same answer as any second use.
      return (await isLinkUsed(db, link.tokenHash)) ? "used" : "stale";
    },

    /** The user's settings version: bumped by every save and clear of any of their settings (0 for an unknown user). */
    async version(userId: string): Promise<number> {
      const r = await db.prepare("SELECT settings_version FROM users WHERE id = ?").bind(userId).first<{ settings_version: number }>();
      return r?.settings_version ?? 0;
    },

    /** Deletes the value; false when none was stored. */
    async clear(userId: string, key: SettingKey): Promise<boolean> {
      const k = checkedKey(key);
      const [r] = await db.batch([db.prepare("DELETE FROM user_settings WHERE user_id = ? AND key = ?").bind(userId, k), bump(userId)]);
      return (r?.meta.changes ?? 0) > 0;
    },
  };
  return settings satisfies UserSettingsPort;
}

export type UserSettingsStore = ReturnType<typeof openUserSettings>;
