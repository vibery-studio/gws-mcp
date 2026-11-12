// End-to-end check of Done 1-10, 16, 21 and 22 against a running fake-mode gws-mcp and its fake Google, as a real MCP
// client and browser would use them. Usage (see scripts/e2e/README.md):
//   npx tsx scripts/e2e/run.ts --base http://localhost:8787 --fake http://localhost:8788 [--env-file <path>]... [--only 1,5]
//   npx tsx scripts/e2e/run.ts --base http://localhost:8787 --fake http://localhost:8788 --docker <gws-mcp-e2e-* container> --env-file <path>
//     (the Node host's image; scripts/e2e/docker.sh builds and runs it, see the README)
//   npx tsx scripts/e2e/run.ts --base <deployed E2E Worker> --fake <its deployed fake> --remote-d1   (both from wrangler.e2e.jsonc)
// Targets, D1 and env files: see target.ts. Secrets (FAKE_ADMIN_TOKEN, FAKE_LOGIN_SECRET, the target's token key)
// are read from dotenv files by path and never printed. Every evidence line goes through the server's own
// redaction patterns plus every secret the run holds before it is printed.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "../../src/core/redact";
import done01 from "./checks/done-01";
import done02 from "./checks/done-02";
import done03 from "./checks/done-03";
import done04 from "./checks/done-04";
import done05 from "./checks/done-05";
import done06 from "./checks/done-06";
import done07 from "./checks/done-07";
import done08 from "./checks/done-08";
import done09 from "./checks/done-09";
import done10 from "./checks/done-10";
import done16 from "./checks/done-16";
import done21 from "./checks/done-21";
import done22 from "./checks/done-22";
import done24 from "./checks/done-24";
import { d1Query, sqlLiteral, type D1Mode } from "./d1-scan";
import { McpSession } from "./mcp";
import { Browser, FakeGoogle, approveClient, connectFromAccounts, signIn } from "./oauth-driver";
import { loadRunSecrets, resolveTarget, targetOrigin, type RunSecrets, type RunTarget } from "./target";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_EVIDENCE_CHARS = 240;

export interface CheckResult {
  id: number;
  pass: boolean;
  evidence: string[];
}

/** Collects one check's evidence lines; any failed assertion fails the check. */
export class Recorder {
  readonly evidence: string[] = [];
  #failed = false;

  constructor(readonly id: number) {}

  note(line: string): void {
    this.evidence.push(line);
  }

  /** Records `line` as ok or FAIL. Returns the condition so a check can stop early. */
  check(condition: boolean, line: string): boolean {
    this.evidence.push(`${condition ? "ok" : "FAIL"} ${line}`);
    if (!condition) this.#failed = true;
    return condition;
  }

  fail(line: string): void {
    this.check(false, line);
  }

  done(): CheckResult {
    return { id: this.id, pass: !this.#failed && this.evidence.length > 0, evidence: this.evidence };
  }
}

export interface Client {
  clientId: string;
  session: McpSession;
}

/** State shared by the checks. Accounts are fresh per run: `e2e-<runId>-a|b|c@fake.test`. */
export interface E2eContext {
  base: string;
  fakeBase: string;
  runId: string;
  d1: D1Mode;
  fake: FakeGoogle;
  /** Signed in as the user whose primary account is A. */
  browser: Browser;
  emails: { a: string; b: string; c: string };
  userId: string;
  /** Approved for account A only. */
  main: Client;
  /** The target's base64 TOKEN_ENC_KEY when the env files hold it (the moved-row decryption test needs it). */
  tokenEncKey?: string;
  /** Body/content markers a check sent upstream; the D1 scan looks for them. */
  markers: Array<{ name: string; needle: string }>;
  /** Every secret value the run holds, for evidence redaction and output scans. */
  secrets: string[];
  /** Registers, consents for `emails` and opens an MCP session. */
  newClient(name: string, emails: readonly string[]): Promise<Client>;
  /** The user's account ids by email, from D1. */
  accountIds(): Promise<Record<string, string>>;
}

export type Check = (ctx: E2eContext, r: Recorder) => Promise<CheckResult>;

/** Run order: Done 8 exhausts the rate limit of the user's minute, so it runs last. */
const CHECKS: ReadonlyArray<[number, Check]> = [
  [1, done01],
  [2, done02],
  [3, done03],
  [4, done04],
  [5, done05],
  [6, done06],
  [7, done07],
  [9, done09],
  [10, done10],
  [16, done16],
  [21, done21],
  [22, done22],
  [24, done24],
  [8, done08],
];

interface Args {
  base: string;
  /** Resolved and pinned: `target.fake` is the only fake the run talks to. */
  target: RunTarget;
  only?: Set<number>;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const base = get("--base");
  const fake = get("--fake");
  if (!base || !fake) throw new Error("usage: run.ts --base <url> --fake <url> [--remote-d1 | --docker <container>] [--env-file <path>]... [--only 1,5]");
  const envFiles = argv.flatMap((a, i) => (a === "--env-file" && argv[i + 1] ? [argv[i + 1] as string] : []));
  const only = get("--only");
  const docker = get("--docker");
  const origin = targetOrigin("--base", base);
  return {
    base: origin,
    target: resolveTarget(origin, { fake: targetOrigin("--fake", fake), root: ROOT, remoteD1: argv.includes("--remote-d1"), envFiles, ...(docker ? { docker } : {}) }),
    ...(only ? { only: new Set(only.split(",").map(Number)) } : {}),
  };
}

function print(result: CheckResult, secrets: readonly string[]): void {
  console.log(`DONE-${result.id} ${result.pass ? "PASS" : "FAIL"}`);
  for (const line of result.evidence) {
    const safe = redact(line, secrets).replace(/\s+/g, " ");
    console.log(`  ${safe.length > MAX_EVIDENCE_CHARS ? `${safe.slice(0, MAX_EVIDENCE_CHARS - 1)}…` : safe}`);
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : "non-Error thrown";
}

async function setup(args: Args, secrets: RunSecrets, held: string[]): Promise<{ ctx: E2eContext; evidence: string[] }> {
  const evidence: string[] = [];
  const { adminToken, loginSecret } = secrets;
  if (!adminToken || !loginSecret) throw new Error("FAKE_ADMIN_TOKEN and FAKE_LOGIN_SECRET must be in the env files");
  const fake = new FakeGoogle(args.target.fake, { adminToken, loginSecret });
  const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const emails = { a: `e2e-${runId}-a@fake.test`, b: `e2e-${runId}-b@fake.test`, c: `e2e-${runId}-c@fake.test` };
  const sub = (n: number) => `9${Date.now()}${n}${Math.floor(Math.random() * 1e6)}`;
  const subA = sub(1);
  // Before any admin or login secret header leaves: the fake must refuse its control routes without them.
  evidence.push(`fake control route without admin header -> ${await fake.requireGuarded()} (required before any secret is sent)`);
  await fake.seed({
    accounts: [
      { email: emails.a, sub: subA, preset: "default" },
      { email: emails.b, sub: sub(2), preset: "default" },
      { email: emails.c, sub: sub(3), preset: "default" },
    ],
  });
  evidence.push(`seeded run ${runId}: accounts a, b, c (preset default)`);
  // The access list lives only in D1. The E2E Worker runs against the fake Google (the harness refuses any other
  // config), so its fake accounts' test-only domain is allowed there, as a regular user, before anyone signs in.
  await d1Query(
    args.target.d1,
    `INSERT OR IGNORE INTO access_rules (pattern, role, note, created_by, created_at) VALUES (${sqlLiteral("@fake.test")}, 'user', NULL, 'e2e-harness', ${Date.now()})`,
  );
  evidence.push("access list: @fake.test allowed as user on the E2E database");

  const browser = new Browser(args.base);
  const landed = await signIn(browser, fake, emails.a);
  evidence.push(`sign-in as a (first sign-in, then connect) -> ${new URL(landed, args.base).pathname}`);
  const connected = await connectFromAccounts(browser, fake, emails.b, ["gmail", "drive"]);
  evidence.push(`connect b from Google accounts -> ${new URL(connected, args.base).pathname}`);
  held.push(...browser.cookieValues());

  const d1: D1Mode = args.target.d1;
  const newClient = async (name: string, accountEmails: readonly string[]): Promise<Client> => {
    held.push(...browser.cookieValues());
    const approved = await approveClient(browser, name, accountEmails);
    held.push(approved.accessToken);
    return { clientId: approved.clientId, session: await McpSession.open(args.base, approved.accessToken) };
  };
  const main = await newClient(`E2E main client ${runId}`, [emails.a]);
  evidence.push("main client approved for account a only");

  const userId = `u_${subA}`;
  const ctx: E2eContext = {
    base: args.base,
    fakeBase: args.target.fake,
    runId,
    d1,
    fake,
    browser,
    emails,
    userId,
    main,
    ...(secrets.tokenEncKey ? { tokenEncKey: secrets.tokenEncKey } : {}),
    markers: [],
    secrets: held,
    newClient,
    accountIds: async () => {
      const rows = await d1Query<{ id: string; email: string }>(d1, `SELECT id, email FROM accounts WHERE user_id = ${sqlLiteral(userId)}`);
      return Object.fromEntries(rows.map((r) => [r.email, r.id]));
    },
  };
  return { ctx, evidence };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const { envFiles, d1, tokenKeyName } = args.target;
  const secrets = loadRunSecrets(args.target);
  const held = [...secrets.all];
  console.log(
    `E2E base=${args.base} fake=${args.target.fake} d1=${d1} token-key=${tokenKeyName} env-files=${envFiles.map((f) => path.relative(ROOT, f)).join(",")}`,
  );
  const planned = CHECKS.filter(([id]) => !args.only || args.only.has(id)).length;

  let ctx: E2eContext;
  try {
    const s = await setup(args, secrets, held);
    ctx = s.ctx;
    console.log("SETUP ok");
    for (const line of s.evidence) console.log(`  ${redact(line, held)}`);
  } catch (e) {
    console.log("SETUP FAIL");
    console.log(`  ${redact(errorText(e), held)}`);
    console.log(`SUMMARY 0/${planned} PASS`);
    return 1;
  }

  const results: CheckResult[] = [];
  for (const [id, check] of CHECKS) {
    if (args.only && !args.only.has(id)) continue;
    const r = new Recorder(id);
    let result: CheckResult;
    try {
      result = await check(ctx, r);
    } catch (e) {
      r.fail(`error: ${errorText(e)}`);
      result = r.done();
    }
    print(result, ctx.secrets);
    results.push(result);
  }
  await Promise.allSettled([ctx.main.session.close()]);
  const passed = results.filter((r) => r.pass).length;
  console.log(`SUMMARY ${passed}/${results.length} PASS`);
  return passed === results.length && results.length > 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.log(`E2E harness error: ${e instanceof Error ? e.message : "error"}`);
      process.exitCode = 2;
    },
  );
}
