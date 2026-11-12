import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SCOPE_PRESETS, loadConfig, type Config, type ConfigEnv } from "../config";
import type { CorePorts } from "../core/ports";
import { GwsError } from "../errors";
import { PRIVATE_FILE_MODE, ensurePrivateDir, readPrivateFile, type PathCheck } from "./paths";
import { localPorts } from "./ports";
import { openSecrets, systemKeyring, type KeyringProbe, type LocalSecrets } from "./secrets";
import { openLocalStore, type LocalStore } from "./store";

/** The settings file in the config directory: what `setup` chose. No secret is ever written here. */
export const SETTINGS_FILE = "config.json";
/** The fixed port of the operator's existing Web client (redirect `http://localhost:8787/google/callback`). */
export const DEFAULT_WEB_PORT = 8787;
/**
 * Set to `1` to keep gws-mcp away from the OS keychain entirely (not even a probe): headless machines, CI and test
 * runs. Only the key file can be used then; a setup that chose the keychain is refused rather than silently moved.
 */
export const NO_KEYCHAIN_ENV = "GWS_MCP_NO_KEYCHAIN";
/** The environment variable that would turn on human approval; locally only `off` is accepted (see `settingsConfig`). */
export const HUMAN_APPROVAL_ENV = "GWS_HUMAN_APPROVAL";

/** The config limits a user may tune; each is bounded by the shared config schema. */
const LIMIT_KEYS = [
  "CALLS_PER_EXECUTE",
  "CALL_RESPONSE_MAX_BYTES",
  "RESULT_MAX_BYTES",
  "RATE_USER_PER_MIN",
  "RATE_CLIENT_PER_MIN",
  "SEARCH_MAX_BYTES",
  "EXECUTE_TIMEOUT_MS",
  "EXECUTE_RESPONSE_MAX_BYTES",
  "UPSTREAM_CONCURRENCY",
  "CALL_INPUT_MAX_BYTES",
] as const satisfies readonly (keyof ConfigEnv)[];

const Limits = z.strictObject(Object.fromEntries(LIMIT_KEYS.map((k) => [k, z.number().int().positive().optional()])) as Record<
  (typeof LIMIT_KEYS)[number],
  z.ZodOptional<z.ZodNumber>
>);

const HttpOrigin = z.string().refine((v) => {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === v;
  } catch {
    return false;
  }
}, "must be an origin");

/**
 * The settings file, version 1:
 * - `keyStorage`: where the encryption key and the Google client secret live, `keychain` (default) or `file` (the
 *   mode 600 key file, weaker, chosen with `--key-file`). Fixed after setup: the key seals the stored tokens.
 * - `clientType`: `desktop` (loopback redirect on 127.0.0.1, random port) or `web` (fixed
 *   `http://localhost:<port>/google/callback`).
 * - `port`: the Web client's fixed port; 0 for a Desktop client (a random port per sign-in).
 * - `preset`: the scope preset, `narrow` or `full`.
 * - `upstream`: `google`, or `fake` with `fakeGoogleUrl` (tests only). Fixed after setup: the database records it.
 * - `limits`: optional overrides of the shared config limits, bounded by its schema.
 */
export const Settings = z
  .strictObject({
    version: z.literal(1),
    keyStorage: z.enum(["keychain", "file"]),
    clientType: z.enum(["desktop", "web"]),
    port: z.number().int().min(0).max(65535),
    preset: z.enum(SCOPE_PRESETS),
    upstream: z.enum(["google", "fake"]),
    fakeGoogleUrl: HttpOrigin.optional(),
    limits: Limits.optional(),
  })
  .superRefine((s, ctx) => {
    if (s.clientType === "web" && s.port < 1) ctx.addIssue({ code: "custom", path: ["port"], message: "a Web client needs its fixed port" });
    if (s.clientType === "desktop" && s.port !== 0) ctx.addIssue({ code: "custom", path: ["port"], message: "a Desktop client uses a random port (0)" });
    // The fake is for tests: its setups never write keychain entries (they would sit beside the real ones).
    if (s.upstream === "fake" && s.keyStorage === "keychain") ctx.addIssue({ code: "custom", path: ["keyStorage"], message: "the fake upstream uses the key file" });
    if ((s.upstream === "fake") !== (s.fakeGoogleUrl !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["fakeGoogleUrl"], message: "set exactly when the upstream is fake" });
    }
  });
export type Settings = z.output<typeof Settings>;

/** The settings in `dir`, or undefined before setup. A file that is not ours, not mode 600 or malformed is refused. */
export function readSettings(dir: string): Settings | undefined {
  const file = path.join(dir, SETTINGS_FILE);
  const text = readPrivateFile(file);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GwsError("GWS_INTERNAL", `the settings file ${file} is not valid JSON; run setup again`);
  }
  const r = Settings.safeParse(parsed);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? "?")))].sort();
    throw new GwsError("GWS_INTERNAL", `the settings file ${file} is not valid (${fields.join(", ")}); run setup again`);
  }
  // Validated against the shared config too (the limits' bounds), so a bad file fails here, not at the first call.
  settingsConfig(r.data);
  return r.data;
}

/** Writes the settings atomically: a fresh mode 600 file beside it, renamed over it. */
export function writeSettings(dir: string, settings: Settings): void {
  const checked = Settings.parse(settings);
  settingsConfig(checked);
  const file = path.join(dir, SETTINGS_FILE);
  const tmp = path.join(dir, `.${SETTINGS_FILE}.${crypto.randomUUID()}.tmp`);
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(tmp, flags, PRIVATE_FILE_MODE);
  try {
    if (process.platform !== "win32") fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    fs.writeFileSync(fd, `${JSON.stringify(checked, null, 2)}\n`);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

/** The origin Google redirects to: the Web client's fixed `http://localhost:<port>`, or the Desktop loopback. */
export function redirectOrigin(settings: Pick<Settings, "clientType" | "port">, desktopPort?: number): string {
  if (settings.clientType === "web") return `http://localhost:${settings.port}`;
  return desktopPort === undefined ? "http://127.0.0.1" : `http://127.0.0.1:${desktopPort}`;
}

/**
 * The shared config the local runtime runs with: the settings' upstream and preset, the defaults or the settings'
 * limits (CALL_INPUT_MAX_BYTES among them, which sizes the sandbox bridge), and the redirect origin as
 * PUBLIC_BASE_URL. `humanApproval` is the GWS_HUMAN_APPROVAL environment variable: locally only `off` (or unset) is
 * accepted, since no web page exists where a person could approve. Fails with GWS_INTERNAL naming the bad keys.
 */
export function settingsConfig(settings: Settings, publicBaseUrl = redirectOrigin(settings), humanApproval?: string): Config {
  return loadConfig(
    {
      ...settings.limits,
      GOOGLE_UPSTREAM: settings.upstream,
      PUBLIC_BASE_URL: publicBaseUrl,
      FAKE_GOOGLE_PUBLIC_URL: settings.fakeGoogleUrl,
      GOOGLE_SCOPE_PRESET: settings.preset,
      GWS_HUMAN_APPROVAL: humanApproval,
    },
    "local",
  );
}

/** The keyring to use: none at all when NO_KEYCHAIN_ENV is set, else what the platform offers. */
export async function resolveKeyring(env: Readonly<Record<string, string | undefined>>, system: () => Promise<KeyringProbe> = systemKeyring): Promise<KeyringProbe> {
  if (env[NO_KEYCHAIN_ENV] === "1") return { unavailable: `${NO_KEYCHAIN_ENV}=1 is set` };
  return system();
}

/** Opens the secrets as the settings say: the keychain (refused when there is none now) or the key file. */
export async function openSettingsSecrets(dir: string, keyStorage: Settings["keyStorage"], keyring: KeyringProbe): Promise<LocalSecrets> {
  if (keyStorage === "keychain" && "unavailable" in keyring) {
    throw new GwsError(
      "GWS_INTERNAL",
      `setup chose the OS keychain, but it cannot be used now (${keyring.unavailable}). The key that protects your tokens is there; use gws-mcp where the keychain is available`,
    );
  }
  return openSecrets({ dir, keyring, keyStorage: keyStorage === "keychain" ? "auto" : "file" });
}

/** Everything a CLI command or `serve` needs, opened from the config directory. */
export interface LocalRuntime {
  dir: string;
  settings: Settings;
  config: Config;
  secrets: LocalSecrets;
  store: LocalStore;
  ports: CorePorts;
  /** What opening found at the config directory and the database files. */
  checks: readonly PathCheck[];
  close(): void;
}

/** Thrown before setup: the message tells the user what to run. */
export function notSetUp(dir: string, self: string): GwsError {
  return new GwsError("GWS_INTERNAL", `gws-mcp is not set up in ${dir} yet. Run: ${self} setup`);
}

/**
 * Opens the runtime from `dir` (`self`: how to run the CLI, for the hints in its errors): the settings, the secrets in the chosen storage, the store with the settings'
 * upstream, and the ports built from the settings' config. Fails before setup, or when the key is missing.
 */
export async function openRuntime(dir: string, keyring: KeyringProbe, self: string, env: Readonly<Record<string, string | undefined>> = {}): Promise<LocalRuntime> {
  if (!fs.existsSync(dir)) throw notSetUp(dir, self);
  const dirCheck = ensurePrivateDir(dir);
  const settings = readSettings(dir);
  if (settings === undefined) throw notSetUp(dir, self);
  const secrets = await openSettingsSecrets(dir, settings.keyStorage, keyring);
  if (secrets.source.get("TOKEN_ENC_KEY") === undefined) {
    throw new GwsError("GWS_INTERNAL", `the encryption key is missing from the chosen key storage. Run: ${self} setup`);
  }
  const config = settingsConfig(settings, redirectOrigin(settings), env[HUMAN_APPROVAL_ENV]);
  const store = openLocalStore({ dir, upstream: settings.upstream, secrets: secrets.source, redactor: secrets.redactor });
  try {
    const ports = localPorts({ config, store, secrets });
    return { dir, settings, config, secrets, store, ports, checks: [dirCheck, ...store.checks.slice(1)], close: () => store.close() };
  } catch (e) {
    store.close();
    throw e;
  }
}
