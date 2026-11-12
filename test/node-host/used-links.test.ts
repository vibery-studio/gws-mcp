import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { linkKey } from "../../src/core/links";
import { settingLinkUsedRow, type SettingLinkRecord } from "../../src/core/setting-links";
import { nodeD1 } from "../../src/runtime/node/d1";
import { openDatabase } from "../../src/runtime/node/database";
import { openUserSettings } from "../../src/store/user-settings";

/**
 * A one-time setting link is used at most once on the Node host's store: the save, the link's use and its audit row
 * are one SQLite transaction, also across two connections to the same file (two host processes).
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const TOKEN_ENC_KEY = randomBytes(32).toString("base64");
const USER = "u-node-link";

function open(file: string): DatabaseSync {
  const { db } = openDatabase(file);
  cleanups.push(() => db.close());
  return db;
}

function fileWithUser(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gws-node-used-links-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "gws-mcp.db");
  open(file).prepare("INSERT INTO users (id, primary_email, created_at) VALUES (?, ?, ?)").run(USER, "node-link@fake.test", Date.now());
  return file;
}

const record = (version: number): SettingLinkRecord => ({
  kind: "setting",
  userId: USER,
  clientId: "c-node",
  executeId: "e-node",
  key: "ads.developer_token",
  version,
  exp: Date.now() + 600_000,
});

describe("one-time setting links on the Node host store", () => {
  it("has the used-links table and the settings version after its migrations", () => {
    const db = open(fileWithUser());
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'used_links'").get()).toEqual({ name: "used_links" });
    expect(db.prepare("SELECT settings_version FROM users WHERE id = ?").get(USER)).toEqual({ settings_version: 0 });
  });

  it("saves once when two connections use the same link at the same moment", async () => {
    const file = fileWithUser();
    const a = openUserSettings({ DB: nodeD1(open(file)), TOKEN_ENC_KEY });
    const b = openUserSettings({ DB: nodeD1(open(file)), TOKEN_ENC_KEY });
    const tokenHash = await linkKey("setting", "A".repeat(43));
    const version = await a.version(USER);
    const now = Date.now();
    const values = ["FAKE-node-code-aaaa", "FAKE-node-code-bbbb"];
    const results = await Promise.all(
      [a, b].map((store, i) => store.saveFromLink(USER, "ads.developer_token", values[i] ?? "", { tokenHash, version, now, audit: settingLinkUsedRow(record(version), now) })),
    );
    expect([...results].sort()).toEqual(["saved", "used"]);
    expect(await a.get(USER, "ads.developer_token")).toBe(values[results.indexOf("saved")]);
    const raw = open(file);
    expect(raw.prepare("SELECT count(*) AS n FROM used_links WHERE token_hash = ?").get(tokenHash)).toEqual({ n: 1 });
    expect(raw.prepare("SELECT count(*) AS n FROM audit_log WHERE fn = 'settings.link.used:ads.developer_token'").get()).toEqual({ n: 1 });
    expect(await a.version(USER)).toBe(version + 1);
  });

  it("changes nothing for a link made before a save and a clear", async () => {
    const file = fileWithUser();
    const store = openUserSettings({ DB: nodeD1(open(file)), TOKEN_ENC_KEY });
    const version = await store.version(USER);
    await store.set(USER, "ads.developer_token", "FAKE-node-code-cccc");
    await store.clear(USER, "ads.developer_token");
    expect(await store.version(USER)).toBe(version + 2);
    const now = Date.now();
    const tokenHash = await linkKey("setting", "B".repeat(43));
    const result = await store.saveFromLink(USER, "ads.developer_token", "FAKE-node-code-dddd", { tokenHash, version, now, audit: settingLinkUsedRow(record(version), now) });
    expect(result).toBe("stale");
    expect(await store.isSet(USER, "ads.developer_token")).toBe(false);
    const raw = open(file);
    expect(raw.prepare("SELECT count(*) AS n FROM used_links").get()).toEqual({ n: 0 });
    expect(raw.prepare("SELECT count(*) AS n FROM audit_log").get()).toEqual({ n: 0 });
  });
});
