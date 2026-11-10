import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isGwsError } from "../../src/errors";
import { ensurePrivateDir } from "../../src/local/paths";
import { describeBackend, KEY_FILE, KEYCHAIN_SERVICE, keychainService, openSecrets, systemKeyring, type Keyring } from "../../src/local/secrets";
import { base64ToBytes } from "../../src/store/crypto";
import { memoryKeyring, tempDir } from "./helpers";

const posixOnly = process.platform === "win32" ? it.skip : it;
const CLIENT_SECRET = "GOCSPX-local-test-client-secret";

/** Every temp dir a test made, removed after it (a test may make several). */
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function scratch(): string {
  const t = tempDir();
  cleanups.push(t.cleanup);
  ensurePrivateDir(t.dir);
  return t.dir;
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isGwsError(e) ? `${e.code}: ${e.message}` : String(e);
  }
  return "resolved";
}

describe("keychain entries per config folder", () => {
  it("names the keychain service after the folder's real path, so two folders never share entries", async () => {
    const a = scratch();
    const b = scratch();
    expect(keychainService(a)).toMatch(new RegExp(`^${KEYCHAIN_SERVICE}:[0-9a-f]{12}$`));
    expect(keychainService(a)).not.toBe(keychainService(b));
    // The same folder reached through a symlink is the same folder.
    const link = path.join(path.dirname(a), "via-link");
    symlinkSync(a, link);
    expect(keychainService(link)).toBe(keychainService(a));

    const keyring = memoryKeyring();
    const sa = await openSecrets({ dir: a, keyring: { keyring } });
    await sa.set("GOOGLE_CLIENT_SECRET", CLIENT_SECRET);
    await sa.ensureEncryptionKey();
    const sb = await openSecrets({ dir: b, keyring: { keyring } });
    expect(sb.source.get("GOOGLE_CLIENT_SECRET")).toBeUndefined();
    expect(sb.source.get("TOKEN_ENC_KEY")).toBeUndefined();
    await sb.set("GOOGLE_CLIENT_SECRET", "GOCSPX-another-folder-secret");
    expect((await openSecrets({ dir: a, keyring: { keyring } })).source.get("GOOGLE_CLIENT_SECRET")).toBe(CLIENT_SECRET);
    expect([...keyring.entries.keys()].some((k) => k.startsWith(`${KEYCHAIN_SERVICE}\u0000`))).toBe(false);
  });
});

describe("local secrets in the OS keychain", () => {
  it("keeps every secret in the keychain, one entry per name, and serves them from memory", async () => {
    const dir = scratch();
    const keyring = memoryKeyring();
    const s = await openSecrets({ dir, keyring: { keyring } });
    expect(s.backend).toEqual({ kind: "keychain" });
    expect(await s.ensureEncryptionKey()).toBe("created");
    expect(await s.ensureEncryptionKey()).toBe("present");
    await s.set("GOOGLE_CLIENT_ID", "123-abc.apps.googleusercontent.com");
    await s.set("GOOGLE_CLIENT_SECRET", CLIENT_SECRET);
    expect([...keyring.entries.keys()].sort()).toEqual(
      ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENC_KEY"].map((n) => `${keychainService(dir)}\u0000${n}`),
    );
    expect(base64ToBytes(s.source.get("TOKEN_ENC_KEY") ?? "")?.length).toBe(32);
    expect(s.source.get("GOOGLE_CLIENT_SECRET")).toBe(CLIENT_SECRET);
    // Nothing is written next to the database when the keychain answers.
    expect(() => statSync(path.join(dir, KEY_FILE))).toThrow();

    const reopened = await openSecrets({ dir, keyring: { keyring } });
    expect(reopened.source.get("GOOGLE_CLIENT_SECRET")).toBe(CLIENT_SECRET);
    expect(reopened.source.get("TOKEN_ENC_KEY")).toBe(s.source.get("TOKEN_ENC_KEY"));
    expect(describeBackend(reopened.backend)).toBe("secrets: in the OS keychain");
  });

  it("answers only secret names, whatever a caller asks", async () => {
    const s = await openSecrets({ dir: scratch(), keyring: { keyring: memoryKeyring() } });
    await s.ensureEncryptionKey();
    for (const name of ["DB", "toString", "__proto__", "constructor", "GOOGLE_UPSTREAM"]) {
      expect(s.source.get(name as "TOKEN_ENC_KEY")).toBeUndefined();
    }
  });

  it("refuses an invalid value without echoing it, and keeps nothing", async () => {
    const keyring = memoryKeyring();
    const s = await openSecrets({ dir: scratch(), keyring: { keyring } });
    const value = "not a valid secret value";
    const message = await rejection(s.set("GOOGLE_CLIENT_SECRET", value));
    expect(message).toBe("GWS_INVALID_INPUT: GOOGLE_CLIENT_SECRET must be 1 to 4096 printable characters without spaces");
    expect(message).not.toContain(value);
    expect(await rejection(s.set("TOKEN_ENC_KEY", btoa("short")))).toBe("GWS_INVALID_INPUT: TOKEN_ENC_KEY must be base64 of exactly 32 bytes");
    expect(await rejection(s.set("NOPE" as "TOKEN_ENC_KEY", "x".repeat(10)))).toBe("GWS_INVALID_INPUT: unknown secret name");
    expect(keyring.entries.size).toBe(0);
  });

  it("refuses a keychain that does not keep what it was given", async () => {
    const forgetful: Keyring = { get: async () => null, set: async () => undefined, delete: async () => false };
    const s = await openSecrets({ dir: scratch(), keyring: { keyring: forgetful } });
    expect(await rejection(s.ensureEncryptionKey())).toBe("GWS_INTERNAL: the keychain did not keep TOKEN_ENC_KEY");
    expect(s.source.get("TOKEN_ENC_KEY")).toBeUndefined();
  });

  it("refuses a value someone else put in the keychain that is not valid, without echoing it", async () => {
    const keyring = memoryKeyring();
    const dir = scratch();
    await keyring.set(keychainService(dir), "TOKEN_ENC_KEY", "tampered-value-xyz");
    const message = await rejection(openSecrets({ dir, keyring: { keyring } }));
    expect(message).toBe("GWS_INTERNAL: the stored TOKEN_ENC_KEY is not valid; run setup again");
  });
});

const NO_KEYCHAIN = { unavailable: "the keychain library has no build for this platform" } as const;

/** A keyring whose reads fail the way a locked or denied keychain does. */
function refusingKeyring(message: string): Keyring {
  const fail = () => Promise.reject(new Error(message));
  return { get: fail, set: fail, delete: fail };
}

describe("a keychain that does not answer", () => {
  for (const [what, message] of [
    ["locked", "User interaction is not allowed."],
    ["denied", "The user name or passphrase you entered is not correct."],
  ] as const) {
    it(`refuses to open when the keychain is ${what}, and creates no key file`, async () => {
      const dir = scratch();
      const refusal = await rejection(openSecrets({ dir, keyring: { keyring: refusingKeyring(message) } }));
      expect(refusal).toBe(
        "GWS_INTERNAL: the OS keychain did not answer (it may be locked, or access was denied): unlock your keychain and retry",
      );
      expect(refusal).not.toContain(message);
      expect(existsSync(path.join(dir, KEY_FILE))).toBe(false);
    });
  }

  it("serves the keychain key again once the keychain is back: a refusal changed nothing", async () => {
    const dir = scratch();
    const keyring = memoryKeyring();
    const first = await openSecrets({ dir, keyring: { keyring } });
    await first.ensureEncryptionKey();
    const key = first.source.get("TOKEN_ENC_KEY");
    expect(await rejection(openSecrets({ dir, keyring: { keyring: refusingKeyring("locked") } }))).toMatch(/unlock your keychain and retry$/);
    const back = await openSecrets({ dir, keyring: { keyring } });
    expect(back.backend).toEqual({ kind: "keychain" });
    expect(back.source.get("TOKEN_ENC_KEY")).toBe(key);
    expect(await back.ensureEncryptionKey()).toBe("present");
    expect(existsSync(path.join(dir, KEY_FILE))).toBe(false);
  });
});

describe("a keychain that fails after answering the probe", () => {
  it("gives a GWS error with the unlock advice, never the library's own error text", async () => {
    let reads = 0;
    const flaky: Keyring = {
      get: async () => {
        if (reads++ === 0) return null;
        throw new Error("raw-lib-detail");
      },
      set: async () => {
        throw new Error("raw-lib-detail");
      },
      delete: async () => false,
    };
    const loadFailure = await rejection(openSecrets({ dir: scratch(), keyring: { keyring: flaky } }));
    expect(loadFailure).toBe(
      "GWS_INTERNAL: the OS keychain did not answer (it may be locked, or access was denied): unlock your keychain and retry",
    );
    const writable: Keyring = { get: async () => null, set: flaky.set, delete: flaky.delete };
    const s = await openSecrets({ dir: scratch(), keyring: { keyring: writable } });
    expect(await rejection(s.ensureEncryptionKey())).toBe(
      "GWS_INTERNAL: the OS keychain did not answer (it may be locked, or access was denied): unlock your keychain and retry",
    );
  });
});

describe("the key file", () => {
  posixOnly("is used when the system has no keychain: created by the first write (mode 600), never by opening, flagged as weaker", async () => {
    const dir = scratch();
    const file = path.join(dir, KEY_FILE);
    const s = await openSecrets({ dir, keyring: NO_KEYCHAIN });
    expect(s.backend).toMatchObject({ kind: "file", path: file, reason: `no OS keychain: ${NO_KEYCHAIN.unavailable}` });
    expect(describeBackend(s.backend)).toContain("WEAKER than the OS keychain");
    expect(existsSync(file)).toBe(false);
    await s.ensureEncryptionKey();
    await s.set("GOOGLE_CLIENT_SECRET", CLIENT_SECRET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")) as object).sort()).toEqual(["GOOGLE_CLIENT_SECRET", "TOKEN_ENC_KEY"]);
    const reopened = await openSecrets({ dir, keyring: NO_KEYCHAIN });
    expect(reopened.source.get("GOOGLE_CLIENT_SECRET")).toBe(CLIENT_SECRET);
    expect(reopened.source.get("TOKEN_ENC_KEY")).toBe(s.source.get("TOKEN_ENC_KEY"));
  });

  posixOnly("is used beside a working keychain only when chosen explicitly, and then the keychain is not touched", async () => {
    const dir = scratch();
    const keyring = memoryKeyring();
    const s = await openSecrets({ dir, keyring: { keyring }, keyStorage: "file" });
    expect(s.backend).toMatchObject({ kind: "file", reason: "chosen at setup" });
    await s.ensureEncryptionKey();
    expect(keyring.entries.size).toBe(0);
    const reopened = await openSecrets({ dir, keyring: { keyring }, keyStorage: "file" });
    expect(reopened.source.get("TOKEN_ENC_KEY")).toBe(s.source.get("TOKEN_ENC_KEY"));
  });

  posixOnly("is refused, never adopted, when it appears beside a working keychain", async () => {
    const dir = scratch();
    const keyring = memoryKeyring();
    const planted = `{"TOKEN_ENC_KEY":"${btoa("attacker-chosen-key-32-bytes-xx!")}"}`;
    writeFileSync(path.join(dir, KEY_FILE), planted, { mode: 0o600 });
    const refusal = await rejection(openSecrets({ dir, keyring: { keyring } }));
    expect(refusal).toBe(
      `GWS_INTERNAL: a key file exists at ${path.join(dir, KEY_FILE)} but this system has an OS keychain; gws-mcp uses a key file only when it is chosen at setup. Remove the file, or run setup and choose the key file`,
    );
    expect(keyring.entries.size).toBe(0);
  });

  posixOnly("is refused when the keychain also holds a key: two key sources are a conflict", async () => {
    const dir = scratch();
    const keyring = memoryKeyring();
    await (await openSecrets({ dir, keyring: { keyring } })).ensureEncryptionKey();
    const fileChoice = { dir, keyring: { keyring }, keyStorage: "file" as const };
    expect(await rejection(openSecrets(fileChoice))).toBe(
      "GWS_INTERNAL: the OS keychain already holds a gws-mcp key; remove it from the keychain before choosing the key file",
    );
    writeFileSync(path.join(dir, KEY_FILE), "{}", { mode: 0o600 });
    expect(await rejection(openSecrets({ dir, keyring: { keyring } }))).toBe(
      `GWS_INTERNAL: the OS keychain and a key file both hold a gws-mcp key; remove the one you do not use (the key file is ${path.join(dir, KEY_FILE)})`,
    );
    expect(await rejection(openSecrets(fileChoice))).toBe(
      `GWS_INTERNAL: the OS keychain and a key file both hold a gws-mcp key; remove the one you do not use (the key file is ${path.join(dir, KEY_FILE)})`,
    );
  });

  posixOnly("with a mode other than 600, a foreign shape or a symlink, is refused and left as it is, never repaired into use", async () => {
    const dir = scratch();
    const file = path.join(dir, KEY_FILE);
    writeFileSync(file, `{"TOKEN_ENC_KEY":"${btoa("attacker-chosen-key-32-bytes-xx!")}"}`, { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(await rejection(openSecrets({ dir, keyring: NO_KEYCHAIN }))).toBe(`GWS_INTERNAL: refusing to use ${file}: it has mode 0644, not 0600`);
    expect(statSync(file).mode & 0o777).toBe(0o644);

    chmodSync(file, 0o600);
    writeFileSync(file, '{"TOKEN_ENC_KEY":"x","EXTRA":"secret-material-here"}');
    const shape = await rejection(openSecrets({ dir, keyring: NO_KEYCHAIN }));
    expect(shape).toBe(`GWS_INTERNAL: the key file ${file} has an unexpected shape`);
    expect(shape).not.toContain("secret-material-here");

    rmSync(file);
    const target = path.join(dir, "elsewhere");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, file);
    expect(await rejection(openSecrets({ dir, keyring: NO_KEYCHAIN }))).toBe(`GWS_INTERNAL: refusing to use ${file}: it is a symbolic link`);
  });

  posixOnly("named key but a FIFO (or other non-regular file), is refused at once instead of blocking the open", () => {
    const dir = scratch();
    const file = path.join(dir, KEY_FILE);
    expect(spawnSync("mkfifo", [file]).status).toBe(0);
    // In a child process with a kill timeout: a blocking open would hang it, never this test run.
    const secretsModule = pathToFileURL(path.resolve(import.meta.dirname, "../../src/local/secrets.ts")).href;
    const script = `
      const { openSecrets } = await import(${JSON.stringify(secretsModule)});
      try { await openSecrets({ dir: ${JSON.stringify(dir)}, keyring: { unavailable: "none" } }); console.log("opened"); }
      catch (e) { console.log("refused: " + e.message); }`;
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 8000 });
    expect({ signal: r.signal, out: r.stdout.trim() }).toEqual({ signal: null, out: `refused: refusing to use ${file}: it is not a regular file` });
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it("remembers each secret for redaction, plus tokens it is told about", async () => {
    const s = await openSecrets({ dir: scratch(), keyring: { keyring: memoryKeyring() } });
    await s.ensureEncryptionKey();
    await s.set("GOOGLE_CLIENT_SECRET", "plain-shaped-client-secret");
    const key = s.source.get("TOKEN_ENC_KEY") ?? "";
    s.redactor.remember("opaque-token-value-0001");
    const text = `key=${key} secret plain-shaped-client-secret token opaque-token-value-0001 google ya29.a0AfB_xyz`;
    expect(s.redactor.redact(text)).toBe("key=[REDACTED] secret [REDACTED] token [REDACTED] google [REDACTED]");
  });
});

/**
 * Opt-in: a round trip through the real OS keychain under a throwaway service name, deleted afterwards. Off by
 * default so tests never write to the developer's keychain: set GWS_MCP_TEST_REAL_KEYCHAIN=1 to run it.
 */
describe.runIf(process.env.GWS_MCP_TEST_REAL_KEYCHAIN === "1")("the real OS keychain (opt-in)", () => {
  it("stores, reads back and deletes a dummy value", async () => {
    const probe = await systemKeyring();
    if (!("keyring" in probe)) throw new Error(`no keychain: ${probe.unavailable}`);
    const service = `gws-mcp-test-${crypto.randomUUID()}`;
    const dummy = `dummy-${crypto.randomUUID()}`;
    try {
      await probe.keyring.set(service, "probe", dummy);
      expect(await probe.keyring.get(service, "probe")).toBe(dummy);
    } finally {
      await probe.keyring.delete(service, "probe");
    }
    expect(await probe.keyring.get(service, "probe")).toBeNull();
  });
});
