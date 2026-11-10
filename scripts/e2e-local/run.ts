// Local-mode E2E: the bundled `gws-mcp` command against a fake Google running in this process, end to end.
//   npm run build:local && npm run e2e:local
// Each run uses fresh config folders under the OS temp dir (removed afterwards), the key file (GWS_MCP_NO_KEYCHAIN=1:
// the OS keychain is never touched) and no browser (GWS_MCP_NO_BROWSER=1: the harness plays the browser). Output:
// `SETUP ok|FAIL`, then `<CHECK> PASS|FAIL` with evidence lines, the skipped items, and `SUMMARY <k>/<n> PASS`.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { FAKE_CLIENT_SECRET } from "../../src/config";
import { redact } from "../../src/core/redact";
import { done03, done04, done05, done07, done08, done09, done10, execute, tools } from "./checks";
import { addAccount, openServe, requireBundle, runCommand, type AddOutcome } from "./cli";
import { FakeControl, startFakeServer, type FakeServer } from "./fake-server";

const MAX_EVIDENCE_CHARS = 240;
/** Limits this run sets in the settings file: a short host deadline, and a call input cap the bridge must apply. */
const EXECUTE_TIMEOUT_MS = 10_000;
const CALL_INPUT_MAX_BYTES = 2_000_000;
/** Read from stdin by `setup`; the fake upstream never receives them (it has its own client). */
const CLIENT_ID = "e2e-local-client.apps.googleusercontent.com";
const CLIENT_SECRET = `e2e-local-secret-${crypto.randomUUID()}`;

export class Recorder {
  readonly evidence: string[] = [];
  failed = false;

  note(line: string): void {
    this.evidence.push(line);
  }

  check(condition: boolean, line: string): boolean {
    this.evidence.push(`${condition ? "ok" : "FAIL"} ${line}`);
    if (!condition) this.failed = true;
    return condition;
  }

  fail(line: string): void {
    this.check(false, line);
  }
}

export interface Ctx {
  runId: string;
  fake: FakeControl;
  /** The main config folder (Desktop client): accounts a (default) and b (alias "work"). */
  configDir: string;
  emails: { a: string; b: string; c: string };
  /** `serve` of the main folder. */
  main: Client;
  /** `serve` of the Web-client folder, whose database counts only the rate check's calls. */
  rate: Client;
  /** Every secret the run holds, for redaction and output scans. */
  secrets: string[];
  executeTimeoutMs: number;
  callInputMaxBytes: number;
  /** Slows the fake's API answers (0 to stop). */
  setApiDelay(ms: number): void;
}

type Check = [label: string, run: (ctx: Ctx, r: Recorder) => Promise<void>];

function print(label: string, r: Recorder, secrets: readonly string[]): void {
  console.log(`${label} ${r.failed || r.evidence.length === 0 ? "FAIL" : "PASS"}`);
  for (const line of r.evidence) {
    const safe = redact(line, secrets).replace(/\s+/g, " ");
    console.log(`  ${safe.length > MAX_EVIDENCE_CHARS ? `${safe.slice(0, MAX_EVIDENCE_CHARS - 1)}…` : safe}`);
  }
}

/** Adds the run's limits to a settings file (as a user may), keeping its mode. */
function setLimits(configDir: string): void {
  const file = path.join(configDir, "config.json");
  const settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  settings.limits = { EXECUTE_TIMEOUT_MS, CALL_INPUT_MAX_BYTES };
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  chmodSync(file, 0o600);
}

/** The local items of Done 18: setup through stdin, the accounts lifecycle, the loopback OAuth checks. */
async function setupAndAccounts(state: {
  fake: FakeControl;
  fakeOrigin: string;
  mainDir: string;
  webDir: string;
  emails: Ctx["emails"];
  r: Recorder;
}): Promise<void> {
  const { fake, fakeOrigin, mainDir, webDir, emails, r } = state;
  const stdin = `${CLIENT_ID}\n${CLIENT_SECRET}\n`;
  const base = ["setup", "--stdin", "--key-file", "--upstream", "fake", "--fake-url", fakeOrigin, "--preset", "narrow"];
  const setup = await runCommand(mainDir, [...base, "--client", "desktop"], stdin);
  r.check(setup.code === 0 && setup.out.includes("gws-mcp is set up"), `setup (Desktop client, key file) -> exit ${setup.code}`);
  r.check(!setup.argv.some((a) => a.includes(CLIENT_SECRET)) && !(setup.out + setup.err).includes(CLIENT_SECRET), "the client secret came through stdin: not in argv, not in any output");
  const settingsText = readFileSync(path.join(mainDir, "config.json"), "utf8");
  r.check(!settingsText.includes(CLIENT_SECRET) && !settingsText.includes(CLIENT_ID), "the settings file holds choices only, no client ID or secret");
  r.check(/WEAKER than the OS keychain/.test(setup.out), "setup flags the key file as weaker than the keychain");
  const snippet = /claude mcp add gws -- (.+) serve/.exec(setup.out)?.[1] ?? "";
  r.check(!/npx/.test(setup.out) && snippet.startsWith("node ") && /cli\.js'?$/.test(snippet), `setup prints its own invocation for Claude Code, never npx: ${snippet}`);
  const again = await runCommand(mainDir, [...base, "--client", "desktop"], stdin);
  r.check(again.code === 0 && again.out.includes("nothing changed"), "setup again with the same choices -> nothing changed");
  setLimits(mainDir);

  const describe = (o: AddOutcome) =>
    `start link ${new URL(o.startUrl).origin}/start, again -> ${o.startAgainStatus}; redirect ${o.redirect.origin}${o.redirect.pathname}, ` +
    `no cookie -> ${o.noCookieStatus}, forged state -> ${o.forgedStatus}, real callback -> ${o.callbackStatus}, ` +
    `LAN address reaches the listener: ${o.reachableFromLan ?? "no LAN address"}, open after: ${o.openAfter}, exit ${o.code}`;
  const bound = (o: AddOutcome) =>
    o.startAgainStatus === 410 && o.noCookieStatus === 400 && o.forgedStatus === 400 && o.callbackStatus === 200 && o.reachableFromLan !== true && !o.openAfter;
  const unconfirmed = await addAccount(mainDir, fake, emails.a, ["--services", "gmail"]);
  r.check(unconfirmed.code === 2 && unconfirmed.err.includes(`Connect "${emails.a}" to gws-mcp?`), `a new account without --yes (no terminal) -> exit ${unconfirmed.code}, not connected`);
  const addA = await addAccount(mainDir, fake, emails.a, ["--services", "gmail,drive,calendar,sheets,docs,forms,tasks,slides", "--yes"]);
  const challenge = new URL(addA.authUrl).searchParams;
  r.check(addA.code === 0 && addA.redirect.hostname === "127.0.0.1" && Number(addA.redirect.port) > 0, `accounts add a (Desktop): ${describe(addA)}`);
  r.check(challenge.get("code_challenge_method") === "S256" && /^[A-Za-z0-9_-]{43}$/.test(challenge.get("state") ?? ""), "Google's URL (behind the start link) carries PKCE S256 and a 43-character state");
  r.check(!/state=|code_challenge/.test(addA.out), "the command printed only the one-time start link, never the state or challenge");
  r.check(bound(addA), "loopback: start link single-use, callback needs the browser cookie and the state, 127.0.0.1 only, closed after one sign-in");
  const addB = await addAccount(mainDir, fake, emails.b, ["--services", "gmail,drive", "--yes"]);
  r.check(addB.code === 0 && addB.out.includes(`Connected "${emails.b}". Services: gmail, drive.`), `accounts add b -> ${addB.out.trim().split("\n").at(-1) ?? ""}`);
  const wrong = await addAccount(mainDir, fake, emails.c, ["--services", "gmail", "--account", emails.a, "--yes"]);
  r.check(wrong.code === 1 && wrong.err.includes(`Google signed in "${emails.c}", not "${emails.a}"`), `--account a but c signed in -> exit ${wrong.code}, refused`);
  r.check(Object.keys((await fake.state(emails.c)).grants).length === 0, "the refused account's new grant was revoked at Google");
  const alias = await runCommand(mainDir, ["accounts", "alias", emails.b, "work"]);
  r.check(alias.code === 0, `accounts alias b work -> ${alias.out.trim()}`);
  const dflt = await runCommand(mainDir, ["accounts", "default", emails.a]);
  r.check(dflt.code === 0, `accounts default a -> ${dflt.out.trim()}`);
  const list = await runCommand(mainDir, ["accounts", "list"]);
  r.check(list.out.includes(`* ${emails.a}  connected`) && list.out.includes(`${emails.b} (alias work)  connected  services: gmail, drive`), `accounts list -> ${list.out.trim().replace(/\n/g, " | ")}`);

  // The Web-client path the operator dogfoods: a fixed port, redirect http://localhost:<port>/google/callback.
  const port = 20000 + Math.floor(Math.random() * 20000);
  const web = await runCommand(webDir, ["setup", "--stdin", "--key-file", "--upstream", "fake", "--fake-url", fakeOrigin, "--preset", "narrow", "--client", "web", "--port", String(port)], stdin);
  r.check(web.code === 0 && web.out.includes(`http://localhost:${port}/google/callback`), `setup (Web client, port ${port}) -> exit ${web.code}`);
  const addC = await addAccount(webDir, fake, emails.c, ["--services", "gmail", "--yes"]);
  r.check(addC.code === 0 && addC.redirect.host === `localhost:${port}` && new URL(addC.startUrl).host === `localhost:${port}` && bound(addC), `accounts add c (Web): ${describe(addC)}`);
}

/** Disconnect revokes at Google; the account's next call asks for a reconnect. */
async function disconnect(ctx: Ctx, r: Recorder): Promise<void> {
  const before = await ctx.fake.state(ctx.emails.b);
  const unconfirmed = await runCommand(ctx.configDir, ["accounts", "disconnect", "work"]);
  r.check(unconfirmed.code === 2 && unconfirmed.err.includes("--yes"), "disconnect without --yes (no terminal) -> refused, asks for --yes");
  const out = await runCommand(ctx.configDir, ["accounts", "disconnect", "work", "--yes"]);
  const after = await ctx.fake.state(ctx.emails.b);
  r.check(out.code === 0 && Object.keys(before.grants).length > 0 && Object.keys(after.grants).length === 0, `disconnect work --yes -> exit ${out.code}; grants at the fake ${Object.keys(before.grants).length} -> ${Object.keys(after.grants).length}`);
  const next = await execute(ctx.main, `async () => sdk.gmail.users.labels.list({ userId: "me", account: "work" })`);
  r.check(next.out.error?.code === "GWS_RECONNECT_REQUIRED", `next call on the disconnected account -> ${next.out.error?.code ?? "none"}`);
  const list = await runCommand(ctx.configDir, ["accounts", "list"]);
  r.check(list.out.includes(`${ctx.emails.b} (alias work)  disconnected`), "accounts list shows it disconnected");
}

const CHECKS: readonly Check[] = [
  ["TOOLS (Done 1 local: tools/list over stdio)", tools],
  ["DONE-3", done03],
  ["DONE-4", done04],
  ["DONE-5", done05],
  ["DONE-7", done07],
  ["DONE-9", done09],
  ["DONE-10", done10],
  ["DONE-8", done08],
  ["DONE-18 (disconnect revokes at Google)", disconnect],
];

const SKIPPED = [
  "Done 1 (401 without a token): stdio has no HTTP or bearer token; the stdio process is the user's own",
  "Done 2 (client consent page, revocation): local mode has no MCP client approval layer",
  "Done 6 (per-client account allowlists): one local user, every connected account is available",
  "Done 9 (moved row no longer decrypts): one local user; the AAD binding is unchanged shared code",
  "Done 18 keychain: this run uses the key file so the OS keychain is never touched; the keychain path is covered by test/local with a fake keyring and the opt-in real-keychain test",
];

async function main(): Promise<number> {
  requireBundle();
  const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const base = mkdtempSync(path.join(os.tmpdir(), "gws-mcp-e2e-local-"));
  const mainDir = path.join(base, "main");
  const webDir = path.join(base, "web");
  const emails = { a: `l-${runId}-a@fake.test`, b: `l-${runId}-b@fake.test`, c: `l-${runId}-c@fake.test` };
  const secrets = [CLIENT_SECRET, FAKE_CLIENT_SECRET];
  let server: FakeServer | undefined;
  const clients: Array<{ close: () => Promise<void> }> = [];
  const results: boolean[] = [];
  try {
    console.log(`E2E-LOCAL run=${runId} node=${process.versions.node}`);
    const r = new Recorder();
    let ctx: Ctx | undefined;
    try {
      server = await startFakeServer();
      const fake = new FakeControl(server.origin);
      r.note(`fake Google on ${server.origin} (loopback, this run only)`);
      await fake.seed(Object.values(emails).map((email, i) => ({ email, sub: `9${Date.now()}${i}`, preset: "default" })));
      await setupAndAccounts({ fake, fakeOrigin: server.origin, mainDir, webDir, emails, r });
      const main = await openServe(mainDir);
      clients.push(main);
      const rate = await openServe(webDir);
      clients.push(rate);
      r.check(/serving search and execute over stdio \(2 accounts connected\)/.test(main.stderr()), `serve started: ${main.stderr().trim()}`);
      const fakeServer = server;
      ctx = {
        runId,
        fake,
        configDir: mainDir,
        emails,
        main: main.client,
        rate: rate.client,
        secrets,
        executeTimeoutMs: EXECUTE_TIMEOUT_MS,
        callInputMaxBytes: CALL_INPUT_MAX_BYTES,
        setApiDelay: (ms) => {
          fakeServer.apiDelayMs = ms;
        },
      };
    } catch (e) {
      r.fail(`setup error: ${e instanceof Error ? e.message : "error"}`);
    }
    print(`SETUP (Done 18: setup, accounts add|list|alias|default, loopback OAuth)`, r, secrets);
    results.push(!r.failed);
    if (ctx === undefined) {
      console.log(`SUMMARY 0/${CHECKS.length + 1} PASS`);
      return 1;
    }
    for (const [label, check] of CHECKS) {
      const rc = new Recorder();
      try {
        await check(ctx, rc);
      } catch (e) {
        rc.fail(`error: ${e instanceof Error ? e.message : "error"}`);
      }
      print(label, rc, secrets);
      results.push(!rc.failed && rc.evidence.length > 0);
    }
    console.log("SKIPPED (not applicable to local mode)");
    for (const s of SKIPPED) console.log(`  ${s}`);
    const passed = results.filter(Boolean).length;
    console.log(`SUMMARY ${passed}/${results.length} PASS`);
    return passed === results.length ? 0 : 1;
  } finally {
    for (const c of clients) await c.close().catch(() => undefined);
    await server?.close();
    rmSync(base, { recursive: true, force: true });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.log(`E2E-LOCAL harness error: ${e instanceof Error ? e.message : "error"}`);
    process.exitCode = 2;
  },
);
