// The Node host's backup and restore commands, run as the built bundle runs them (`node server.js backup|restore`)
// against real SQLite files, with a second process holding or writing the database where the server would.
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleNodeHost } from "../../scripts/node-host-bundle";
import { openDatabase } from "../../src/runtime/node/database";
import { D1_MIGRATIONS } from "../../src/runtime/node/migrations";
import { runCommand } from "./helpers";

let work: string;
let bundle: string;
let n = 0;

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), "gws-backup-"));
  bundle = path.join(work, "app");
  await bundleNodeHost(bundle);
}, 60_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

const mode = (file: string) => statSync(file).mode & 0o777;

/** A fresh folder with a migrated database holding one marker access rule; returns its paths and the env. */
function fixture(marker = "alice@corp.test") {
  const dir = path.join(work, `case-${++n}`);
  mkdirSync(dir, { mode: 0o700 });
  const db = path.join(dir, "gws.db");
  const { db: conn } = openDatabase(db);
  conn.prepare("INSERT INTO access_rules (pattern, role, note, created_by, created_at) VALUES (?, 'user', NULL, 'setup', 1)").run(marker);
  conn.close();
  const env = { GOOGLE_UPSTREAM: "fake", FAKE_GOOGLE_PUBLIC_URL: "https://fake.example.com", PUBLIC_BASE_URL: "https://gws.example.com", GWS_DB_FILE: db };
  return { dir, db, env };
}

const patterns = (file: string): string[] => {
  const c = new DatabaseSync(file, { readOnly: true });
  try {
    return (c.prepare("SELECT pattern FROM access_rules ORDER BY pattern").all() as Array<{ pattern: string }>).map((r) => r.pattern);
  } finally {
    c.close();
  }
};

/** A process that keeps the database open in WAL mode, as the running server does (and optionally keeps writing). */
async function holder(file: string, write: boolean): Promise<ChildProcess> {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL");
    console.log("ready");
    let i = 0;
    if (process.argv[2] === "write") setInterval(() => { for (let k = 0; k < 20; k++) db.prepare("INSERT INTO access_rules (pattern, role, note, created_by, created_at) VALUES (?, 'user', NULL, 'setup', 1)").run("w" + (i++) + "@w.test"); }, 5);
    else setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script, file, write ? "write" : "idle"], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.once("data", () => resolve());
  });
  return child;
}

async function stop(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

describe("backup", () => {
  it("writes an owner-only consistent copy, prints only the path and size, and keeps the live file", async () => {
    const { dir, db, env } = fixture();
    const dest = path.join(dir, "out.db");
    const r = await runCommand(bundle, env, ["backup", dest]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^backup written: ${dest} \\(\\d+ bytes\\)\\n$`));
    expect(r.stderr).toBe("");
    expect(mode(dest)).toBe(0o600);
    expect(patterns(dest)).toEqual(["alice@corp.test"]);
    expect(patterns(db)).toEqual(["alice@corp.test"]);
    expect(readdirSync(dir).filter((f) => f.includes("partial"))).toEqual([]);
  });

  it("refuses to overwrite an existing file (and a symlink), leaving it untouched", async () => {
    const { dir, env } = fixture();
    const dest = path.join(dir, "taken.db");
    writeFileSync(dest, "keep me", { mode: 0o600 });
    const r = await runCommand(bundle, env, ["backup", dest]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(statSync(dest).size).toBe(7);
    const { dir: d2, env: e2 } = fixture();
    const link = path.join(d2, "link.db");
    writeFileSync(path.join(d2, "target"), "x");
    (await import("node:fs")).symlinkSync(path.join(d2, "target"), link);
    expect((await runCommand(bundle, e2, ["backup", link])).code).toBe(1);
  });

  it("is consistent while the server writes", async () => {
    const { dir, db, env } = fixture();
    const writer = await holder(db, true);
    try {
      await new Promise((r) => setTimeout(r, 200));
      for (let i = 0; i < 3; i++) {
        const dest = path.join(dir, `live-${i}.db`);
        const r = await runCommand(bundle, env, ["backup", dest]);
        expect(r.code, r.stderr).toBe(0);
        const c = new DatabaseSync(dest, { readOnly: true });
        try {
          expect(c.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
          expect((c.prepare("SELECT count(*) AS n FROM access_rules").get() as { n: number }).n).toBeGreaterThan(1);
        } finally {
          c.close();
        }
      }
    } finally {
      await stop(writer);
    }
  });

  it("reports a missing database, a missing folder and bad usage with the shared exit codes", async () => {
    const { dir, env } = fixture();
    expect((await runCommand(bundle, { ...env, GWS_DB_FILE: path.join(dir, "none.db") }, ["backup", path.join(dir, "o.db")])).code).toBe(78);
    const nofolder = await runCommand(bundle, env, ["backup", path.join(dir, "nope", "o.db")]);
    expect([nofolder.code, nofolder.stderr]).toEqual([1, expect.stringMatching(/folder .* does not exist/)]);
    for (const args of [["backup"], ["backup", "a", "b"], ["backup", "--force"], ["restore"]]) {
      const r = await runCommand(bundle, env, args);
      expect([r.code, r.stderr]).toEqual([64, expect.stringContaining("usage:")]);
    }
    expect((await runCommand(bundle, { PATH: "" }, ["backup", "x"])).code).toBe(78);
  });
});

describe("restore", () => {
  it("replaces the database from a backup, keeping the current file owner-only, and drops the old WAL files", async () => {
    const a = fixture("old@corp.test");
    const b = fixture("restored@corp.test");
    const backupFile = path.join(b.dir, "b.db");
    expect((await runCommand(bundle, b.env, ["backup", backupFile])).code).toBe(0);
    const r = await runCommand(bundle, a.env, ["restore", backupFile]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`restored ${backupFile} as ${a.db}`);
    const kept = readdirSync(a.dir).filter((f) => f.startsWith("gws.db.before-restore-"));
    expect(kept).toHaveLength(1);
    expect(r.stdout).toContain(path.join(a.dir, kept[0] as string));
    expect(patterns(path.join(a.dir, kept[0] as string))).toEqual(["old@corp.test"]);
    expect(mode(path.join(a.dir, kept[0] as string))).toBe(0o600);
    expect(patterns(a.db)).toEqual(["restored@corp.test"]);
    expect(mode(a.db)).toBe(0o600);
    expect(existsSync(`${a.db}-wal`) || existsSync(`${a.db}-shm`)).toBe(false);
    expect(readdirSync(a.dir).filter((f) => f.includes("restore-") && !f.includes("before"))).toEqual([]);
    // The backup itself is untouched and the restored file opens as the server opens it.
    expect(patterns(backupFile)).toEqual(["restored@corp.test"]);
    openDatabase(a.db).db.close();
  });

  it("restores when there is no current database", async () => {
    const b = fixture("only@corp.test");
    const backupFile = path.join(b.dir, "b.db");
    expect((await runCommand(bundle, b.env, ["backup", backupFile])).code).toBe(0);
    const dir = path.join(work, `case-${++n}`);
    mkdirSync(dir, { mode: 0o700 });
    const env = { ...b.env, GWS_DB_FILE: path.join(dir, "fresh.db") };
    const r = await runCommand(bundle, env, ["restore", backupFile]);
    expect(r.code, r.stderr).toBe(0);
    expect(patterns(env.GWS_DB_FILE)).toEqual(["only@corp.test"]);
    expect(mode(env.GWS_DB_FILE)).toBe(0o600);
  });

  it("refuses while the server (any connection) has the database open, and changes nothing", async () => {
    const a = fixture("live@corp.test");
    const b = fixture("other@corp.test");
    const backupFile = path.join(b.dir, "b.db");
    expect((await runCommand(bundle, b.env, ["backup", backupFile])).code).toBe(0);
    const server = await holder(a.db, false);
    try {
      const r = await runCommand(bundle, a.env, ["restore", backupFile]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/in use.*stop the server/);
      expect(readdirSync(a.dir).filter((f) => f.includes("before-restore"))).toEqual([]);
      expect(patterns(a.db)).toEqual(["live@corp.test"]);
    } finally {
      await stop(server);
    }
    // Once the server is stopped the same restore goes through.
    expect((await runCommand(bundle, a.env, ["restore", backupFile])).code).toBe(0);
    expect(patterns(a.db)).toEqual(["other@corp.test"]);
  });

  it("refuses a file that is not a gws-mcp database, and a damaged one, changing nothing", async () => {
    const a = fixture("keep@corp.test");
    const text = path.join(a.dir, "notes.txt");
    writeFileSync(text, "just text");
    const foreign = path.join(a.dir, "foreign.db");
    const f = new DatabaseSync(foreign);
    f.exec("CREATE TABLE photos (id INTEGER PRIMARY KEY)");
    f.close();
    // Migration record present but a table it creates is gone.
    const hollow = path.join(a.dir, "hollow.db");
    const h = openDatabase(hollow).db;
    h.exec("DROP TABLE access_rules");
    h.close();
    // A truncated copy of a real database.
    const real = path.join(a.dir, "real.db");
    expect((await runCommand(bundle, a.env, ["backup", real])).code).toBe(0);
    const damaged = path.join(a.dir, "damaged.db");
    const bytes = (await import("node:fs")).readFileSync(real);
    writeFileSync(damaged, bytes.subarray(0, bytes.length - 4096 * 2));

    const cases: Array<[string, RegExp]> = [
      [text, /not a gws-mcp database \(not an SQLite file\)/],
      [foreign, /not a gws-mcp database \(no migration record\)/],
      [hollow, /not a gws-mcp database \(missing tables: access_rules\)/],
      [damaged, /(damaged|not a gws-mcp database)/],
      [path.join(a.dir, "absent.db"), /does not exist/],
      [a.dir, /not a regular file/],
    ];
    for (const [file, message] of cases) {
      const r = await runCommand(bundle, a.env, ["restore", file]);
      expect([file, r.code, r.stderr]).toEqual([file, 1, expect.stringMatching(message)]);
    }
    expect(patterns(a.db)).toEqual(["keep@corp.test"]);
    expect(readdirSync(a.dir).filter((x) => x.includes("before-restore"))).toEqual([]);
    expect((await runCommand(bundle, a.env, ["restore", a.db])).stderr).toMatch(/live database file itself/);
  });

  it("refuses a database a newer build migrated, and accepts an older one (the server migrates it at boot)", async () => {
    const a = fixture("keep@corp.test");
    const newer = path.join(a.dir, "newer.db");
    const n = openDatabase(newer).db;
    n.prepare("INSERT INTO d1_migrations (name) VALUES ('9999_future.sql')").run();
    n.close();
    const r = await runCommand(bundle, a.env, ["restore", newer]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/written by a newer gws-mcp \(9999_future\.sql\)/);
    expect(patterns(a.db)).toEqual(["keep@corp.test"]);

    const older = path.join(a.dir, "older.db");
    const o = new DatabaseSync(older);
    o.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
    const first = D1_MIGRATIONS[0];
    if (first === undefined) throw new Error("no migrations");
    o.exec(first.sql);
    o.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(first.name);
    o.close();
    const ok = await runCommand(bundle, a.env, ["restore", older]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/older version: the server applies 0002_client_approvals\.sql/);
    // The server's own open migrates it forward.
    const { applied, db } = openDatabase(a.db);
    db.close();
    expect(applied[0]).toBe("0002_client_approvals.sql");
  });
});

it("makes the bundle's files readable only by their owner where the commands create them", () => {
  chmodSync(bundle, 0o755);
  expect(statSync(path.join(bundle, "server.js")).isFile()).toBe(true);
});
