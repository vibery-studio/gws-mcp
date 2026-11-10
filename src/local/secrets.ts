import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SECRET_NAMES, type SecretName } from "../contracts";
import type { SecretSource } from "../core/ports";
import { redact } from "../core/redact";
import { GwsError } from "../errors";
import { base64ToBytes, bytesToBase64 } from "../store/crypto";
import { PRIVATE_FILE_MODE, readPrivateFile } from "./paths";

/** Prefix of the keychain service names; each config folder has its own service (see `keychainService`). */
export const KEYCHAIN_SERVICE = "gws-mcp";

/** The folder's real path (symlinks resolved), or the closest resolvable form of it when it does not exist yet. */
function canonicalDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir));
    } catch {
      return path.resolve(dir);
    }
  }
}

/**
 * The keychain service of one config folder: `gws-mcp:<first 12 hex of SHA-256 of its real path>`, one entry per
 * secret name under it. Two folders (a test run, a second profile) never read or overwrite each other's client or key.
 */
export function keychainService(dir: string): string {
  return `${KEYCHAIN_SERVICE}:${createHash("sha256").update(canonicalDir(dir)).digest("hex").slice(0, 12)}`;
}
/** The fallback file, in the config directory, used only when the OS keychain is unavailable. */
export const KEY_FILE = "key";

const KEY_BYTES = 32;
const MAX_SECRET_CHARS = 4096;
/** Tokens remembered for redaction; the oldest go first. Secrets are never evicted. */
const MAX_REMEMBERED_TOKENS = 1024;

/**
 * The OS credential store, behind an interface so tests never touch the real keychain. Every method may reject
 * (locked, no daemon, denied); values never travel in argv or environment variables.
 */
export interface Keyring {
  readonly get: (service: string, account: string) => Promise<string | null>;
  readonly set: (service: string, account: string, value: string) => Promise<void>;
  /** True when an entry was deleted, false when there was none. */
  readonly delete: (service: string, account: string) => Promise<boolean>;
}

/**
 * The keyring the platform offers, or why the system has none. Only a platform-level absence is `unavailable`; a
 * keychain that exists but is locked or denies access is a keyring whose calls reject.
 */
export type KeyringProbe = { keyring: Keyring } | { unavailable: string };

/**
 * The OS keychain through `@napi-rs/keyring` (macOS Keychain, Windows Credential Manager, Linux Secret Service).
 * On Linux the Secret Service is required: the library's other store, the kernel keyring, does not survive a
 * reboot, and losing the key would make every stored token unreadable. Loaded lazily, so a platform without a
 * prebuilt binary falls back to the key file instead of failing to start.
 */
export async function systemKeyring(): Promise<KeyringProbe> {
  let lib: typeof import("@napi-rs/keyring");
  try {
    lib = await import("@napi-rs/keyring");
  } catch {
    return { unavailable: "the keychain library has no build for this platform" };
  }
  const options = process.platform === "linux" ? { linux: { store: "secret-service" as const } } : undefined;
  const entry = (service: string, account: string) => new lib.AsyncEntry(service, account, options);
  try {
    // With a store required, the constructor throws when that store does not exist on this system (no Secret
    // Service): that is "no keychain". A store that exists but is locked fails later, on use, and is refused then.
    entry(KEYCHAIN_SERVICE, "TOKEN_ENC_KEY");
  } catch {
    return { unavailable: "this system has no keychain service (on Linux: no Secret Service is running)" };
  }
  return {
    keyring: {
      get: (service, account) => entry(service, account).getPassword(),
      set: (service, account, value) => entry(service, account).setPassword(value),
      delete: (service, account) => entry(service, account).deleteCredential(),
    },
  };
}

// ---- Redaction ------------------------------------------------------------------------------------------

/**
 * Values that must never appear in local output (console lines returned to the client, logs written to stderr):
 * every secret the local SecretSource holds, plus each token loaded from the store or sent upstream. `redact`
 * also applies the core's credential patterns.
 */
export interface Redactor {
  /** Remembers a token (refresh or access token, OAuth code) to redact from now on. */
  readonly remember: (value: string) => void;
  readonly redact: (text: string) => string;
}

function createRedactor(secretValues: () => Iterable<string>): Redactor {
  const tokens = new Set<string>();
  return {
    remember(value) {
      if (typeof value !== "string" || value.length === 0) return;
      tokens.delete(value);
      tokens.add(value);
      if (tokens.size > MAX_REMEMBERED_TOKENS) {
        const oldest = tokens.values().next().value;
        if (oldest !== undefined) tokens.delete(oldest);
      }
    },
    redact: (text) => redact(text, [...secretValues(), ...tokens]),
  };
}

// ---- Secret storage -------------------------------------------------------------------------------------

/**
 * Where the secrets live. `file` is weaker than the keychain (any process running as the user can read a mode 600
 * file; the keychain gates access per application), so `doctor` and the docs flag it.
 */
export type SecretBackend =
  | { kind: "keychain" }
  | { kind: "file"; path: string; reason: string };

/**
 * Where the encryption key and client secret are kept. `auto`: the OS keychain when the system has one, else the
 * key file. `file`: the key file, chosen explicitly at setup (a headless machine whose keychain cannot be used).
 * The choice must be passed on every open; phase 25's CLI persists it.
 */
export type KeyStorage = "auto" | "file";

export interface LocalSecrets {
  /** The core's port: exactly the names in SECRET_NAMES, from memory. */
  readonly source: SecretSource;
  readonly backend: SecretBackend;
  readonly redactor: Redactor;
  /** Stores a secret (in the backend in use) and makes it the value served from now on. */
  readonly set: (name: SecretName, value: string) => Promise<void>;
  /** Creates a random 32-byte TOKEN_ENC_KEY when there is none. A present key is validated, never replaced. */
  readonly ensureEncryptionKey: () => Promise<"created" | "present">;
}

const SECRET_NAME_SET: ReadonlySet<string> = new Set(SECRET_NAMES);

function isSecretName(name: string): name is SecretName {
  return SECRET_NAME_SET.has(name);
}

const secretField = z.string().min(1).max(MAX_SECRET_CHARS).optional();
/** The key file: a JSON object of secret values, nothing else. `satisfies` keeps it in step with SECRET_NAMES. */
const KeyFile = z.strictObject({
  TOKEN_ENC_KEY: secretField,
  GOOGLE_CLIENT_ID: secretField,
  GOOGLE_CLIENT_SECRET: secretField,
} satisfies Record<SecretName, unknown>);

/** Validates a value for `name`. Errors name the secret and the rule, never the value. */
function checkValue(name: SecretName, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SECRET_CHARS || /[\p{Cc}\s]/u.test(value)) {
    throw new GwsError("GWS_INVALID_INPUT", `${name} must be 1 to ${MAX_SECRET_CHARS} printable characters without spaces`, {
      details: { fields: [name] },
    });
  }
  if (name === "TOKEN_ENC_KEY" && base64ToBytes(value)?.length !== KEY_BYTES) {
    throw new GwsError("GWS_INVALID_INPUT", "TOKEN_ENC_KEY must be base64 of exactly 32 bytes", { details: { fields: [name] } });
  }
  return value;
}

/** A value read back from a backend: invalid means the store was changed outside gws-mcp. */
function storedValue(name: SecretName, value: string): string {
  try {
    return checkValue(name, value);
  } catch {
    throw new GwsError("GWS_INTERNAL", `the stored ${name} is not valid; run setup again`);
  }
}

interface Backend {
  readonly kind: SecretBackend;
  readonly load: () => Promise<Map<SecretName, string>>;
  readonly store: (name: SecretName, value: string, all: ReadonlyMap<SecretName, string>) => Promise<void>;
}

const KEYCHAIN_SILENT = "the OS keychain did not answer (it may be locked, or access was denied): unlock your keychain and retry";

/** A keychain call; a rejection becomes the GWS error with the unlock advice, never the library's own text. */
async function keychainCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new GwsError("GWS_INTERNAL", KEYCHAIN_SILENT);
  }
}

function keychainBackend(keyring: Keyring, service: string): Backend {
  return {
    kind: { kind: "keychain" },
    async load() {
      const values = new Map<SecretName, string>();
      for (const name of SECRET_NAMES) {
        const value = await keychainCall(() => keyring.get(service, name));
        if (value !== null) values.set(name, storedValue(name, value));
      }
      return values;
    },
    async store(name, value) {
      await keychainCall(() => keyring.set(service, name, value));
      // Some stores accept a write and keep nothing; read it back before relying on it.
      if ((await keychainCall(() => keyring.get(service, name))) !== value) {
        throw new GwsError("GWS_INTERNAL", `the keychain did not keep ${name}`);
      }
    },
  };
}

function fileBackend(file: string, reason: string): Backend {
  return {
    kind: { kind: "file", path: file, reason },
    async load() {
      // Never created here, never repaired: only a regular mode 600 file of ours is read, through one descriptor.
      const text = readPrivateFile(file);
      if (text === undefined || text.trim() === "") return new Map();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new GwsError("GWS_INTERNAL", `the key file ${file} is not valid JSON`);
      }
      const r = KeyFile.safeParse(parsed);
      if (!r.success) throw new GwsError("GWS_INTERNAL", `the key file ${file} has an unexpected shape`);
      const values = new Map<SecretName, string>();
      for (const name of SECRET_NAMES) {
        const value = r.data[name];
        if (value !== undefined) values.set(name, storedValue(name, value));
      }
      return values;
    },
    async store(name, value, all) {
      const next: Partial<Record<SecretName, string>> = Object.fromEntries(all);
      next[name] = value;
      // Written to a fresh mode 600 file beside it, then renamed over it: a reader never sees a partial file.
      const tmp = path.join(path.dirname(file), `.${KEY_FILE}.${crypto.randomUUID()}.tmp`);
      const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0);
      const fd = fs.openSync(tmp, flags, PRIVATE_FILE_MODE);
      try {
        if (process.platform !== "win32") fs.fchmodSync(fd, PRIVATE_FILE_MODE);
        fs.writeFileSync(fd, `${JSON.stringify(next)}\n`);
        fs.fsyncSync(fd);
      } catch (e) {
        fs.closeSync(fd);
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      fs.closeSync(fd);
      fs.renameSync(tmp, file);
    },
  };
}

export interface OpenSecretsOptions {
  /** The private config directory (already checked by `ensurePrivateDir`). */
  dir: string;
  /** The OS keychain, or why the system has none. Tests pass a fake; `systemKeyring()` gives the real one. */
  keyring: KeyringProbe;
  /** `auto` when omitted. */
  keyStorage?: KeyStorage;
}


/**
 * Opens the secret store; every value is loaded once, here, and served from memory. Nothing is created on open.
 *
 * - `auto` with a keychain: the keychain. A keychain that does not answer (locked, denied) is refused, never
 *   replaced by a file. A key file beside it is refused, never adopted: whoever created it is unknown.
 * - `auto` without a keychain (no build for the platform, no Secret Service), or `file`: the key file. It is created
 *   by the first write, and read only when it is a regular mode 600 file of ours (anything else is refused, not
 *   repaired).
 * - The keychain and a key file both holding a key is refused: gws-mcp never guesses which one seals the tokens.
 */
export async function openSecrets(opts: OpenSecretsOptions): Promise<LocalSecrets> {
  const file = path.join(opts.dir, KEY_FILE);
  const service = keychainService(opts.dir);
  const storage = opts.keyStorage ?? "auto";
  const fileExists = readPrivateFile(file) !== undefined;
  const both = () =>
    new GwsError("GWS_INTERNAL", `the OS keychain and a key file both hold a gws-mcp key; remove the one you do not use (the key file is ${file})`);

  let backend: Backend;
  if ("keyring" in opts.keyring) {
    const keyring = opts.keyring.keyring;
    let keychainKey: string | null | undefined;
    try {
      // A read is the probe: it fails when the keychain is locked or access is denied.
      keychainKey = await keyring.get(service, "TOKEN_ENC_KEY");
    } catch {
      // With the key file chosen, a silent keychain only means the conflict check cannot run.
      if (storage === "auto") throw new GwsError("GWS_INTERNAL", KEYCHAIN_SILENT);
    }
    const keychainHasKey = typeof keychainKey === "string";
    if (storage === "file") {
      if (keychainHasKey && fileExists) throw both();
      if (keychainHasKey) {
        throw new GwsError("GWS_INTERNAL", "the OS keychain already holds a gws-mcp key; remove it from the keychain before choosing the key file");
      }
      backend = fileBackend(file, "chosen at setup");
    } else {
      if (fileExists && keychainHasKey) throw both();
      if (fileExists) {
        throw new GwsError(
          "GWS_INTERNAL",
          `a key file exists at ${file} but this system has an OS keychain; gws-mcp uses a key file only when it is chosen at setup. Remove the file, or run setup and choose the key file`,
        );
      }
      backend = keychainBackend(keyring, service);
    }
  } else {
    backend = fileBackend(file, storage === "file" ? "chosen at setup" : `no OS keychain: ${opts.keyring.unavailable}`);
  }

  const values = await backend.load();
  const redactor = createRedactor(() => values.values());
  const chosen = backend;


  async function set(name: SecretName, value: string): Promise<void> {
    if (!isSecretName(name)) throw new GwsError("GWS_INVALID_INPUT", "unknown secret name");
    const checked = checkValue(name, value);
    await chosen.store(name, checked, values);
    values.set(name, checked);
  }

  return {
    // Only secret names are answered: the type alone does not stop a caller asking for something else.
    source: { get: (name) => (isSecretName(name) ? values.get(name) : undefined) },
    backend: chosen.kind,
    redactor,
    set,
    async ensureEncryptionKey() {
      if (values.has("TOKEN_ENC_KEY")) return "present";
      await set("TOKEN_ENC_KEY", bytesToBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES))));
      return "created";
    },
  };
}

/** One line for `doctor` about where the secrets live. Never includes a value. */
export function describeBackend(b: SecretBackend): string {
  if (b.kind === "keychain") return "secrets: in the OS keychain";
  return `secrets: in the key file ${b.path} (WEAKER than the OS keychain: any program running as you can read it). Reason: ${b.reason}`;
}
