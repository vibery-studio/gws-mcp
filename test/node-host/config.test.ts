import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configSummary,
  loadNodeHostConfig,
  NodeHostConfigError,
  parseTrustedProxies,
  readSecretsFile,
  scrubSecretsFromEnv,
  startupWarnings,
} from "../../src/runtime/node/config";

/** Test-only values; never used outside these tests. */
const KEY = Buffer.from("gws-mcp-node-host-test-key-01234").toString("base64");
const CLIENT_ID = "test-only-client.apps.googleusercontent.com";
const CLIENT_SECRET = "test-only-client-secret-value";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function secretsFile(text: string, mode = 0o600): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gws-node-host-cfg-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "secrets.env");
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
}

const base = (extra: Record<string, string> = {}): Record<string, string> => ({
  GOOGLE_UPSTREAM: "google",
  PUBLIC_BASE_URL: "https://gws.example.com",
  GWS_DB_FILE: "/var/lib/gws-mcp/gws-mcp.db",
  TOKEN_ENC_KEY: KEY,
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  ...extra,
});

/** The rejection message, checked to never carry a secret value. */
async function refusal(env: Record<string, string | undefined>): Promise<string> {
  try {
    await loadNodeHostConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(NodeHostConfigError);
    const message = (e as Error).message;
    for (const secret of [KEY, CLIENT_ID, CLIENT_SECRET]) expect(message).not.toContain(secret);
    return message;
  }
  throw new Error("the config loaded");
}

describe("Node host config", () => {
  it("loads Worker vars, secrets and host settings with safe defaults", async () => {
    const c = await loadNodeHostConfig(base({ GOOGLE_SCOPE_PRESET: "full", RATE_USER_PER_MIN: "60", UNRELATED: "x" }));
    expect(c.worker.PUBLIC_BASE_URL).toBe("https://gws.example.com");
    expect(c.worker.GOOGLE_SCOPE_PRESET).toBe("full");
    expect(c.worker.RATE_USER_PER_MIN).toBe(60);
    expect(c.vars).not.toHaveProperty("UNRELATED");
    expect(c.vars).not.toHaveProperty("TOKEN_ENC_KEY");
    expect(c.secretSources).toEqual({ TOKEN_ENC_KEY: "env", GOOGLE_CLIENT_ID: "env", GOOGLE_CLIENT_SECRET: "env" });
    expect([c.listenHost, c.port, c.dbFile]).toEqual(["127.0.0.1", 8787, "/var/lib/gws-mcp/gws-mcp.db"]);
    expect(c.trustedProxies).toBeNull();
    expect(c.maxBodyBytes).toBe(1024 * 1024);
    expect(c.fakeGoogleUrl).toBeUndefined();
  });

  it("fails fast on a missing or malformed TOKEN_ENC_KEY, naming it only", async () => {
    expect(await refusal(base({ TOKEN_ENC_KEY: "" }))).toMatch(/missing secret: TOKEN_ENC_KEY/);
    expect(await refusal(base({ TOKEN_ENC_KEY: "bm90LTMyLWJ5dGVz" }))).toMatch(/TOKEN_ENC_KEY: must be base64 of exactly 32 bytes/);
  });

  it("requires the Google client values for the Google upstream only", async () => {
    expect(await refusal(base({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" }))).toMatch(/missing secret: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET/);
    const fake = await loadNodeHostConfig({
      GOOGLE_UPSTREAM: "fake",
      PUBLIC_BASE_URL: "http://127.0.0.1:8790",
      FAKE_GOOGLE_PUBLIC_URL: "http://127.0.0.1:8788",
      GWS_DB_FILE: "x.db",
      TOKEN_ENC_KEY: KEY,
    });
    expect(fake.worker.GOOGLE_UPSTREAM).toBe("fake");
    expect(fake.fakeGoogleUrl).toBe("http://127.0.0.1:8788");
    expect(fake.secrets).toEqual({ TOKEN_ENC_KEY: KEY });
  });

  it("mirrors the Workers fake mode: FAKE_GOOGLE_PUBLIC_URL required, a separate internal URL allowed only in fake mode", async () => {
    const fake = { GOOGLE_UPSTREAM: "fake", PUBLIC_BASE_URL: "http://localhost:8790", GWS_DB_FILE: "x.db", TOKEN_ENC_KEY: KEY };
    expect(await refusal(fake)).toMatch(/FAKE_GOOGLE_PUBLIC_URL/);
    const internal = await loadNodeHostConfig({ ...fake, FAKE_GOOGLE_PUBLIC_URL: "http://localhost:8788", GWS_FAKE_GOOGLE_URL: "http://fake:8788/" });
    expect(internal.fakeGoogleUrl).toBe("http://fake:8788");
    expect(await refusal(base({ GWS_FAKE_GOOGLE_URL: "http://fake:8788" }))).toMatch(/GWS_FAKE_GOOGLE_URL/);
  });

  it("requires PUBLIC_BASE_URL, GOOGLE_UPSTREAM and GWS_DB_FILE, and validates them as on Workers", async () => {
    expect(await refusal(base({ PUBLIC_BASE_URL: "" }))).toMatch(/PUBLIC_BASE_URL/);
    expect(await refusal(base({ PUBLIC_BASE_URL: "http://gws.example.com" }))).toMatch(/invalid config: PUBLIC_BASE_URL/);
    expect(await refusal(base({ PUBLIC_BASE_URL: "https://gws.example.com/sub" }))).toMatch(/invalid config: PUBLIC_BASE_URL/);
    expect(await refusal(base({ GOOGLE_UPSTREAM: "" }))).toMatch(/GOOGLE_UPSTREAM/);
    expect(await refusal(base({ GWS_DB_FILE: "" }))).toMatch(/GWS_DB_FILE/);
    expect(await refusal(base({ GWS_PORT: "99999" }))).toMatch(/invalid config: GWS_PORT/);
    expect(await refusal(base({ GWS_MAX_BODY_BYTES: "1e12" }))).toMatch(/GWS_MAX_BODY_BYTES/);
    expect(await refusal(base({ CALLS_PER_EXECUTE: "100000" }))).toMatch(/invalid config: CALLS_PER_EXECUTE/);
  });

  it("reads secrets from an owner-only file", async () => {
    const file = secretsFile(`# gws-mcp\n\nTOKEN_ENC_KEY=${KEY}\nGOOGLE_CLIENT_ID="${CLIENT_ID}"\nGOOGLE_CLIENT_SECRET = '${CLIENT_SECRET}'\n`);
    const c = await loadNodeHostConfig(base({ TOKEN_ENC_KEY: "", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", GWS_SECRETS_FILE: file }));
    expect(c.secrets).toEqual({ TOKEN_ENC_KEY: KEY, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET });
    expect(c.secretSources).toEqual({ TOKEN_ENC_KEY: "file", GOOGLE_CLIENT_ID: "file", GOOGLE_CLIENT_SECRET: "file" });
  });

  it.each(["640", "604", "644", "660", "602"])("refuses a secrets file with mode %s", async (mode) => {
    const file = secretsFile(`TOKEN_ENC_KEY=${KEY}\n`, Number.parseInt(mode, 8));
    expect(await refusal(base({ TOKEN_ENC_KEY: "", GWS_SECRETS_FILE: file }))).toMatch(/open to group or others.*chmod 600/);
  });

  it("refuses a secret set twice, unknown names and lines that are not NAME=value, without echoing values", async () => {
    const both = secretsFile(`TOKEN_ENC_KEY=${KEY}\n`);
    expect(await refusal(base({ GWS_SECRETS_FILE: both }))).toMatch(/TOKEN_ENC_KEY is set both/);
    expect(() => readSecretsFile(secretsFile("ADMIN_TOKEN=x\n"))).toThrow(/line 1: unknown secret ADMIN_TOKEN/);
    const pasted = secretsFile(`TOKEN_ENC_KEY=${KEY}\n${CLIENT_SECRET}\n`);
    expect(await refusal(base({ TOKEN_ENC_KEY: "", GWS_SECRETS_FILE: pasted }))).toMatch(/line 2 is not NAME=value/);
    expect(() => readSecretsFile(secretsFile(`TOKEN_ENC_KEY=${KEY}\nTOKEN_ENC_KEY=${KEY}\n`))).toThrow(/twice/);
    expect(() => readSecretsFile(secretsFile("TOKEN_ENC_KEY=\n"))).toThrow(/empty value/);
    expect(() => readSecretsFile(path.join(tmpdir(), "gws-node-host-no-such-file"))).toThrow(/does not name a readable file/);
    expect(() => readSecretsFile(tmpdir())).toThrow(/not a regular file/);
  });

  it("parses trusted proxies as addresses and CIDR ranges, refusing anything else", () => {
    const t = parseTrustedProxies("10.0.0.0/8, 192.168.1.5,fd00::/8, ::1");
    expect(["10.1.2.3", "::ffff:10.9.9.9", "192.168.1.5", "fd12::1", "::1"].map((a) => t.has(a))).toEqual([true, true, true, true, true]);
    expect(["11.0.0.1", "192.168.1.6", "fe80::1", "not-an-ip"].map((a) => t.has(a))).toEqual([false, false, false, false]);
    for (const bad of ["", "10.0.0.0/33", "10.0.0.0/8/1", "proxy.local", "10.0.0.0/x", "::1/129"]) {
      expect(() => parseTrustedProxies(bad), bad).toThrow(NodeHostConfigError);
    }
  });

  it("summarizes the config for the boot log without any secret value", async () => {
    const c = await loadNodeHostConfig(base({ GWS_TRUSTED_PROXIES: "10.0.0.0/8" }));
    const text = JSON.stringify(configSummary(c));
    for (const secret of [KEY, CLIENT_ID, CLIENT_SECRET]) expect(text).not.toContain(secret);
    expect(configSummary(c)).toMatchObject({ secrets: { TOKEN_ENC_KEY: "env" }, trustedProxies: ["10.0.0.0/8"], clientIpHeader: "x-forwarded-for" });
  });

  it("scrubs the secrets from the process environment", () => {
    const env: Record<string, string | undefined> = base();
    scrubSecretsFromEnv(env);
    expect(Object.keys(env).sort()).toEqual(["GOOGLE_UPSTREAM", "GWS_DB_FILE", "PUBLIC_BASE_URL"]);
  });

  it("warns at boot about proxy trust: none set, or a trusted proxy without an explicit client-address header", async () => {
    const none = startupWarnings(await loadNodeHostConfig(base()));
    expect(none).toHaveLength(1);
    expect(none[0]).toMatch(/^GWS_TRUSTED_PROXIES is not set: if this server runs behind a reverse proxy, every client shares the proxy's address/);
    const noHeader = startupWarnings(await loadNodeHostConfig(base({ GWS_TRUSTED_PROXIES: "10.0.0.2" })));
    expect(noHeader).toHaveLength(1);
    expect(noHeader[0]).toMatch(/^GWS_CLIENT_IP_HEADER is not set, so the client address is read from x-forwarded-for; set it to the header your proxy overwrites/);
    expect(startupWarnings(await loadNodeHostConfig(base({ GWS_TRUSTED_PROXIES: "10.0.0.2", GWS_CLIENT_IP_HEADER: "x-forwarded-for" })))).toEqual([]);
    expect(startupWarnings(await loadNodeHostConfig(base({ GWS_TRUSTED_PROXIES: "10.0.0.2", GWS_CLIENT_IP_HEADER: "x-real-ip" })))).toEqual([]);
  });

  it("reads and requires no secret when asked not to (the access command)", async () => {
    const env = base({ TOKEN_ENC_KEY: "", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", GWS_SECRETS_FILE: path.join(tmpdir(), "gws-no-such-dir", "absent") });
    const c = await loadNodeHostConfig(env, { secrets: false });
    expect([c.secrets, c.secretSources]).toEqual([{}, {}]);
    expect(c.worker.PUBLIC_BASE_URL).toBe("https://gws.example.com");
    expect(await refusal(env)).toMatch(/GWS_SECRETS_FILE does not name a readable file/);
  });
});
