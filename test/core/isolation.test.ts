import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { FAKE_CLIENT_SECRET, loadConfig } from "../../src/config";
import type { AuthProps } from "../../src/contracts";
import { runExecute, type ExecuteReport } from "../../src/core/execute";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const config = loadConfig(env);

let auth: AuthProps;
let forbidden: string[];

beforeAll(async () => {
  const email = uniqueEmail("isolation");
  const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}drive.file`], isDefault: true });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }] });
  auth = { userId: seeded.userId, clientId: `client-${crypto.randomUUID()}` };
  await openStore(env).grants.add(auth.userId, auth.clientId, seeded.account.id);
  forbidden = ["ya29.", "1//", env.TOKEN_ENC_KEY, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CLIENT_ID, FAKE_CLIENT_SECRET, seeded.refreshToken];
});

/** Runs a snippet after a real SDK call in the same execute, so an access token exists host-side. */
function probe(body: string): Promise<ExecuteReport> {
  return runExecute({ code: `async () => { await sdk.drive.files.list({}); ${body} }`, apply: false, auth, ports: workersPorts(env), config });
}

function expectNoSecret(out: ExecuteReport): void {
  const text = JSON.stringify(out);
  for (const s of forbidden) expect(text.includes(s), `output must not contain ${s.slice(0, 6)}…`).toBe(false);
}

describe("sandbox isolation", () => {
  it("refuses network access from the snippet", async () => {
    const out = await probe(
      'try { const r = await fetch("https://example.com/"); return "fetched " + r.status; } catch (e) { return String(e && e.message); }',
    );
    expect(out.ok).toBe(true);
    expect(out.result).toMatch(/not permitted to access the internet/);
    expectNoSecret(out);
  });

  it("gives the snippet no env: no global env, empty this.env, process.env and cloudflare:workers env", async () => {
    const out = await probe(`
      const cf = await import("cloudflare:workers");
      return {
        env: typeof env,
        thisEnv: Object.keys(this?.env ?? {}),
        processEnv: typeof process === "undefined" ? [] : Object.keys(process.env),
        cfEnv: Object.keys(cf.env ?? {}),
        props: Object.keys(this?.ctx?.props ?? {}),
      };`);
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({ env: "undefined", thisEnv: [], processEnv: [], cfEnv: [], props: [] });
    expectNoSecret(out);
  });

  it("exposes no binding or secret among the sandbox globals", async () => {
    const out = await probe("return JSON.stringify(Object.getOwnPropertyNames(globalThis));");
    const globals = JSON.parse(out.result as string) as string[];
    for (const name of ["TOKEN_ENC_KEY", "GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "DB", "CACHE_KV", "OAUTH_KV", "FAKE_GOOGLE", "LOADER"]) {
      expect(globals).not.toContain(name);
    }
    expectNoSecret(out);
  });

  it("finds nothing but path strings and the RPC dispatcher when inspecting sdk internals", async () => {
    const out = await probe(`
      return {
        dispatchers: Object.keys(__dispatchers ?? {}),
        dispatchersJson: JSON.stringify(__dispatchers),
        gws: Object.getOwnPropertyNames(__gws),
        sdkString: String(sdk),
        sdkNames: Object.getOwnPropertyNames(sdk),
        sdkJson: JSON.stringify({ sdk, nested: sdk.drive.files }),
        listed: await sdk.drive.files.list({}),
      };`);
    expect(out.error).toBeUndefined();
    const r = out.result as Record<string, unknown>;
    expect(r.dispatchers).toEqual(["__gws"]);
    expect(r.sdkString).toBe("sdk");
    expect(r.sdkJson).toBe("{}");
    expectNoSecret(out);
  });

  it("redacts a token-shaped string in console output", async () => {
    const out = await probe('console.log("token", "ya29.a0Afakefakefake"); console.error("Bearer abc.def"); return 1;');
    expect(out.logs).toEqual(["token [REDACTED]", "[error] [REDACTED]"]);
    expectNoSecret(out);
  });

  it("redacts the value of every Worker secret the snippet prints", async () => {
    const values = [env.TOKEN_ENC_KEY, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET].map((v) => JSON.stringify(v));
    const out = await probe(`console.log(${values.join(", ")}); return 1;`);
    expect(out.logs).toEqual(["[REDACTED] [REDACTED] [REDACTED]"]);
    expectNoSecret(out);
  });

  it("redacts the known secret values wherever the snippet puts them: logs, result and error", async () => {
    const key = JSON.stringify(env.TOKEN_ENC_KEY);
    const out = await probe(`
      console.log(${key}, ${JSON.stringify(FAKE_CLIENT_SECRET)});
      throw new Error("leak " + ${key} + " 1//refresh");`);
    expect(out.logs).toEqual(["[REDACTED] [REDACTED]"]);
    expect(out.error).toEqual({ code: "GWS_EXECUTION_ERROR", message: "leak [REDACTED] [REDACTED]" });
    const ret = await probe(`return { k: ${key}, t: "ya29.zzz" };`);
    expect(ret.result).toEqual({ k: "[REDACTED]", t: "[REDACTED]" });
    expectNoSecret(out);
    expectNoSecret(ret);
  });
});
