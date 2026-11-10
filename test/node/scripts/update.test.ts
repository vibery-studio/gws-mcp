import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WranglerResult } from "../../../scripts/setup";
import { smokeOrigin, update, type UpdateDeps } from "../../../scripts/update";

const HASH = `sha256:${"ab".repeat(32)}`;
const OLD_HASH = `sha256:${"cd".repeat(32)}`;
const VERSION_ID = "0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
const DEPLOY_OUT = `Uploaded gws-mcp\nDeployed gws-mcp triggers\n  https://gws-mcp.example-sub.workers.dev\nCurrent Version ID: ${VERSION_ID}\n`;

let root: string;
let logs: string[];
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "gws-mcp-update-"));
  logs = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const configPath = () => path.join(root, "wrangler.jsonc");
const writeConfig = (extra: Record<string, unknown> = {}, vars: Record<string, string> = { GOOGLE_UPSTREAM: "google" }) =>
  writeFileSync(configPath(), `// local\n{ "name": "gws-mcp", "vars": ${JSON.stringify(vars)}, ${Object.entries(extra).map(([k, v]) => `"${k}": ${JSON.stringify(v)}, `).join("")}}\n`);

interface Served {
  sdkHash?: string;
  upstream?: string;
  name?: string;
  status?: number;
}

function deps(
  opts: {
    failOn?: string;
    served?: Served[];
    url?: string;
    deployOut?: string;
    status?: { readonly versions: ReadonlyArray<{ readonly version_id: string; readonly percentage: number }> } | "fail";
    genOut?: string;
  } = {},
) {
  const calls: string[][] = [];
  const fetched: string[] = [];
  const served = [...(opts.served ?? [{}])];
  const d: UpdateDeps = {
    root,
    npx: async (args): Promise<WranglerResult> => {
      calls.push([...args]);
      const joined = args.join(" ");
      if (opts.failOn && joined.startsWith(opts.failOn)) return { code: 1, stdout: "src/x.ts(1,1): error TS1\n", stderr: "step failed\n" };
      if (joined.startsWith("tsx scripts/gen-sdk.ts --check")) return { code: 0, stdout: opts.genOut ?? `sdk: byte-identical ${HASH} files=11 methods=216/230\n`, stderr: "" };
      if (joined.startsWith("wrangler deployments status")) {
        if (opts.status === "fail") return { code: 1, stdout: "", stderr: "status failed\n" };
        return { code: 0, stdout: JSON.stringify({ id: "d1", versions: [{ version_id: VERSION_ID, percentage: 100 }], ...(opts.status ?? {}) }), stderr: "" };
      }
      if (args[1] === "deploy" && !args.includes("--dry-run")) return { code: 0, stdout: opts.deployOut ?? DEPLOY_OUT, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetch: async (url) => {
      fetched.push(url);
      const s = (served.length > 1 ? served.shift() : served[0]) ?? {};
      if (s.status !== undefined) return new Response("nope", { status: s.status });
      return Response.json({ name: s.name ?? "gws-mcp", version: "0.1.0", sdkHash: s.sdkHash ?? HASH, upstream: s.upstream ?? "google" });
    },
    sleep: async () => {},
    log: (line) => logs.push(line),
    ...(opts.url !== undefined ? { url: opts.url } : {}),
  };
  return { d, calls, fetched };
}

const cfg = () => ["--config", configPath()];

describe("update", () => {
  it("builds, checks the SDK, migrates, deploys the top level only, confirms the new version is live, then smoke-checks /version", async () => {
    writeConfig();
    const { d, calls, fetched } = deps();
    expect(await update(d)).toEqual({ exitCode: 0 });
    expect(calls).toEqual([
      ["tsc", "--noEmit"],
      ["tsx", "scripts/gen-sdk.ts", "--check"],
      ["wrangler", "deploy", "--env=", "--dry-run", ...cfg()],
      ["wrangler", "d1", "migrations", "apply", "DB", "--remote", ...cfg()],
      ["wrangler", "deploy", "--env=", ...cfg()],
      ["wrangler", "deployments", "status", "--json", ...cfg()],
    ]);
    // Never the E2E Worker, the fake, or a pull.
    expect(calls.flat().filter((a) => a !== configPath()).join(" ")).not.toMatch(/e2e|fake|git|pull/);
    expect(fetched).toEqual(["https://gws-mcp.example-sub.workers.dev/version"]);
    expect(logs).toContain(`deploy: version ${VERSION_ID} serves 100% of traffic`);
    expect(logs.at(-1)).toBe(`smoke: https://gws-mcp.example-sub.workers.dev/version ok (sdk ${HASH}, upstream google)`);
  });

  it("refuses without the local wrangler.jsonc, running nothing (the example has placeholder ids)", async () => {
    writeFileSync(path.join(root, "wrangler.example.jsonc"), '{ "name": "gws-mcp" }');
    const { d, calls, fetched } = deps();
    expect(await update(d)).toEqual({ exitCode: 2 });
    expect(calls).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it("refuses a config that is not real-Google, as setup does, running nothing", async () => {
    for (const [extra, vars] of [
      [{}, { GOOGLE_UPSTREAM: "fake", FAKE_GOOGLE_PUBLIC_URL: "https://fake.example.invalid" }],
      [{ services: [{ binding: "FAKE_GOOGLE", service: "gws-mcp-fake-google" }] }, { GOOGLE_UPSTREAM: "google" }],
      [{}, {}],
    ] as const) {
      writeConfig(extra, vars);
      const { d, calls } = deps();
      expect(await update(d), JSON.stringify([extra, vars])).toEqual({ exitCode: 2 });
      expect(calls).toEqual([]);
      expect(logs.at(-1)).toMatch(/^REFUSED: wrangler\.jsonc is not a real-Google config/);
    }
  });

  it("stops at the first failing step, showing the step's output: nothing remote changes on a broken tree", async () => {
    for (const [failOn, ran] of [
      ["tsc", 1],
      ["tsx scripts/gen-sdk.ts", 2],
      ["wrangler deploy --env= --dry-run", 3],
      ["wrangler d1 migrations", 4],
    ] as const) {
      writeConfig();
      logs = [];
      const { d, calls, fetched } = deps({ failOn });
      expect(await update(d), failOn).toEqual({ exitCode: 1 });
      expect(calls, failOn).toHaveLength(ran);
      expect(calls.some((c) => c[1] === "deploy" && !c.includes("--dry-run")), failOn).toBe(false);
      expect(fetched).toEqual([]);
      expect(logs, failOn).toContain("  src/x.ts(1,1): error TS1");
    }
  });

  it("fails before deploying when gen:check prints no SDK hash", async () => {
    writeConfig();
    const { d, calls } = deps({ genOut: "something else\n" });
    expect(await update(d)).toEqual({ exitCode: 1 });
    expect(calls.some((c) => c[1] === "deploy")).toBe(false);
  });

  it("fails when the deployment does not serve the new version at 100%, or cannot be read", async () => {
    for (const status of [{ versions: [{ version_id: "11111111-2222-4333-8444-555555555555", percentage: 100 }] }, { versions: [{ version_id: VERSION_ID, percentage: 50 }] }, "fail"] as const) {
      writeConfig();
      const { d, fetched } = deps({ status });
      expect(await update(d), JSON.stringify(status)).toEqual({ exitCode: 1 });
      expect(fetched).toEqual([]);
    }
  });

  it("skips the deployment check, saying so, when the deploy output has no version id", async () => {
    writeConfig();
    const { d, calls } = deps({ deployOut: "Deployed gws-mcp triggers\n  https://gws-mcp.example-sub.workers.dev\n" });
    expect(await update(d)).toEqual({ exitCode: 0 });
    expect(calls.some((c) => c[1] === "deployments")).toBe(false);
    expect(logs).toContain("deploy: wrangler printed no version id; deployment check skipped");
  });

  it("smoke-checks the origin from --url, else PUBLIC_BASE_URL", async () => {
    writeConfig({}, { GOOGLE_UPSTREAM: "google", PUBLIC_BASE_URL: "https://gws.example.com/" });
    const fromConfig = deps();
    expect(await update(fromConfig.d)).toEqual({ exitCode: 0 });
    expect(fromConfig.fetched).toEqual(["https://gws.example.com/version"]);
    const fromFlag = deps({ url: "https://other.example.com" });
    expect(await update(fromFlag.d)).toEqual({ exitCode: 0 });
    expect(fromFlag.fetched).toEqual(["https://other.example.com/version"]);
  });

  it("refuses a non-https or non-origin smoke URL before running anything", async () => {
    writeConfig();
    for (const url of ["http://gws.example.com", "https://gws.example.com/path", "https://u:p@gws.example.com", "not a url"]) {
      const { d, calls } = deps({ url });
      expect(await update(d), url).toEqual({ exitCode: 64 });
      expect(calls).toEqual([]);
    }
  });

  it("fails when /version keeps serving another SDK, another upstream or an error, after a bounded number of attempts", async () => {
    writeConfig();
    const stale = deps({ served: [{ sdkHash: OLD_HASH }] });
    expect(await update(stale.d)).toEqual({ exitCode: 1 });
    expect(stale.fetched).toHaveLength(3);
    expect(logs.at(-1)).toMatch(new RegExp(`FAILED after 3 attempts \\(sdk ${OLD_HASH}, upstream google; expected sdk ${HASH}, upstream google\\)`));
    const fake = deps({ served: [{ upstream: "fake" }] });
    expect(await update(fake.d)).toEqual({ exitCode: 1 });
    expect(logs.at(-1)).toMatch(/upstream fake; expected/);
    const other = deps({ served: [{ name: "something" }] });
    expect(await update(other.d)).toEqual({ exitCode: 1 });
    const down = deps({ served: [{ status: 503 }] });
    expect(await update(down.d)).toEqual({ exitCode: 1 });
    expect(logs.at(-1)).toMatch(/\(status 503\)/);
  });

  it("passes once the new SDK answers (propagation after a deploy)", async () => {
    writeConfig();
    const { d, fetched } = deps({ served: [{ sdkHash: OLD_HASH }, {}] });
    expect(await update(d)).toEqual({ exitCode: 0 });
    expect(fetched).toHaveLength(2);
  });
});

describe("smokeOrigin", () => {
  it("accepts https origins and loopback http only", () => {
    expect(smokeOrigin("https://gws.example.com/")).toBe("https://gws.example.com");
    expect(smokeOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(smokeOrigin("http://gws.example.com")).toBeNull();
    expect(smokeOrigin("https://gws.example.com/x")).toBeNull();
  });
});
