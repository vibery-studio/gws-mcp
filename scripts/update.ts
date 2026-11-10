// Updates a deployed gws-mcp from this checkout. It never pulls: bring the checkout to the version you want first.
//
//  0. Refuses (exit 2, nothing run) without the local wrangler.jsonc, or when it is not a real-Google config (the same
//     check as setup: GOOGLE_UPSTREAM "google", nothing bound to FAKE_GOOGLE).
//  1. Build: typecheck (`tsc --noEmit`), `gen:check` (the generated SDK matches its sources; its hash is the one the
//     deployed /version must report), then a dry-run bundle of the top level. Nothing remote changes on a broken tree.
//  2. Migrate: apply pending D1 migrations to the remote database (binding DB).
//  3. Deploy: the top level only (`--env=""`); never the E2E Worker or the fake Google, which have their own configs.
//     When wrangler prints the new version id, `wrangler deployments status` must show that version at 100%.
//  4. Smoke check: GET <origin>/version must answer 200 with name "gws-mcp", upstream "google" and this checkout's
//     SDK hash (the package version alone cannot tell old code from new).
//
// The origin is --url when given, else PUBLIC_BASE_URL from wrangler.jsonc, else the workers.dev URL wrangler reports.
//
// Usage: npm run update [-- --url https://<host>]
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deployedOrigin, upstreamRefusal, type WranglerResult } from "./setup";
import { CONFIGS, ROOT, configVar, pickConfig, readWranglerConfig } from "./wrangler";

const SMOKE_ATTEMPTS = 3;
const SMOKE_DELAY_MS = 3000;
const SMOKE_TIMEOUT_MS = 10_000;
const OUTPUT_TAIL_LINES = 20;
/** `npm run gen:check`'s success line names the SDK hash that /version reports as `sdkHash`. */
const GEN_CHECK_HASH = /\bbyte-identical (sha256:[0-9a-f]{64})\b/;
const VERSION_ID = /Current Version ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

export interface UpdateDeps {
  root: string;
  /** Runs `npx <args>` in the root. */
  npx: (args: readonly string[]) => Promise<WranglerResult>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** `--url`: the deployed origin to smoke-check. */
  url?: string;
}

/** An https origin (plain http only on loopback), or null. */
export function smokeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

/** True when `wrangler deployments status --json` shows `versionId` serving 100% of traffic. */
function servesFully(stdout: string, versionId: string): boolean {
  const start = stdout.indexOf("{");
  if (start < 0) return false;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as { versions?: unknown };
    return Array.isArray(parsed.versions) && parsed.versions.some((v: { version_id?: unknown; percentage?: unknown }) => v.version_id === versionId && v.percentage === 100);
  } catch {
    return false;
  }
}

/** Returns the process exit code: 0 ok, 1 a failed step or check, 2 a refused config, 64 a usage error. */
export async function update(deps: UpdateDeps): Promise<{ exitCode: number }> {
  const { log } = deps;
  const picked = pickConfig("main", deps.root);
  if (!picked.local) {
    log(`REFUSED: ${CONFIGS.main.local} is missing (${CONFIGS.main.example} has placeholder ids); run \`npm run setup\` first. Nothing was run.`);
    return { exitCode: 2 };
  }
  let config: Record<string, unknown>;
  try {
    config = readWranglerConfig(picked.path);
  } catch (e) {
    log(`FAILED: ${CONFIGS.main.local} is not valid JSONC (${e instanceof Error ? e.message : "unreadable"})`);
    return { exitCode: 1 };
  }
  const refusal = upstreamRefusal(config);
  if (refusal) {
    log(`REFUSED: ${refusal}; nothing was run`);
    return { exitCode: 2 };
  }
  const given = deps.url ?? configVar(config, "PUBLIC_BASE_URL");
  const givenOrigin = given === undefined ? undefined : smokeOrigin(given);
  if (given !== undefined && givenOrigin === null) {
    log(`usage: ${deps.url !== undefined ? "--url" : "PUBLIC_BASE_URL"} must be an https origin (plain http only on loopback)`);
    return { exitCode: 64 };
  }

  const step = async (label: string, args: readonly string[]): Promise<WranglerResult | null> => {
    const res = await deps.npx(args);
    if (res.code === 0) {
      log(`${label}: ok`);
      return res;
    }
    log(`${label}: FAILED (exit ${res.code})`);
    // tsc reports on stdout, wrangler on stderr: show the tail of both.
    for (const line of `${res.stdout}\n${res.stderr}`.trimEnd().split("\n").slice(-OUTPUT_TAIL_LINES)) if (line.trim() !== "") log(`  ${line}`);
    return null;
  };
  const wrangler = (args: readonly string[]) => ["wrangler", ...args, "--config", picked.path];

  if (!(await step("build: typecheck", ["tsc", "--noEmit"]))) return { exitCode: 1 };
  const gen = await step("build: gen:check", ["tsx", "scripts/gen-sdk.ts", "--check"]);
  if (!gen) return { exitCode: 1 };
  const sdkHash = GEN_CHECK_HASH.exec(gen.stdout)?.[1];
  if (sdkHash === undefined) {
    log("build: FAILED (gen:check printed no SDK hash)");
    return { exitCode: 1 };
  }
  if (!(await step("build: bundle (dry run)", wrangler(["deploy", "--env=", "--dry-run"])))) return { exitCode: 1 };
  if (!(await step("migrate: remote D1", wrangler(["d1", "migrations", "apply", "DB", "--remote"])))) return { exitCode: 1 };
  const deployed = await step("deploy: top level", wrangler(["deploy", "--env="]));
  if (!deployed) return { exitCode: 1 };

  const versionId = VERSION_ID.exec(deployed.stdout)?.[1];
  if (versionId === undefined) {
    log("deploy: wrangler printed no version id; deployment check skipped");
  } else {
    const status = await step("deploy: status", wrangler(["deployments", "status", "--json"]));
    if (!status) return { exitCode: 1 };
    if (!servesFully(status.stdout, versionId)) {
      log(`deploy: FAILED (version ${versionId} is not serving 100% of traffic)`);
      return { exitCode: 1 };
    }
    log(`deploy: version ${versionId} serves 100% of traffic`);
  }

  const origin = givenOrigin ?? deployedOrigin(deployed.stdout);
  if (origin === undefined) {
    log("smoke: FAILED (no origin: pass --url https://<host>, or set PUBLIC_BASE_URL)");
    return { exitCode: 1 };
  }
  const url = `${origin}/version`;
  let last = "";
  for (let attempt = 1; attempt <= SMOKE_ATTEMPTS; attempt++) {
    if (attempt > 1) await deps.sleep(SMOKE_DELAY_MS);
    try {
      const res = await deps.fetch(url, { redirect: "manual", signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS) });
      const body = res.status === 200 ? ((await res.json()) as { name?: unknown; sdkHash?: unknown; upstream?: unknown }) : undefined;
      if (body?.name === "gws-mcp" && body.sdkHash === sdkHash && body.upstream === "google") {
        log(`smoke: ${url} ok (sdk ${sdkHash}, upstream google)`);
        return { exitCode: 0 };
      }
      last =
        body === undefined
          ? `status ${res.status}`
          : `${body.name === "gws-mcp" ? "" : `name ${String(body.name)}, `}sdk ${String(body.sdkHash)}, upstream ${String(body.upstream)}; expected sdk ${sdkHash}, upstream google`;
    } catch (e) {
      last = e instanceof Error ? e.name : "error";
    }
  }
  log(`smoke: ${url} FAILED after ${SMOKE_ATTEMPTS} attempts (${last})`);
  return { exitCode: 1 };
}

function main(): Promise<{ exitCode: number }> | { exitCode: number } {
  const argv = process.argv.slice(2);
  let url: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1] !== undefined) url = argv[++i];
    else {
      console.error("usage: npm run update [-- --url https://<host>]");
      return { exitCode: 64 };
    }
  }
  return update({
    root: ROOT,
    npx: (args) =>
      new Promise((resolve) => {
        execFile("npx", [...args], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
    fetch: (u, init) => fetch(u, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
    ...(url !== undefined ? { url } : {}),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve(main())
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((e: unknown) => {
      console.error(`update: failed (${e instanceof Error ? e.name : "unknown error"})`);
      process.exitCode = 1;
    });
}
