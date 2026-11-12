// Restart check for the Docker target (scripts/e2e/docker.sh): data on the volume survives a container restart.
// Signs in, connects an account, approves an AI app and runs one read; restarts the container; then the same browser
// session, the same access token and the stored Google refresh token (read with the key from the secrets file) must
// all still work. Usage:
//   npx tsx scripts/e2e/docker-restart.ts --base http://localhost:8787 --fake http://localhost:8788 --container gws-mcp-e2e-app --env-file <path>
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { redact } from "../../src/core/redact";
import { dockerContainer } from "./d1-scan";
import { McpSession, rawToolsList } from "./mcp";
import { Browser, FakeGoogle, accountsPage, approveClient, signIn } from "./oauth-driver";
import { isLoopback, readSecrets, targetOrigin } from "./target";

const run = promisify(execFile);
/** Readiness after a restart: the container answers /healthz. Bounded by the host's own boot, not tuned per run. */
const READY_DEADLINE_MS = 60_000;
const READY_POLL_MS = 500;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function waitHealthy(base: string): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < READY_DEADLINE_MS) {
    const res = await fetch(new URL("/healthz", base)).catch(() => undefined);
    if (res?.status === 200) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error(`/healthz not 200 within ${READY_DEADLINE_MS} ms after the restart`);
}

async function main(): Promise<number> {
  const baseArg = arg("--base");
  const fakeArg = arg("--fake");
  const container = arg("--container");
  const envFiles = process.argv.flatMap((a, i) => (a === "--env-file" && process.argv[i + 1] ? [path.resolve(process.argv[i + 1] as string)] : []));
  if (!baseArg || !fakeArg || !container || envFiles.length === 0) throw new Error("usage: docker-restart.ts --base <url> --fake <url> --container <name> --env-file <path>");
  dockerContainer(`docker:${container}`);
  const base = targetOrigin("--base", baseArg);
  const fakeBase = targetOrigin("--fake", fakeArg);
  if (!isLoopback(base) || !isLoopback(fakeBase)) throw new Error("--base and --fake must be loopback; nothing was sent");
  const secrets = readSecrets(envFiles, ["FAKE_ADMIN_TOKEN", "FAKE_LOGIN_SECRET"]);
  if (!secrets.FAKE_ADMIN_TOKEN || !secrets.FAKE_LOGIN_SECRET) throw new Error("FAKE_ADMIN_TOKEN and FAKE_LOGIN_SECRET must be in the env files");
  const held = Object.values(secrets);

  let failed = false;
  const check = (ok: boolean, line: string) => {
    if (!ok) failed = true;
    console.log(`  ${ok ? "ok" : "FAIL"} ${redact(line, held)}`);
  };

  const fake = new FakeGoogle(fakeBase, { adminToken: secrets.FAKE_ADMIN_TOKEN, loginSecret: secrets.FAKE_LOGIN_SECRET });
  const email = `e2e-restart-${Date.now().toString(36)}@fake.test`;
  await fake.seed({ accounts: [{ email, sub: `9${Date.now()}${Math.floor(Math.random() * 1e6)}`, preset: "default" }] });
  const browser = new Browser(base);
  await signIn(browser, fake, email);
  const client = await approveClient(browser, "E2E restart client", [email]);
  held.push(client.accessToken, ...browser.cookieValues());
  const labels = `async () => (await sdk.gmail.users.labels.list({ userId: "me" })).labels.length`;

  console.log("RESTART before");
  const before = await McpSession.open(base, client.accessToken);
  const first = await before.execute(labels);
  await before.close();
  check(first.out.ok === true && typeof first.out.result === "number", `labels.list before the restart -> ok=${first.out.ok} labels=${String(first.out.result)}`);

  const started = Date.now();
  await run("docker", ["restart", "--time", "30", container]);
  const ready = await waitHealthy(base);
  console.log("RESTART after");
  check(true, `docker restart + /healthz 200 in ${Date.now() - started} ms (ready ${ready} ms after the restart returned)`);

  const page = await accountsPage(browser).then(
    (p) => ({ ok: p.html.includes(email), csrf: p.csrf }),
    () => ({ ok: false, csrf: "" }),
  );
  check(page.ok, "the signed-in session cookie still opens /accounts and lists the account");
  const raw = await rawToolsList(base, client.accessToken);
  check(raw.status === 200, `the approved app's access token still works: tools/list -> ${raw.status}`);
  const after = await McpSession.open(base, client.accessToken);
  const second = await after.execute(labels);
  await after.close();
  check(second.out.ok === true && second.out.result === first.out.result, `the stored refresh token still decrypts: labels.list -> ok=${second.out.ok} labels=${String(second.out.result)}`);

  console.log(`RESTART ${failed ? "FAIL" : "PASS"}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.log(`RESTART harness error: ${e instanceof Error ? e.message : "error"}`);
      process.exitCode = 2;
    },
  );
}
