import fs from "node:fs";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { DEFAULT_CONNECT_SERVICES, GOOGLE_SERVICES, SCOPE_PRESETS, grantedServices, type GoogleService, type ScopePreset } from "../config";
import { revokeAndWipe } from "../core/accounts-capability";
import { SETTING_KEYS, SETTING_LABELS, isSettingKey, type SettingKey } from "../core/settings-capability";
import type { Account } from "../core/ports";
import { GwsError, isGwsError } from "../errors";
import { createGoogleOAuth } from "../google/oauth";
import pkg from "../../package.json";
import { sdkManifest } from "../sdk/generated/manifest";
import { runLoopbackFlow, systemOpener, connectScopes, type AbandonedGrant, type BrowserOpener } from "./oauth";
import { selfCommand, shellQuote } from "./invocation";
import { configDir, describePathCheck, ensurePrivateDir } from "./paths";
import { describeBackend, type KeyringProbe, type LocalSecrets } from "./secrets";
import { serveStdio } from "./server";
import {
  DEFAULT_WEB_PORT,
  NO_KEYCHAIN_ENV,
  SETTINGS_FILE,
  notSetUp,
  openRuntime,
  openSettingsSecrets,
  readSettings,
  resolveKeyring,
  writeSettings,
  type LocalRuntime,
  type Settings,
} from "./settings";
import { LOCAL_USER_ID, openLocalStore } from "./store";

/** The oldest Node.js the package supports: `node:sqlite` without a flag. */
export const MIN_NODE_VERSION = "22.13.0";
const GOOGLE_CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";
/** Longest stdin read for `setup --stdin` (two short lines) and `settings set --stdin` (one). */
const MAX_STDIN_BYTES = 64 * 1024;

/** Where the CLI reads and writes. Injected, so tests drive it without a terminal, a keychain or a browser. */
export interface CliIo {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  stdin: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  stdout: Writable;
  stderr: Writable;
  /** The OS keychain probe; `systemKeyring` by default. NO_KEYCHAIN_ENV bypasses it entirely. */
  keyring?: () => Promise<KeyringProbe>;
  /** Opens the sign-in URL; the OS opener by default. */
  open?: BrowserOpener;
  /** How long `accounts add` waits for the browser sign-in. */
  flowTimeoutMs?: number;
  /** How to run this CLI again, for every printed hint; `selfCommand()` by default. Never the unscoped `npx gws-mcp`. */
  self?: string;
}

/** A usage mistake: the message, then the help hint, exit code 2. */
class UsageError extends Error {}

function usage(self: string): string {
  return `gws-mcp ${pkg.version}: Google Workspace for your AI app, running on this computer.

Usage:
  ${self} setup [--client desktop|web] [--port <n>] [--preset narrow|full] [--key-file] [--stdin] [--yes]
      Saves your Google OAuth client. The client ID and secret are asked without echo, or read
      from stdin with --stdin (two lines: ID, then secret). They are never taken as arguments.
      --client   desktop (recommended; loopback on 127.0.0.1, random port) or web (fixed
                 http://localhost:<port>/google/callback, port ${DEFAULT_WEB_PORT} by default)
      --preset   narrow (default) or full Google scopes
      --key-file keep the encryption key and client secret in a file in the config folder instead
                 of the OS keychain (weaker: for machines without a usable keychain)
      --yes      replace existing choices without asking
  ${self} accounts list
  ${self} accounts add [--services gmail,drive,...] [--account <email>] [--no-browser]
      Connects a Google account (or adds services to one) in your browser. Without --services: ${DEFAULT_CONNECT_SERVICES.join(",")}.
      Others are added by name: ${GOOGLE_SERVICES.filter((s) => !DEFAULT_CONNECT_SERVICES.includes(s)).join(", ")}.
  ${self} accounts alias <account> <name>     (or --clear)
  ${self} accounts default <account>
  ${self} accounts disconnect <account> [--yes]
      Revokes gws-mcp's access at Google and deletes the stored token.
  ${self} settings set <key> [--stdin]
      Saves a Google Ads setting, encrypted like your tokens. The value is asked without echo, or read
      from the first line of stdin with --stdin. It is never taken as an argument. Keys:
      ads.developer_token     the developer token from Google Ads (Admin, then API Center)
      ads.login_customer_id   the manager account ID, if you reach Ads accounts through one
  ${self} settings clear <key>
  ${self} doctor
      Checks Node.js, the config folder, the key storage, the client and each account.
  ${self} serve
      Runs the MCP server over stdio. Claude Code: claude mcp add gws -- ${self} serve
  ${self} --version
      Prints the version and the hash of the generated Google SDK it carries.

Environment:
  GWS_MCP_CONFIG_DIR=<absolute path>   use another config folder
  ${NO_KEYCHAIN_ENV}=1                never touch the OS keychain (use with setup --key-file)
  GWS_MCP_NO_BROWSER=1                 print sign-in URLs instead of opening a browser

Testing only: setup --upstream fake --fake-url <origin> uses a fake Google.
`;
}

// ---- Output and prompts -----------------------------------------------------------------------------------

interface Ui {
  say(line?: string): void;
  warn(line: string): void;
  /** True when questions can be asked on a terminal. */
  readonly interactive: boolean;
  ask(question: string, fallback: string): Promise<string>;
  askHidden(question: string): Promise<string>;
  confirm(question: string, yes: boolean): Promise<boolean>;
}

function makeUi(io: CliIo, redact: () => (text: string) => string): Ui {
  const interactive = io.stdin.isTTY === true && typeof io.stdin.setRawMode === "function";
  const say = (line = "") => void io.stdout.write(`${redact()(line)}\n`);
  return {
    say,
    warn: (line) => void io.stderr.write(`${redact()(line)}\n`),
    interactive,
    async ask(question, fallback) {
      if (!interactive) return fallback;
      const rl = createInterface({ input: io.stdin, output: io.stdout, terminal: true });
      try {
        const answer = (await rl.question(`${question} [${fallback}]: `)).trim();
        return answer === "" ? fallback : answer;
      } finally {
        rl.close();
      }
    },
    askHidden: (question) => readHidden(io, question),
    async confirm(question, yes) {
      if (yes) return true;
      if (!interactive) throw new UsageError(`${question} Re-run with --yes to confirm.`);
      const rl = createInterface({ input: io.stdin, output: io.stdout, terminal: true });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N]: `)).trim());
      } finally {
        rl.close();
      }
    },
  };
}

/** Reads one line from the terminal without echoing it. Ctrl-C aborts. */
function readHidden(io: CliIo, question: string): Promise<string> {
  const stdin = io.stdin;
  if (stdin.isTTY !== true || typeof stdin.setRawMode !== "function") {
    return Promise.reject(new UsageError("there is no terminal to ask on; pipe the values with --stdin"));
  }
  io.stdout.write(`${question}: `);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (err?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      io.stdout.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish(new UsageError("cancelled"));
        if (ch === "\u0004") return finish();
        if (ch === "\u007f" || ch === "\b") value = [...value].slice(0, -1).join("");
        else if (ch >= " " && value.length < 4096) value += ch;
      }
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** All of stdin (bounded), for `--stdin`. `tooLong` says what to pipe instead. */
async function readAll(stdin: Readable, tooLong: string): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > MAX_STDIN_BYTES) throw new UsageError(`stdin is too long: ${tooLong}`);
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---- Arguments --------------------------------------------------------------------------------------------

type Options = NonNullable<ParseArgsConfig["options"]>;

function parse(argv: readonly string[], options: Options, positionals: number) {
  let r;
  try {
    r = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : "invalid arguments");
  }
  // Never echoed: a stray argument may be a secret pasted in the wrong place.
  if (r.positionals.length > positionals) throw new UsageError("unexpected argument (not shown)");
  return { values: r.values as Record<string, string | boolean | undefined>, positionals: r.positionals };
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`${flag} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function parseServices(value: string | undefined): GoogleService[] {
  if (value === undefined) return [...DEFAULT_CONNECT_SERVICES];
  const list = [...new Set(value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (list.length === 0) throw new UsageError("--services needs at least one service");
  return list.map((s) => oneOf("--services", s, GOOGLE_SERVICES));
}

function parsePort(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError("--port must be a number from 1 to 65535");
  return n;
}

// ---- Shared helpers ---------------------------------------------------------------------------------------

/** The account a reference names: an email (contains "@") or an alias, like the SDK's references. */
function findAccount(all: readonly Account[], ref: string, self: string): Account {
  const key = ref.trim().toLowerCase();
  const found = all.find((a) => (key.includes("@") ? a.email === key : a.alias === key));
  if (found === undefined) throw new UsageError(`no connected account is called "${ref}". See: ${self} accounts list`);
  return found;
}

function serviceList(preset: ScopePreset, scopes: readonly string[]): string {
  const granted = grantedServices(preset, scopes);
  const on = GOOGLE_SERVICES.filter((s) => granted[s]);
  return on.length > 0 ? on.join(", ") : "none";
}

function describeClient(s: Pick<Settings, "clientType" | "port" | "upstream">): string {
  const client =
    s.clientType === "desktop" ? "Desktop app (redirect to 127.0.0.1 on a random port)" : `Web application (redirect http://localhost:${s.port}/google/callback)`;
  return s.upstream === "fake" ? `${client}, with the fake Google (testing)` : client;
}

function nodeVersionOk(version: string): boolean {
  const [a = 0, b = 0, c = 0] = version.split(".").map(Number);
  const [x = 0, y = 0, z = 0] = MIN_NODE_VERSION.split(".").map(Number);
  return a !== x ? a > x : b !== y ? b > y : c >= z;
}

// ---- Commands ---------------------------------------------------------------------------------------------

interface Context {
  io: CliIo;
  ui: Ui;
  dir: string;
  keyring: () => Promise<KeyringProbe>;
  /** How to run this CLI again, in every hint. */
  self: string;
  /** Set once secrets are open, so every later line is redacted with them. */
  useRedactor(secrets: LocalSecrets): void;
}

async function withRuntime<T>(ctx: Context, fn: (rt: LocalRuntime) => Promise<T>): Promise<T> {
  const rt = await openRuntime(ctx.dir, await ctx.keyring(), ctx.self, ctx.io.env);
  ctx.useRedactor(rt.secrets);
  try {
    return await fn(rt);
  } finally {
    rt.close();
  }
}

async function setup(ctx: Context, argv: readonly string[]): Promise<number> {
  const { values } = parse(
    argv,
    {
      client: { type: "string" },
      port: { type: "string" },
      preset: { type: "string" },
      "key-file": { type: "boolean" },
      stdin: { type: "boolean" },
      yes: { type: "boolean" },
      upstream: { type: "string" },
      "fake-url": { type: "string" },
    },
    0,
  );
  const { ui, dir, io } = ctx;
  const existing = fs.existsSync(dir) ? (ensurePrivateDir(dir), readSettings(dir)) : undefined;

  const upstream = values.upstream === undefined ? (existing?.upstream ?? "google") : oneOf("--upstream", String(values.upstream), ["google", "fake"] as const);
  const fakeUrl = typeof values["fake-url"] === "string" ? values["fake-url"] : upstream === "fake" ? existing?.fakeGoogleUrl : undefined;
  if (upstream === "fake" && fakeUrl === undefined) throw new UsageError("--upstream fake needs --fake-url <origin>");
  if (upstream === "google" && values["fake-url"] !== undefined) throw new UsageError("--fake-url is only for --upstream fake");
  if (existing !== undefined && existing.upstream !== upstream) {
    throw new UsageError(`this config folder belongs to the ${existing.upstream} upstream and cannot be switched; use another GWS_MCP_CONFIG_DIR`);
  }

  const noKeychain = ctx.io.env[NO_KEYCHAIN_ENV] === "1";
  const keyStorage: Settings["keyStorage"] = values["key-file"] === true ? "file" : (existing?.keyStorage ?? "keychain");
  if (existing !== undefined && existing.keyStorage !== keyStorage) {
    throw new UsageError("the key storage cannot be changed after setup: the key in it protects your stored tokens");
  }
  if (keyStorage === "keychain" && upstream === "fake") {
    throw new UsageError("the fake Google is for tests: add --key-file (and use a throwaway GWS_MCP_CONFIG_DIR), so no keychain entry is written");
  }
  if (keyStorage === "keychain" && noKeychain) throw new UsageError(`${NO_KEYCHAIN_ENV}=1 is set, so the OS keychain cannot be used: add --key-file`);

  const clientType =
    values.client !== undefined
      ? oneOf("--client", String(values.client), ["desktop", "web"] as const)
      : oneOf("client type", await ui.ask("Google OAuth client type, desktop (recommended) or web", existing?.clientType ?? "desktop"), ["desktop", "web"] as const);
  let port = 0;
  if (clientType === "web") {
    port =
      values.port !== undefined
        ? parsePort(String(values.port))
        : parsePort(await ui.ask("Port of the Web client's redirect http://localhost:<port>/google/callback", String(existing?.port || DEFAULT_WEB_PORT)));
  } else if (values.port !== undefined) {
    throw new UsageError("--port is only for a Web client: a Desktop client gets a random port each time");
  }
  const preset =
    values.preset !== undefined
      ? oneOf("--preset", String(values.preset), SCOPE_PRESETS)
      : oneOf("preset", await ui.ask("Scope preset, narrow or full", existing?.preset ?? "narrow"), SCOPE_PRESETS);

  const next: Settings = {
    version: 1,
    keyStorage,
    clientType,
    port,
    preset,
    upstream,
    ...(fakeUrl !== undefined ? { fakeGoogleUrl: fakeUrl } : {}),
    ...(existing?.limits !== undefined ? { limits: existing.limits } : {}),
  };

  // The client ID and secret: stdin or a hidden prompt, never argv.
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  if (values.stdin === true) {
    const lines = (await readAll(io.stdin, "pipe just the client ID and secret, one per line")).split(/\r?\n/).map((l) => l.trim());
    [clientId = "", clientSecret = ""] = lines;
    if (clientId === "" || clientSecret === "") throw new UsageError("--stdin expects two lines: the client ID, then the client secret");
  } else if (ui.interactive) {
    ui.say("Paste your Google OAuth client ID and secret (nothing is shown as you type). Press Enter alone to keep the saved one.");
    clientId = (await ui.askHidden("Client ID")) || undefined;
    clientSecret = (await ui.askHidden("Client secret")) || undefined;
  } else {
    throw new UsageError("there is no terminal to ask for the client secret. Pipe the client ID and secret on two lines with --stdin");
  }
  if (clientId !== undefined && upstream === "google" && !clientId.endsWith(GOOGLE_CLIENT_ID_SUFFIX)) {
    throw new UsageError(`that is not a Google OAuth client ID (it ends with ${GOOGLE_CLIENT_ID_SUFFIX}); the ID comes first, then the secret`);
  }

  ensurePrivateDir(dir);
  const keyring = noKeychain ? await resolveKeyring(io.env) : await ctx.keyring();
  if (keyStorage === "keychain" && "unavailable" in keyring) {
    throw new UsageError(`the OS keychain cannot be used here (${keyring.unavailable}). Run setup with --key-file to keep the key in a file instead (weaker)`);
  }
  const secrets = await openSettingsSecrets(dir, keyStorage, keyring);
  ctx.useRedactor(secrets);
  const current = { id: secrets.source.get("GOOGLE_CLIENT_ID"), secret: secrets.source.get("GOOGLE_CLIENT_SECRET") };
  if (current.id === undefined && clientId === undefined) throw new UsageError("no client ID was given and none is saved");
  if (current.secret === undefined && clientSecret === undefined) throw new UsageError("no client secret was given and none is saved");

  const changes: string[] = [];
  if (existing !== undefined) {
    if (existing.clientType !== next.clientType || existing.port !== next.port) changes.push(`client type (${describeClient(existing)} -> ${describeClient(next)})`);
    if (existing.preset !== next.preset) changes.push(`scope preset (${existing.preset} -> ${next.preset})`);
    if (existing.fakeGoogleUrl !== next.fakeGoogleUrl) changes.push("fake Google URL");
  }
  const idChanged = clientId !== undefined && current.id !== undefined && clientId !== current.id;
  if (idChanged) changes.push("the saved client ID");
  if (clientSecret !== undefined && current.secret !== undefined && clientSecret !== current.secret) changes.push("the saved client secret");
  const complete = existing !== undefined && secrets.source.get("TOKEN_ENC_KEY") !== undefined && current.id !== undefined && current.secret !== undefined;
  if (complete && changes.length === 0) {
    ui.say(`gws-mcp is already set up with these choices in ${dir}; nothing changed.`);
    return 0;
  }
  if (changes.length > 0 && !(await ui.confirm(`This replaces ${changes.join(", ")}.`, values.yes === true))) {
    ui.say("Nothing changed.");
    return 1;
  }

  if (clientId !== undefined && clientId !== current.id) await secrets.set("GOOGLE_CLIENT_ID", clientId);
  if (clientSecret !== undefined && clientSecret !== current.secret) await secrets.set("GOOGLE_CLIENT_SECRET", clientSecret);
  await secrets.ensureEncryptionKey();
  const store = openLocalStore({ dir, upstream, secrets: secrets.source, redactor: secrets.redactor });
  let accounts: Account[];
  try {
    accounts = await store.accounts.listForUser(LOCAL_USER_ID);
  } finally {
    store.close();
  }
  writeSettings(dir, next);

  ui.say(`gws-mcp is set up in ${dir}.`);
  ui.say(`  ${describeBackend(secrets.backend)}`);
  ui.say(`  Google client: ${describeClient(next)}`);
  if (upstream === "google" && clientType === "web") {
    ui.say(`  Make sure http://localhost:${port}/google/callback is an Authorized redirect URI of this client in the Google Cloud console.`);
  }
  ui.say(`  Scope preset: ${preset}`);
  if (idChanged && accounts.length > 0) {
    ui.say(`Accounts connected with the previous client must be connected again (${ctx.self} accounts add --account <email>).`);
  }
  ui.say(`Next: connect a Google account with  ${ctx.self} accounts add`);
  ui.say(`Then add it to Claude Code with      claude mcp add gws -- ${ctx.self} serve`);
  return 0;
}

async function accountsList(ctx: Context): Promise<number> {
  return withRuntime(ctx, async (rt) => {
    const all = await rt.store.accounts.listForUser(LOCAL_USER_ID);
    if (all.length === 0) {
      ctx.ui.say(`No Google account is connected yet. Run: ${ctx.self} accounts add`);
      return 0;
    }
    for (const a of all) {
      const status = a.status === "active" ? "connected" : a.status === "reconnect" ? "needs reconnect" : "disconnected";
      ctx.ui.say(
        `${a.isDefault ? "* " : "  "}${a.email}${a.alias !== undefined ? ` (alias ${a.alias})` : ""}  ${status}  services: ${serviceList(rt.settings.preset, a.scopes)}`,
      );
    }
    ctx.ui.say("* = default account");
    return 0;
  });
}

async function accountsAdd(ctx: Context, argv: readonly string[]): Promise<number> {
  const { values } = parse(
    argv,
    { services: { type: "string" }, account: { type: "string" }, "no-browser": { type: "boolean" }, yes: { type: "boolean" } },
    0,
  );
  const services = parseServices(typeof values.services === "string" ? values.services : undefined);
  return withRuntime(ctx, async (rt) => {
    const { settings, store, secrets } = rt;
    if (settings.upstream === "google" && (secrets.source.get("GOOGLE_CLIENT_ID") === undefined || secrets.source.get("GOOGLE_CLIENT_SECRET") === undefined)) {
      throw new UsageError(`the Google client is not saved yet. Run: ${ctx.self} setup`);
    }
    const all = await store.accounts.listForUser(LOCAL_USER_ID);
    const expected = typeof values.account === "string" ? findAccount(all, values.account, ctx.self) : undefined;
    const noBrowser = values["no-browser"] === true || ctx.io.env.GWS_MCP_NO_BROWSER === "1";
    const opener = ctx.io.open ?? systemOpener;
    const oauth = createGoogleOAuth(rt.config, secrets.source, rt.ports.http.send);

    /**
     * Revokes a grant gws-mcp will not store. Not when the account is already stored with a token: Google revokes
     * per account and client, so that would cut off the stored account too (its new consent is harmless).
     */
    const discard = async (grant: AbandonedGrant): Promise<boolean> => {
      if (grant.sub !== undefined && (await store.accounts.findBySub(grant.sub))?.hasRefreshToken === true) return false;
      await oauth.revoke(grant.refreshToken ?? grant.accessToken);
      return true;
    };

    ctx.ui.say(`Connecting a Google account for: ${services.join(", ")}.`);
    const result = await runLoopbackFlow({
      config: rt.config,
      clientType: settings.clientType,
      port: settings.port,
      secrets: secrets.source,
      send: rt.ports.http.send,
      redactor: secrets.redactor,
      scopes: connectScopes(settings.preset, services),
      ...(expected !== undefined ? { loginHint: expected.email } : {}),
      open: noBrowser ? () => Promise.reject(new Error("no browser wanted")) : opener,
      onFallback: (startUrl) => {
        // Printed only when no browser opened. It is one-time: the first browser to open it holds the sign-in, so a
        // second visit (anyone who saw this line) is refused, and a new account still needs confirming below.
        ctx.ui.say("Open this one-time link in a browser on this computer:");
        ctx.io.stdout.write(`  ${startUrl}\n`);
      },
      discard: async (grant) => void (await discard(grant)),
      ...(ctx.io.flowTimeoutMs !== undefined ? { timeoutMs: ctx.io.flowTimeoutMs } : {}),
    });
    if (!noBrowser) ctx.ui.say("Finished in the browser.");

    const quoted = `"${result.email}"`;
    if (expected !== undefined && result.sub !== expected.sub) {
      await discard(result);
      throw new GwsError("GWS_ACCOUNT_DENIED", `Google signed in ${quoted}, not "${expected.email}"; nothing was connected. Sign in as "${expected.email}" and try again`);
    }
    const before = await store.accounts.findBySub(result.sub);
    if (before === null) {
      let confirmed = false;
      try {
        confirmed = await ctx.ui.confirm(`Connect ${quoted} to gws-mcp? It is not connected yet.`, values.yes === true);
      } finally {
        if (!confirmed) await discard(result);
      }
      if (!confirmed) {
        ctx.ui.say(`Nothing changed: ${quoted} was not connected, and its new Google grant was revoked.`);
        return 1;
      }
    }
    const account = await store.accounts.upsertConnected({
      userId: LOCAL_USER_ID,
      email: result.email,
      sub: result.sub,
      scopes: result.scopes,
      ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
    });
    await rt.ports.tokens.invalidate(account.id);
    ctx.ui.say(`${before === null ? "Connected" : "Updated"} "${account.email}". Services: ${serviceList(settings.preset, account.scopes)}.`);
    const granted = grantedServices(settings.preset, account.scopes);
    const missing = services.filter((s) => !granted[s]);
    if (missing.length > 0) {
      ctx.ui.say(`Google did not grant: ${missing.join(", ")} (a box left unticked on the consent screen?). Run ${ctx.self} accounts add --services ${missing.join(",")} --account ${shellQuote(account.email)} to add them.`);
    }
    if (account.status !== "active") {
      ctx.ui.warn("Google returned no refresh token, so this account cannot be used yet. Disconnect it, then add it again.");
      return 1;
    }
    if (account.isDefault) ctx.ui.say("It is your default account.");
    return 0;
  });
}

async function accountsAlias(ctx: Context, argv: readonly string[]): Promise<number> {
  const { values, positionals } = parse(argv, { clear: { type: "boolean" } }, 2);
  const [ref, name] = positionals;
  if (ref === undefined || (name === undefined) === (values.clear !== true)) throw new UsageError(`usage: ${ctx.self} accounts alias <account> <name>  (or --clear)`);
  return withRuntime(ctx, async (rt) => {
    const account = findAccount(await rt.store.accounts.listForUser(LOCAL_USER_ID), ref, ctx.self);
    const updated = await rt.store.accounts.setAlias(LOCAL_USER_ID, account.id, name ?? null);
    ctx.ui.say(updated.alias === undefined ? `"${updated.email}" has no alias now.` : `"${updated.email}" is now also called "${updated.alias}".`);
    return 0;
  });
}

async function accountsDefault(ctx: Context, argv: readonly string[]): Promise<number> {
  const { positionals } = parse(argv, {}, 1);
  const [ref] = positionals;
  if (ref === undefined) throw new UsageError(`usage: ${ctx.self} accounts default <account>`);
  return withRuntime(ctx, async (rt) => {
    const account = findAccount(await rt.store.accounts.listForUser(LOCAL_USER_ID), ref, ctx.self);
    const updated = await rt.store.accounts.setDefault(LOCAL_USER_ID, account.id);
    ctx.ui.say(`"${updated.email}" is now your default account.`);
    return 0;
  });
}

async function accountsDisconnect(ctx: Context, argv: readonly string[]): Promise<number> {
  const { values, positionals } = parse(argv, { yes: { type: "boolean" } }, 1);
  const [ref] = positionals;
  if (ref === undefined) throw new UsageError(`usage: ${ctx.self} accounts disconnect <account> [--yes]`);
  return withRuntime(ctx, async (rt) => {
    const account = findAccount(await rt.store.accounts.listForUser(LOCAL_USER_ID), ref, ctx.self);
    const ok = await ctx.ui.confirm(`Disconnect "${account.email}"? This revokes gws-mcp's access at Google and deletes the stored token.`, values.yes === true);
    if (!ok) {
      ctx.ui.say("Nothing changed.");
      return 1;
    }
    await revokeAndWipe(
      {
        store: { accounts: rt.ports.accounts },
        oauth: createGoogleOAuth(rt.config, rt.secrets.source, rt.ports.http.send),
        invalidateToken: rt.ports.tokens.invalidate,
      },
      LOCAL_USER_ID,
      account.id,
    );
    ctx.ui.say(`Disconnected "${account.email}": its access at Google is revoked and its token deleted.`);
    return 0;
  });
}

function settingKey(ctx: Context, key: string | undefined, usageLine: string): SettingKey {
  // An unknown key is never echoed: it may be a value pasted in the wrong place.
  if (!isSettingKey(key)) throw new UsageError(`usage: ${ctx.self} ${usageLine} (key: ${SETTING_KEYS.join(" or ")})`);
  return key;
}

/** `settings set <key>`: the value comes from a hidden prompt or stdin, never argv, and is never printed. */
async function settingsSet(ctx: Context, argv: readonly string[]): Promise<number> {
  const { values, positionals } = parse(argv, { stdin: { type: "boolean" } }, 1);
  const key = settingKey(ctx, positionals[0], "settings set <key> [--stdin]");
  const label = SETTING_LABELS[key];
  if (values.stdin !== true && !ctx.ui.interactive) {
    throw new UsageError(`there is no terminal to ask for the ${label}. Pipe it on one line with --stdin`);
  }
  return withRuntime(ctx, async (rt) => {
    const raw =
      values.stdin === true
        ? ((await readAll(ctx.io.stdin, `pipe just the ${label} on one line`)).split(/\r?\n/)[0] ?? "")
        : await ctx.ui.askHidden(`${label} (nothing is shown as you type)`);
    const value = raw.trim();
    if (value === "") throw new UsageError(`no ${label} was given; nothing changed`);
    // Remembered before anything else is printed, so no later line can show it.
    rt.secrets.redactor.remember(value);
    await rt.store.settings.set(LOCAL_USER_ID, key, value);
    ctx.ui.say(`Saved the ${label}.`);
    return 0;
  });
}

async function settingsClear(ctx: Context, argv: readonly string[]): Promise<number> {
  const { positionals } = parse(argv, {}, 1);
  const key = settingKey(ctx, positionals[0], "settings clear <key>");
  return withRuntime(ctx, async (rt) => {
    const cleared = await rt.store.settings.clear(LOCAL_USER_ID, key);
    ctx.ui.say(cleared ? `Removed the saved ${SETTING_LABELS[key]}.` : `No ${SETTING_LABELS[key]} was saved; nothing changed.`);
    return 0;
  });
}

async function doctor(ctx: Context): Promise<number> {
  const { ui, dir } = ctx;
  let failed = false;
  const ok = (line: string) => ui.say(`ok    ${line}`);
  const warn = (line: string) => ui.say(`warn  ${line}`);
  const fail = (line: string) => {
    failed = true;
    ui.say(`FAIL  ${line}`);
  };
  const errText = (e: unknown) => (isGwsError(e) ? e.message : e instanceof Error ? e.message : "unexpected failure");

  const node = process.versions.node;
  if (nodeVersionOk(node)) ok(`Node.js ${node}`);
  else fail(`Node.js ${node} is too old: gws-mcp needs ${MIN_NODE_VERSION} or newer`);

  if (!fs.existsSync(dir)) {
    fail(`config folder ${dir} does not exist: gws-mcp is not set up yet. Run: ${ctx.self} setup`);
    return 1;
  }
  let settings: Settings | undefined;
  try {
    const check = ensurePrivateDir(dir);
    (check.action === "repaired" ? warn : ok)(describePathCheck(check));
    settings = readSettings(dir);
    if (settings === undefined) {
      fail(notSetUp(dir, ctx.self).message);
      return 1;
    }
    ok(`settings file ${SETTINGS_FILE} (private): ${describeClient(settings)}, scope preset ${settings.preset}, key storage ${settings.keyStorage}`);
  } catch (e) {
    fail(errText(e));
    return 1;
  }

  let rt: LocalRuntime;
  try {
    rt = await openRuntime(dir, await ctx.keyring(), ctx.self, ctx.io.env);
  } catch (e) {
    fail(errText(e));
    return 1;
  }
  ctx.useRedactor(rt.secrets);
  try {
    const backend = describeBackend(rt.secrets.backend);
    (rt.secrets.backend.kind === "keychain" ? ok : warn)(backend);
    for (const check of rt.checks.slice(1)) (check.action === "repaired" ? warn : ok)(describePathCheck(check));
    if (rt.settings.upstream === "fake") ok("Google client: not needed with the fake Google");
    else if (rt.secrets.source.get("GOOGLE_CLIENT_ID") !== undefined && rt.secrets.source.get("GOOGLE_CLIENT_SECRET") !== undefined) ok("Google client: ID and secret are saved");
    else fail(`Google client: not saved. Run: ${ctx.self} setup`);

    const accounts = await rt.store.accounts.listForUser(LOCAL_USER_ID);
    if (accounts.length === 0) warn(`no Google account is connected yet. Run: ${ctx.self} accounts add`);
    for (const a of accounts) {
      if (a.status !== "active") {
        fail(`${a.email}: needs to be connected again. Run: ${ctx.self} accounts add --account ${shellQuote(a.email)}`);
        continue;
      }
      try {
        // One token refresh, no API call.
        await rt.ports.tokens.getAccessToken(a);
        ok(`${a.email}: token refresh works`);
      } catch (e) {
        fail(`${a.email}: token refresh failed: ${errText(e)}`);
      }
    }
  } finally {
    rt.close();
  }
  return failed ? 1 : 0;
}

async function serve(ctx: Context, argv: readonly string[]): Promise<number> {
  parse(argv, {}, 0);
  return withRuntime(ctx, async (rt) => {
    const count = (await rt.store.accounts.listForUser(LOCAL_USER_ID)).length;
    ctx.ui.warn(`gws-mcp ${pkg.version}: serving search and execute over stdio (${count} account${count === 1 ? "" : "s"} connected).`);
    await serveStdio({ ports: rt.ports, config: rt.config, self: ctx.self, stdin: ctx.io.stdin, stdout: ctx.io.stdout });
    return 0;
  });
}

/** Runs one CLI command. Returns the exit code: 0 done, 1 failed, 2 usage error. Never throws. */
export async function runCli(io: CliIo): Promise<number> {
  let redactor: ((text: string) => string) | undefined;
  const ui = makeUi(io, () => redactor ?? ((t) => t));
  const self = io.self ?? selfCommand();
  const [command, ...rest] = io.argv;
  try {
    const ctx: Context = {
      io,
      ui,
      dir: configDir(io.env),
      keyring: () => resolveKeyring(io.env, io.keyring),
      self,
      useRedactor: (secrets) => {
        redactor = secrets.redactor.redact;
      },
    };
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      io.stdout.write(usage(self));
      return 0;
    }
    if (command === "--version" || command === "-v") {
      io.stdout.write(`gws-mcp ${pkg.version} (sdk ${sdkManifest.hash})\n`);
      return 0;
    }
    switch (command) {
      case "setup":
        return await setup(ctx, rest);
      case "doctor":
        parse(rest, {}, 0);
        return await doctor(ctx);
      case "serve":
        return await serve(ctx, rest);
      case "accounts": {
        const [sub, ...args] = rest;
        if (sub === "list") {
          parse(args, {}, 0);
          return await accountsList(ctx);
        }
        if (sub === "add") return await accountsAdd(ctx, args);
        if (sub === "alias") return await accountsAlias(ctx, args);
        if (sub === "default") return await accountsDefault(ctx, args);
        if (sub === "disconnect") return await accountsDisconnect(ctx, args);
        throw new UsageError(`usage: ${self} accounts list|add|alias|default|disconnect`);
      }
      case "settings": {
        const [sub, ...args] = rest;
        if (sub === "set") return await settingsSet(ctx, args);
        if (sub === "clear") return await settingsClear(ctx, args);
        throw new UsageError(`usage: ${self} settings set|clear <key>`);
      }
      default:
        // Never echoed: it may be a secret pasted in the wrong place.
        throw new UsageError("unknown command (not shown)");
    }
  } catch (e) {
    if (e instanceof UsageError) {
      ui.warn(`gws-mcp: ${e.message}`);
      ui.warn(`Run ${self} --help for usage.`);
      return 2;
    }
    if (isGwsError(e) || e instanceof GwsError) {
      ui.warn(`gws-mcp: ${e.message}`);
      return 1;
    }
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    ui.warn(`gws-mcp: unexpected failure${typeof code === "string" ? ` (${code})` : ""}${e instanceof Error ? `: ${e.message}` : ""}`);
    return 1;
  }
}
