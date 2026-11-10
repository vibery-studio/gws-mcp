import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliIo } from "../../src/local/commands";
import { NPX_COMMAND, PACKAGE_NAME, selfCommand, shellQuote } from "../../src/local/invocation";
import { KEY_FILE, keychainService, type KeyringProbe } from "../../src/local/secrets";
import { SETTINGS_FILE } from "../../src/local/settings";
import { FAKE_URL, memoryKeyring, stubFakeGoogle, tempDir, type FakeGoogle } from "./helpers";

const CLIENT_ID = "1234-test.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-cli-test-secret-value";
const OTHER_SECRET = "GOCSPX-cli-test-other-secret";
/** How the tests' CLI says it is run: distinct from the bare name, so a hint that skips the helper shows up. */
const SELF = "node '/opt/gws mcp/cli.js'";

let fake: FakeGoogle;
let dir: string;
let cleanup: () => void;
let keyring: ReturnType<typeof memoryKeyring>;
let probes: number;
/** Every line any command wrote in the current test. */
let transcript: string[];

beforeEach(() => {
  fake = stubFakeGoogle({ anyRedirectUri: true });
  const t = tempDir();
  dir = t.dir;
  cleanup = t.cleanup;
  keyring = memoryKeyring();
  probes = 0;
  transcript = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const entry = (name: string) => keyring.entries.get(`${keychainService(dir)}\u0000${name}`);

async function seed(...emails: string[]): Promise<void> {
  const accounts = emails.map((email) => ({ email, sub: `sub-${email}` }));
  const r = await fake.handler(
    new Request("http://fake-google/__fake/seed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accounts }) }),
  );
  if (!r.ok) throw new Error("seed failed");
}

function get(url: URL, cookie?: string): Promise<{ status: number; location: string | null; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: Number(url.port), path: `${url.pathname}${url.search}`, headers: { host: url.host, ...(cookie ? { cookie } : {}) } }, (r) => {
        r.resume();
        r.on("end", () => resolve({ status: r.statusCode ?? 0, location: r.headers.location ?? null, setCookie: r.headers["set-cookie"] ?? [] }));
      })
      .on("error", reject);
  });
}

/** The browser: opens the start link, consents at the fake as `email` and follows the redirect back with its cookie. */
function browserAs(email: string, opened: string[] = []) {
  return async (url: string) => {
    opened.push(url);
    const start = await get(new URL(url));
    const cookie = (start.setCookie[0] ?? "").split(";")[0];
    const u = new URL(start.location ?? "");
    const res = await fake.handler(
      new Request(`http://fake-google${u.pathname}/approve`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...Object.fromEntries(u.searchParams), email, decision: "allow" }).toString(),
        redirect: "manual",
      }),
    );
    await get(new URL(res.headers.get("location") ?? ""), cookie);
  };
}

interface Run {
  code: number;
  out: string;
  err: string;
}

/** Runs one command with piped (non-terminal) stdin. */
async function cli(argv: string[], o: { stdin?: string; env?: Record<string, string>; open?: CliIo["open"]; keyring?: () => Promise<KeyringProbe> } = {}): Promise<Run> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c: Buffer) => (out += c.toString()));
  stderr.on("data", (c: Buffer) => (err += c.toString()));
  stdin.end(o.stdin ?? "");
  const code = await runCli({
    argv,
    env: { GWS_MCP_CONFIG_DIR: dir, ...o.env },
    stdin,
    stdout,
    stderr,
    self: SELF,
    keyring:
      o.keyring ??
      (async () => {
        probes++;
        return { keyring };
      }),
    open: o.open ?? (async () => undefined),
    flowTimeoutMs: 5000,
  });
  transcript.push(out, err);
  return { code, out, err };
}

const setupFake = (extra: string[] = [], stdin = `${CLIENT_ID}\n${CLIENT_SECRET}\n`, env?: Record<string, string>) =>
  cli(["setup", "--stdin", "--key-file", "--upstream", "fake", "--fake-url", FAKE_URL, "--client", "desktop", "--preset", "narrow", ...extra], {
    stdin,
    ...(env ? { env } : {}),
  });
/** A real-Google setup in the (fake) keychain: setup itself never calls Google. */
const setupGoogle = (extra: string[] = [], stdin = `${CLIENT_ID}\n${CLIENT_SECRET}\n`) =>
  cli(["setup", "--stdin", "--client", "desktop", "--preset", "narrow", ...extra], { stdin });

const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe("gws-mcp help", () => {
  it("prints usage with its own invocation, and refuses unknown commands with exit code 2 without echoing them", async () => {
    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain(`${SELF} setup [--client desktop|web]`);
    expect(help.out).toContain(`claude mcp add gws -- ${SELF} serve`);
    const bad = await cli(["GOCSPX-pasted-by-mistake"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("unknown command (not shown)");
    expect(bad.err).not.toContain("GOCSPX-pasted-by-mistake");
  });

  it("never echoes a stray argument, which may be a pasted secret", async () => {
    for (const argv of [["setup", "GOCSPX-stray-secret"], ["doctor", "GOCSPX-stray-secret"], ["accounts", "list", "GOCSPX-stray-secret"], ["accounts", "GOCSPX-stray-secret"]]) {
      const r = await cli(argv);
      expect(r.code).toBe(2);
      expect(r.out + r.err).not.toContain("GOCSPX-stray-secret");
    }
  });
});

describe("the invocation the CLI prints", () => {
  it("never tells anyone to run npx, nor the bare name that is not on PATH", async () => {
    await seed("a@fake.test", "b@fake.test");
    await cli(["--help"]);
    await cli(["doctor"]);
    await cli(["accounts", "list"]);
    await setupFake();
    await setupFake();
    await cli(["doctor"]);
    await cli(["accounts", "list"]);
    await cli(["accounts", "add", "--services", "gmail"], { open: browserAs("a@fake.test") });
    await cli(["accounts", "add", "--services", "gmail", "--yes"], { open: browserAs("a@fake.test") });
    await cli(["accounts", "alias", "a@fake.test", "work"]);
    await cli(["accounts", "default", "work"]);
    await cli(["accounts", "disconnect", "work"]);
    await cli(["accounts", "disconnect", "work", "--yes"]);
    await cli(["doctor"]);
    await cli(["accounts", "frob"]);
    const all = transcript.join("\n");
    expect(all).not.toMatch(/npx/i);
    expect(all).not.toMatch(/(^|[\s"'`(])gws-mcp (setup|accounts|doctor|serve)\b/m);
    expect(all).toContain(`Run: ${SELF} setup`);
    expect(all).toContain(`claude mcp add gws -- ${SELF} serve`);
    expect(all).toContain(`${SELF} accounts add --account a@fake.test`);
  }, 30_000);

  it("is the bare name only when that name on PATH is this very CLI, else node and the CLI's real path", () => {
    const t = tempDir();
    try {
      const root = path.dirname(t.dir);
      const cliFile = path.join(root, "pkg dir", "cli.js");
      fs.mkdirSync(path.dirname(cliFile), { recursive: true });
      fs.writeFileSync(cliFile, "");
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      const node = path.join(root, "node-real");
      fs.writeFileSync(node, "");
      const real = (p: string) => fs.realpathSync(p);
      // No gws-mcp on PATH, no node on PATH: the absolute Node and the quoted real path.
      expect(selfCommand({ cliPath: cliFile, pathEnv: bin, execPath: node, platform: "darwin" })).toBe(`${node} '${real(cliFile)}'`);
      // PATH's node is this Node.
      fs.symlinkSync(node, path.join(bin, "node"));
      expect(selfCommand({ cliPath: cliFile, pathEnv: bin, execPath: node, platform: "darwin" })).toBe(`node '${real(cliFile)}'`);
      // A gws-mcp on PATH that is another program (the unrelated npm package): still node and the path.
      const other = path.join(root, "other.js");
      fs.writeFileSync(other, "");
      fs.symlinkSync(other, path.join(bin, "gws-mcp"));
      expect(selfCommand({ cliPath: cliFile, pathEnv: bin, execPath: node, platform: "darwin" })).toBe(`node '${real(cliFile)}'`);
      // The installed bin of this CLI.
      fs.rmSync(path.join(bin, "gws-mcp"));
      fs.symlinkSync(cliFile, path.join(bin, "gws-mcp"));
      expect(selfCommand({ cliPath: cliFile, pathEnv: bin, execPath: node, platform: "darwin" })).toBe("gws-mcp");
      // A node_modules/.bin that npx or npm run put on PATH for this run only does not count: the name would not
      // resolve later, from the MCP client's own PATH.
      const local = path.join(root, "project", "node_modules", ".bin");
      fs.mkdirSync(local, { recursive: true });
      fs.symlinkSync(cliFile, path.join(local, "gws-mcp"));
      fs.symlinkSync(node, path.join(local, "node"));
      expect(selfCommand({ cliPath: cliFile, pathEnv: local, execPath: node, platform: "darwin" })).toBe(`${node} '${real(cliFile)}'`);
    } finally {
      t.cleanup();
    }
  });

  it("is npx of the scoped package only when this copy is that package in npx's cache, and never the unscoped name", () => {
    const t = tempDir();
    try {
      const pkg = (root: string, name: string) => {
        const cliFile = path.join(root, "dist", "cli.js");
        fs.mkdirSync(path.dirname(cliFile), { recursive: true });
        fs.writeFileSync(cliFile, "");
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
        return cliFile;
      };
      const self = (cliPath: string) => selfCommand({ cliPath, pathEnv: "", execPath: "/usr/bin/node", platform: "darwin" });
      const viaNpx = pkg(path.join(t.dir, "_npx", "0a1b2c", "node_modules", "@bnqtoan", "gws-mcp"), PACKAGE_NAME);
      expect(self(viaNpx)).toBe(NPX_COMMAND);
      expect(NPX_COMMAND).toBe("npx -y @bnqtoan/gws-mcp");
      // The same layout naming another package, the package in a project's node_modules, and the unrelated unscoped
      // package in npx's cache: each is run by its path, never by a name npx would download.
      const otherName = pkg(path.join(t.dir, "_npx", "3d4e5f", "node_modules", "@bnqtoan", "gws-mcp"), "gws-mcp");
      const inProject = pkg(path.join(t.dir, "project", "node_modules", "@bnqtoan", "gws-mcp"), PACKAGE_NAME);
      const unscoped = pkg(path.join(t.dir, "_npx", "6a7b8c", "node_modules", "gws-mcp"), "gws-mcp");
      for (const cliFile of [otherName, inProject, unscoped]) {
        expect(self(cliFile)).toBe(`/usr/bin/node ${fs.realpathSync(cliFile)}`);
      }
      for (const cliFile of [viaNpx, otherName, inProject, unscoped]) {
        expect(self(cliFile)).not.toMatch(/npx\s+(-y\s+)?gws-mcp/);
      }
    } finally {
      t.cleanup();
    }
  });

  it("names the package it is published as", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { name: string; bin: Record<string, string> };
    expect(manifest.name).toBe(PACKAGE_NAME);
    expect(Object.keys(manifest.bin)).toEqual(["gws-mcp"]);
  });

  it("quotes arguments for the shell only when needed", () => {
    expect(shellQuote("me@example.com")).toBe("me@example.com");
    expect(shellQuote("o'neil@example.com")).toBe(`'o'\\''neil@example.com'`);
    expect(shellQuote("a b; rm -rf ~")).toBe("'a b; rm -rf ~'");
    expect(shellQuote('C:\\Program Files\\x "y"', "win32")).toBe('"C:\\Program Files\\x ""y"""');
  });
});

describe("gws-mcp setup", () => {
  it("reads the client from stdin, keeps it in this folder's keychain entries, and writes only choices to a mode 600 settings file", async () => {
    const r = await setupGoogle();
    expect(r.code).toBe(0);
    expect(r.out).toContain("gws-mcp is set up");
    expect(r.out).toContain("secrets: in the OS keychain");
    expect(entry("GOOGLE_CLIENT_ID")).toBe(CLIENT_ID);
    expect(entry("GOOGLE_CLIENT_SECRET")).toBe(CLIENT_SECRET);
    expect(entry("TOKEN_ENC_KEY")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    const file = path.join(dir, SETTINGS_FILE);
    expect(mode(file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    const text = fs.readFileSync(file, "utf8");
    expect(JSON.parse(text)).toEqual({ version: 1, keyStorage: "keychain", clientType: "desktop", port: 0, preset: "narrow", upstream: "google" });
    for (const secret of [CLIENT_SECRET, CLIENT_ID]) {
      expect(text).not.toContain(secret);
      expect(r.out + r.err).not.toContain(secret);
    }
    expect(fs.existsSync(path.join(dir, KEY_FILE))).toBe(false);
  });

  it("is idempotent, and replaces a saved value only when confirmed", async () => {
    expect((await setupGoogle()).code).toBe(0);
    const again = await setupGoogle();
    expect(again).toMatchObject({ code: 0, out: expect.stringContaining("nothing changed") });

    const unconfirmed = await setupGoogle([], `${CLIENT_ID}\n${OTHER_SECRET}\n`);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.err).toContain("This replaces the saved client secret. Re-run with --yes to confirm.");
    expect(entry("GOOGLE_CLIENT_SECRET")).toBe(CLIENT_SECRET);

    const confirmed = await setupGoogle(["--yes", "--preset", "full"], `${CLIENT_ID}\n${OTHER_SECRET}\n`);
    expect(confirmed.code).toBe(0);
    expect(entry("GOOGLE_CLIENT_SECRET")).toBe(OTHER_SECRET);
    expect(JSON.parse(fs.readFileSync(path.join(dir, SETTINGS_FILE), "utf8"))).toMatchObject({ preset: "full" });
    expect(confirmed.out + confirmed.err).not.toContain(OTHER_SECRET);
  });

  it("uses a mode 600 key file with --key-file, and never probes the keychain when told not to", async () => {
    const r = await setupFake([], undefined, { GWS_MCP_NO_KEYCHAIN: "1" });
    expect(r.code).toBe(0);
    expect(probes).toBe(0);
    expect(keyring.entries.size).toBe(0);
    expect(mode(path.join(dir, KEY_FILE))).toBe(0o600);
    expect(r.out).toContain("WEAKER than the OS keychain");
    const doctor = await cli(["doctor"], { env: { GWS_MCP_NO_KEYCHAIN: "1" } });
    expect(probes).toBe(0);
    expect(doctor.out).toMatch(/warn {2}secrets: in the key file .* \(WEAKER/);
  });

  it("refuses the keychain for the fake Google, so test setups never write keychain entries", async () => {
    const r = await cli(["setup", "--stdin", "--upstream", "fake", "--fake-url", FAKE_URL, "--client", "desktop", "--preset", "narrow"], {
      stdin: `${CLIENT_ID}\n${CLIENT_SECRET}\n`,
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("the fake Google is for tests: add --key-file");
    expect(keyring.entries.size).toBe(0);
    expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false);
  });

  it("refuses a settings file edited to put the fake Google's secrets in the keychain", async () => {
    expect((await setupFake()).code).toBe(0);
    const file = path.join(dir, SETTINGS_FILE);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), keyStorage: "keychain" }));
    const r = await cli(["doctor"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL {2}the settings file .*config\.json is not valid \(keyStorage\); run setup again/);
    expect(keyring.entries.size).toBe(0);
  });

  it("refuses what would lose access or put a secret in the wrong place", async () => {
    // No terminal and no --stdin: there is nowhere to read the secret from (argv is never one).
    const noInput = await cli(["setup", "--upstream", "fake", "--fake-url", FAKE_URL, "--key-file", "--client", "desktop", "--preset", "narrow"]);
    expect(noInput).toMatchObject({ code: 2, err: expect.stringContaining("Pipe the client ID and secret on two lines with --stdin") });
    const unknownFlag = await cli(["setup", "--client-secret", CLIENT_SECRET]);
    expect(unknownFlag.code).toBe(2);
    expect(unknownFlag.err).not.toContain(CLIENT_SECRET);
    // The keychain cannot be chosen when it must not be touched.
    const noKeychain = await cli(["setup", "--stdin", "--client", "desktop", "--preset", "narrow"], {
      stdin: `${CLIENT_ID}\n${CLIENT_SECRET}\n`,
      env: { GWS_MCP_NO_KEYCHAIN: "1" },
    });
    expect(noKeychain.err).toContain("add --key-file");
    // An ID that is not a Google client ID (swapped lines, say) in google mode.
    const swapped = await setupGoogle([], `${CLIENT_SECRET}\n${CLIENT_ID}\n`);
    expect(swapped).toMatchObject({ code: 2, err: expect.stringContaining("not a Google OAuth client ID") });
    expect(swapped.err).not.toContain(CLIENT_SECRET);

    expect((await setupGoogle()).code).toBe(0);
    expect((await setupGoogle(["--key-file", "--yes"])).err).toContain("the key storage cannot be changed after setup");
    const toFake = await cli(["setup", "--stdin", "--upstream", "fake", "--fake-url", FAKE_URL, "--key-file", "--client", "desktop", "--preset", "narrow", "--yes"], {
      stdin: `${CLIENT_ID}\n${CLIENT_SECRET}\n`,
    });
    expect(toFake.err).toContain("cannot be switched");
  });

  it("stores a Web client's fixed port and tells which redirect URI to register", async () => {
    const r = await cli(["setup", "--stdin", "--client", "web", "--port", "8787", "--preset", "narrow"], { stdin: `${CLIENT_ID}\n${CLIENT_SECRET}\n` });
    expect(r.code).toBe(0);
    expect(r.out).toContain("http://localhost:8787/google/callback is an Authorized redirect URI");
    expect(JSON.parse(fs.readFileSync(path.join(dir, SETTINGS_FILE), "utf8"))).toMatchObject({ clientType: "web", port: 8787, upstream: "google" });
  });

  it("asks for the client without echoing it on a terminal", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (c: Buffer) => {
      out += c.toString();
      if (out.endsWith("Client ID: ")) stdin.write(`${CLIENT_ID}\r`);
      if (out.endsWith("Client secret: ")) stdin.write(`${CLIENT_SECRET}\r`);
    });
    const code = await runCli({
      argv: ["setup", "--client", "desktop", "--preset", "narrow"],
      env: { GWS_MCP_CONFIG_DIR: dir },
      stdin,
      stdout,
      stderr: new PassThrough(),
      self: SELF,
      keyring: async () => ({ keyring }),
    });
    expect(code).toBe(0);
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(out).not.toContain(CLIENT_SECRET);
    expect(out).not.toContain(CLIENT_ID);
    expect(entry("GOOGLE_CLIENT_SECRET")).toBe(CLIENT_SECRET);
  });
});

describe("gws-mcp accounts", () => {
  it("adds accounts through the browser, adds services incrementally, and manages alias, default and disconnect", async () => {
    await seed("a@fake.test", "b@fake.test");
    expect((await setupFake()).code).toBe(0);
    expect((await cli(["accounts", "list"])).out).toContain("No Google account is connected yet");

    const opened: string[] = [];
    const addA = await cli(["accounts", "add", "--services", "gmail,drive", "--yes"], { open: browserAs("a@fake.test", opened) });
    expect(addA.code).toBe(0);
    expect(addA.out).toContain('Connected "a@fake.test". Services: gmail, drive.');
    expect(addA.out).toContain("It is your default account.");
    // The opener got the one-shot start link only; nothing about the sign-in was printed.
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/start\?t=[A-Za-z0-9_-]{43}$/);
    expect(addA.out).not.toContain(opened[0]);
    expect(addA.out).not.toMatch(/state=|code_challenge/);
    expect(addA.out + addA.err).not.toMatch(/1\/\/fake-|ya29\./);

    const more = await cli(["accounts", "add", "--services", "sheets", "--account", "a@fake.test"], { open: browserAs("a@fake.test") });
    expect(more.out).toContain('Updated "a@fake.test". Services: gmail, drive, sheets.');

    expect((await cli(["accounts", "add", "--services", "drive", "--yes"], { open: browserAs("b@fake.test") })).code).toBe(0);
    const list = await cli(["accounts", "list"]);
    expect(list.out).toMatch(/\* a@fake\.test {2}connected {2}services: gmail, drive, sheets/);
    expect(list.out).toMatch(/ {2}b@fake\.test {2}connected {2}services: drive/);

    expect((await cli(["accounts", "alias", "b@fake.test", "work"])).out).toContain('"b@fake.test" is now also called "work".');
    expect((await cli(["accounts", "default", "work"])).out).toContain('"b@fake.test" is now your default account.');
    expect((await cli(["accounts", "list"])).out).toMatch(/\* b@fake\.test \(alias work\)/);

    const unconfirmed = await cli(["accounts", "disconnect", "work"]);
    expect(unconfirmed.code).toBe(2);
    expect((await cli(["accounts", "list"])).out).toMatch(/b@fake\.test \(alias work\) {2}connected/);
    const before = fake.seen.length;
    const gone = await cli(["accounts", "disconnect", "work", "--yes"]);
    expect(gone).toMatchObject({ code: 0, out: expect.stringContaining('Disconnected "b@fake.test"') });
    expect(fake.seen.slice(before)).toContain("POST /oauth2.googleapis.com/revoke");
    expect((await cli(["accounts", "list"])).out).toMatch(/b@fake\.test \(alias work\) {2}disconnected/);
    expect((await cli(["accounts", "alias", "nobody@fake.test", "x"])).code).toBe(2);
  });

  it("connects an account it does not know only when confirmed, and revokes the grant otherwise", async () => {
    await seed("new@fake.test");
    expect((await setupFake()).code).toBe(0);
    const before = fake.seen.length;
    const r = await cli(["accounts", "add", "--services", "gmail"], { open: browserAs("new@fake.test") });
    expect(r.code).toBe(2);
    expect(r.err).toContain('Connect "new@fake.test" to gws-mcp? It is not connected yet. Re-run with --yes to confirm.');
    expect(fake.seen.slice(before)).toContain("POST /oauth2.googleapis.com/revoke");
    expect((await cli(["accounts", "list"])).out).toContain("No Google account is connected yet");
  });

  it("refuses an account other than the one --account names, and revokes that grant", async () => {
    await seed("a@fake.test", "intruder@fake.test");
    expect((await setupFake()).code).toBe(0);
    expect((await cli(["accounts", "add", "--services", "gmail", "--yes"], { open: browserAs("a@fake.test") })).code).toBe(0);
    const before = fake.seen.length;
    const r = await cli(["accounts", "add", "--services", "drive", "--account", "a@fake.test", "--yes"], { open: browserAs("intruder@fake.test") });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Google signed in "intruder@fake.test", not "a@fake.test"; nothing was connected');
    expect(fake.seen.slice(before)).toContain("POST /oauth2.googleapis.com/revoke");
    const list = await cli(["accounts", "list"]);
    expect(list.out).not.toContain("intruder");
    expect(list.out).toMatch(/a@fake\.test {2}connected {2}services: gmail$/m);
    // The refused grant is gone at Google, the kept one is not.
    const stateOf = async (email: string) =>
      (await (await fake.handler(new Request(`http://fake-google/__fake/state?email=${encodeURIComponent(email)}`))).json()) as { grants: Record<string, unknown> };
    expect(Object.keys((await stateOf("intruder@fake.test")).grants)).toEqual([]);
    expect(Object.keys((await stateOf("a@fake.test")).grants)).toHaveLength(1);
  });

  it("does not revoke when the other account is one already connected (the grant is its own)", async () => {
    await seed("a@fake.test", "b@fake.test");
    expect((await setupFake()).code).toBe(0);
    expect((await cli(["accounts", "add", "--services", "gmail", "--yes"], { open: browserAs("a@fake.test") })).code).toBe(0);
    expect((await cli(["accounts", "add", "--services", "gmail", "--yes"], { open: browserAs("b@fake.test") })).code).toBe(0);
    const before = fake.seen.length;
    const r = await cli(["accounts", "add", "--services", "gmail", "--account", "a@fake.test"], { open: browserAs("b@fake.test") });
    expect(r.code).toBe(1);
    expect(fake.seen.slice(before)).not.toContain("POST /oauth2.googleapis.com/revoke");
    expect((await cli(["doctor"])).out).toContain("ok    b@fake.test: token refresh works");
  });

  it("prints the one-time start link only when the browser cannot be opened", async () => {
    await seed("a@fake.test");
    expect((await setupFake()).code).toBe(0);
    let printed = "";
    const r = await cli(["accounts", "add", "--services", "gmail", "--yes"], {
      open: async () => {
        throw new Error("no opener");
      },
    }).catch((e: unknown) => ({ code: -1, out: String(e), err: "" }));
    printed = r.out;
    expect(printed).toMatch(/Open this one-time link in a browser on this computer:\n {2}http:\/\/127\.0\.0\.1:\d+\/start\?t=[A-Za-z0-9_-]{43}\n/);
    expect(r.code).toBe(1);
  }, 15_000);
});

describe("gws-mcp doctor", () => {
  it("reports a missing setup without touching the keychain", async () => {
    const r = await cli(["doctor"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^ok {4}Node\.js \d+\.\d+\.\d+$/m);
    expect(r.out).toContain(`is not set up yet. Run: ${SELF} setup`);
    expect(probes).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("checks the folder, the key storage, the client and one token refresh per account", async () => {
    await seed("a@fake.test");
    expect((await setupFake()).code).toBe(0);
    expect((await cli(["accounts", "add", "--yes"], { open: browserAs("a@fake.test") })).code).toBe(0);
    const before = fake.seen.length;
    const r = await cli(["doctor"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/ok {4}directory .* mode 0700, ok/);
    expect(r.out).toMatch(/ok {4}file .*gws-mcp\.db: mode 0600, ok/);
    expect(r.out).toMatch(/warn {2}secrets: in the key file/);
    expect(r.out).toContain("ok    a@fake.test: token refresh works");
    expect(fake.seen.slice(before)).toEqual(["POST /oauth2.googleapis.com/token"]);
  });

  it("reports the OS keychain for a keychain setup", async () => {
    expect((await setupGoogle()).code).toBe(0);
    const r = await cli(["doctor"]);
    expect(r.out).toContain("ok    secrets: in the OS keychain");
    expect(r.code).toBe(0);
  });

  it("fails on a settings file others can read, without repairing it", async () => {
    expect((await setupFake()).code).toBe(0);
    const file = path.join(dir, SETTINGS_FILE);
    fs.chmodSync(file, 0o644);
    const r = await cli(["doctor"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL {2}refusing to use .*config\.json: it has mode 0644, not 0600/);
    expect(mode(file)).toBe(0o644);
  });
});

describe("gws-mcp serve", () => {
  it("serves the two tools over stdio and exits when stdin closes", async () => {
    expect((await setupFake()).code).toBe(0);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    let err = "";
    stdout.on("data", (c: Buffer) => (out += c.toString()));
    stderr.on("data", (c: Buffer) => (err += c.toString()));
    const running = runCli({ argv: ["serve"], env: { GWS_MCP_CONFIG_DIR: dir }, stdin, stdout, stderr, self: SELF, keyring: async () => ({ keyring }) });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    await vi.waitFor(() => expect(out).toContain('"id":2'));
    stdin.end();
    expect(await running).toBe(0);
    const lines = out.trim().split("\n").map((l) => JSON.parse(l) as { id?: number; result?: { tools?: Array<{ name: string }> } });
    expect(lines.find((l) => l.id === 2)?.result?.tools?.map((t) => t.name).sort()).toEqual(["execute", "search"]);
    expect(err).toContain("serving search and execute over stdio (0 accounts connected)");
  });
});

describe("the gws-mcp entry", () => {
  const CLI = path.resolve(import.meta.dirname, "..", "..", "src", "local", "cli.ts");
  const script = `import { hideSqliteNotice } from ${JSON.stringify(CLI)};
hideSqliteNotice();
process.emitWarning("SQLite is an experimental feature", "ExperimentalWarning");
process.emitWarning("another-warning-text", "DeprecationWarning");
setTimeout(() => {}, 50);`;
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [...args, "--input-type=module", "-e", script], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });

  it("hides only the SQLite notice and keeps Node's own printing of every other warning", () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("SQLite is an experimental feature");
    expect(r.stderr).toMatch(/DeprecationWarning: another-warning-text/);
  });

  it("prints nothing under --no-warnings or NODE_NO_WARNINGS=1", () => {
    expect(run(["--no-warnings"]).stderr).toBe("");
    expect(run([], { NODE_NO_WARNINGS: "1" }).stderr).not.toContain("another-warning-text");
  });
});
