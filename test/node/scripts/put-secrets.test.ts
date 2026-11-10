import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SpawnLike, putSecrets } from "../../../scripts/put-secrets";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET } from "../../../src/config";

const DUMMY_ID = "dummy-client-id-0000.apps.example.invalid";
const DUMMY_SECRET = "dummy-client-secret-value-0000";
const DUMMY_FAKE_ADMIN = "dummy-fake-admin-token-value-0000";

interface Spawned {
  cmd: string;
  args: string[];
  stdin: string;
  env: NodeJS.ProcessEnv | undefined;
}

/**
 * A spawn stand-in: records argv and stdin, then exits. `secret list` prints the `deployed` names as wrangler's
 * JSON (names only) and exits with `listCode`; `secret put` exits with `code`, optionally echoing stdin on stderr.
 */
function stubSpawn(
  code = 0,
  echoStdinToStderr = false,
  wrangler: { deployed?: readonly string[]; listCode?: number } = {},
): { spawn: SpawnLike; calls: Spawned[]; puts: () => Spawned[]; lists: () => Spawned[] } {
  const calls: Spawned[] = [];
  const spawn: SpawnLike = (cmd, args, opts) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const call: Spawned = { cmd, args: [...args], stdin: "", env: opts.env };
    calls.push(call);
    child.stdin.on("data", (d: Buffer) => {
      call.stdin += d.toString("utf8");
    });
    child.stdin.on("finish", () => {
      if (args[1] === "secret" && args[2] === "list") {
        const listCode = wrangler.listCode ?? 0;
        const listed = (wrangler.deployed ?? []).map((name) => ({ name, type: "secret_text" }));
        child.stdout.end(listCode === 0 ? JSON.stringify(listed) : "");
        child.stderr.end(listCode === 0 ? "" : "list failed\n");
        setImmediate(() => child.emit("close", listCode));
        return;
      }
      child.stdout.end("✨ Success! Uploaded secret\n");
      child.stderr.end(echoStdinToStderr ? `boom: ${call.stdin}\n` : "");
      setImmediate(() => child.emit("close", code));
    });
    return child as unknown as ReturnType<SpawnLike>;
  };
  const puts = () => calls.filter((c) => c.args[2] === "put");
  const lists = () => calls.filter((c) => c.args[2] === "list");
  return { spawn, calls, puts, lists };
}

let dir: string;
let envFile: string;
let lines: string[];
const log = (line: string) => lines.push(line);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "put-secrets-"));
  envFile = path.join(dir, "secrets-fixture.txt");
  lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("put-secrets", () => {
  it("pipes each value to wrangler over stdin, never argv, and prints names only", async () => {
    writeFileSync(envFile, `GOOGLE_CLIENT_ID=${DUMMY_ID}\nGOOGLE_CLIENT_SECRET="${DUMMY_SECRET}"\nTOKEN_ENC_KEY=existing-key-value\n`, { mode: 0o600 });
    const { spawn, calls, puts } = stubSpawn();
    const res = await putSecrets({ worker: "gws-mcp", names: ["TOKEN_ENC_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], envFile, spawn, log });

    expect(res.exitCode).toBe(0);
    expect(puts().map((c) => c.stdin)).toEqual(["existing-key-value", DUMMY_ID, DUMMY_SECRET]);
    for (const c of puts()) {
      expect(c.cmd).toBe("npx");
      expect(c.args.slice(0, 3)).toEqual(["wrangler", "secret", "put"]);
      expect(c.args).toContain("--name");
      expect(c.args[c.args.indexOf("--name") + 1]).toBe("gws-mcp");
      expect(c.args[c.args.indexOf("--config") + 1]).toMatch(/(^|\/)wrangler\.jsonc$/);
    }
    for (const c of calls) {
      const argv = c.args.join(" ");
      for (const v of [DUMMY_ID, DUMMY_SECRET, "existing-key-value"]) expect(argv).not.toContain(v);
    }
    const out = lines.join("\n");
    for (const v of [DUMMY_ID, DUMMY_SECRET, "existing-key-value"]) expect(out).not.toContain(v);
    expect(lines).toEqual([
      "env TOKEN_ENC_KEY present",
      "env GOOGLE_CLIENT_ID present",
      "env GOOGLE_CLIENT_SECRET present",
      "secret TOKEN_ENC_KEY set on gws-mcp",
      "secret GOOGLE_CLIENT_ID set on gws-mcp",
      "secret GOOGLE_CLIENT_SECRET set on gws-mcp",
    ]);
  });

  it("generates a missing deployment key, appends it with mode 600 and leaves other lines untouched", async () => {
    const original = `# comment\nGOOGLE_CLIENT_ID=${DUMMY_ID}\nGOOGLE_CLIENT_SECRET=${DUMMY_SECRET}\nFAKE_ADMIN_TOKEN=${DUMMY_FAKE_ADMIN}`;
    writeFileSync(envFile, original, { mode: 0o644 });
    const { spawn, calls } = stubSpawn();
    const res = await putSecrets({ worker: "gws-mcp-fake-google", names: ["FAKE_ADMIN_TOKEN", "FAKE_SIGNING_KEY", "FAKE_LOGIN_SECRET"], envFile, spawn, log });

    expect(res.exitCode).toBe(0);
    const text = readFileSync(envFile, "utf8");
    expect(text.startsWith(`${original}\n`)).toBe(true);
    const appended = text.slice(original.length + 1).trimEnd().split("\n");
    expect(appended.map((l) => l.split("=")[0])).toEqual(["FAKE_SIGNING_KEY", "FAKE_LOGIN_SECRET"]);
    for (const l of appended) expect(Buffer.from(l.slice(l.indexOf("=") + 1), "base64")).toHaveLength(32);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);

    const generated = appended.map((l) => l.slice(l.indexOf("=") + 1));
    expect(calls.map((c) => c.stdin)).toEqual([DUMMY_FAKE_ADMIN, ...generated]);
    expect(calls.every((c) => c.args[c.args.indexOf("--config") + 1]?.endsWith(path.join("fake-google", "wrangler.jsonc")))).toBe(true);
    const out = lines.join("\n");
    for (const v of [DUMMY_FAKE_ADMIN, ...generated]) expect(out).not.toContain(v);
    expect(lines.slice(0, 3)).toEqual(["env FAKE_ADMIN_TOKEN present", "env FAKE_SIGNING_KEY generated", "env FAKE_LOGIN_SECRET generated"]);

    // A second run reuses the stored values instead of generating new ones.
    const again = stubSpawn();
    lines = [];
    await putSecrets({ worker: "gws-mcp-fake-google", names: ["FAKE_SIGNING_KEY"], envFile, spawn: again.spawn, log });
    expect(again.calls.map((c) => c.stdin)).toEqual([generated[0]]);
    expect(readFileSync(envFile, "utf8")).toBe(text);
  });

  it("creates the env file with mode 600 when it does not exist", async () => {
    const { spawn } = stubSpawn();
    const res = await putSecrets({ worker: "gws-mcp", names: ["TOKEN_ENC_KEY"], envFile, spawn, log });
    expect(res.exitCode).toBe(0);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(envFile, "utf8")).toMatch(/^TOKEN_ENC_KEY=[A-Za-z0-9+/]{43}=\n$/);
  });

  it("never generates the Google client credentials: a missing one blocks before anything runs", async () => {
    writeFileSync(envFile, `GOOGLE_CLIENT_ID=${DUMMY_ID}\nGOOGLE_CLIENT_SECRET=\n`, { mode: 0o600 });
    const before = readFileSync(envFile, "utf8");
    const { spawn, calls } = stubSpawn();
    const res = await putSecrets({ worker: "gws-mcp", names: ["TOKEN_ENC_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], envFile, spawn, log });

    expect(res.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
    expect(readFileSync(envFile, "utf8")).toBe(before);
    expect(lines).toEqual([expect.stringMatching(/^BLOCKED: GOOGLE_CLIENT_SECRET is missing/)]);
  });

  it("refuses unknown workers and names that do not belong to the worker", async () => {
    const { spawn, calls } = stubSpawn();
    expect((await putSecrets({ worker: "other-worker", names: ["TOKEN_ENC_KEY"], envFile, spawn, log })).exitCode).toBe(64);
    expect((await putSecrets({ worker: "gws-mcp", names: ["FAKE_ADMIN_TOKEN"], envFile, spawn, log })).exitCode).toBe(64);
    expect((await putSecrets({ worker: "gws-mcp", names: [], envFile, spawn, log })).exitCode).toBe(64);
    expect(calls).toHaveLength(0);
  });

  it("reports a wrangler failure by name with any secret value scrubbed from its error output", async () => {
    writeFileSync(envFile, `GOOGLE_CLIENT_ID=${DUMMY_ID}\n`, { mode: 0o600 });
    const { spawn, puts } = stubSpawn(1, true);
    const res = await putSecrets({ worker: "gws-mcp", names: ["GOOGLE_CLIENT_ID", "TOKEN_ENC_KEY"], envFile, spawn, log });

    expect(res.exitCode).toBe(1);
    expect(puts()).toHaveLength(1);
    const out = lines.join("\n");
    expect(out).toContain("secret GOOGLE_CLIENT_ID FAILED on gws-mcp (exit 1)");
    expect(out).toContain("boom: [REDACTED]");
    expect(out).not.toContain(DUMMY_ID);
  });

  it("checks by name whether TOKEN_ENC_KEY is deployed and refuses to replace it without --rotate", async () => {
    const original = `GOOGLE_CLIENT_ID=${DUMMY_ID}\nTOKEN_ENC_KEY=local-key-value\n`;
    writeFileSync(envFile, original, { mode: 0o600 });
    const { spawn, calls, puts, lists } = stubSpawn(0, false, { deployed: ["GOOGLE_CLIENT_ID", "TOKEN_ENC_KEY"] });
    const res = await putSecrets({ worker: "gws-mcp", names: ["GOOGLE_CLIENT_ID", "TOKEN_ENC_KEY"], envFile, spawn, log });

    expect(res.exitCode).toBe(2);
    expect(puts()).toHaveLength(0);
    expect(lists()).toHaveLength(1);
    const list = lists()[0];
    expect(list?.args.slice(0, 5)).toEqual(["wrangler", "secret", "list", "--name", "gws-mcp"]);
    expect(list?.args[(list?.args.indexOf("--config") ?? -2) + 1]).toMatch(/(^|\/)wrangler\.jsonc$/);
    expect(list?.args).toEqual(expect.arrayContaining(["--format", "json"]));
    expect(list?.stdin).toBe("");
    expect(readFileSync(envFile, "utf8")).toBe(original);
    expect(lines).toEqual([expect.stringMatching(/^REFUSED: TOKEN_ENC_KEY is already set on gws-mcp.*--rotate/)]);
    for (const c of calls) for (const v of [DUMMY_ID, "local-key-value"]) expect(c.args.join(" ")).not.toContain(v);
    for (const v of [DUMMY_ID, "local-key-value"]) expect(lines.join("\n")).not.toContain(v);
  });

  it("refuses before generating a replacement when the env file lacks a deployed TOKEN_ENC_KEY", async () => {
    const original = `GOOGLE_CLIENT_ID=${DUMMY_ID}\n`;
    writeFileSync(envFile, original, { mode: 0o600 });
    const { spawn, puts } = stubSpawn(0, false, { deployed: ["TOKEN_ENC_KEY"] });
    const res = await putSecrets({ worker: "gws-mcp", names: ["TOKEN_ENC_KEY"], envFile, spawn, log });
    expect(res.exitCode).toBe(2);
    expect(puts()).toHaveLength(0);
    expect(readFileSync(envFile, "utf8")).toBe(original);
  });

  it("with --rotate, generates a new TOKEN_ENC_KEY that replaces its line in place and is the value uploaded", async () => {
    const original = `# keys\nGOOGLE_CLIENT_ID=${DUMMY_ID}\nTOKEN_ENC_KEY=old-key-value\nOTHER_SETTING="kept as is"\n`;
    writeFileSync(envFile, original, { mode: 0o644 });
    const { spawn, calls, puts, lists } = stubSpawn(0, false, { deployed: ["TOKEN_ENC_KEY"] });
    const res = await putSecrets({ worker: "gws-mcp", names: ["TOKEN_ENC_KEY"], envFile, spawn, log, rotate: true });

    expect(res.exitCode).toBe(0);
    expect(lists()).toHaveLength(0);
    const text = readFileSync(envFile, "utf8");
    const fileLines = text.split("\n");
    expect(fileLines.filter((l) => l.startsWith("TOKEN_ENC_KEY="))).toHaveLength(1);
    const rotated = fileLines[2]?.slice("TOKEN_ENC_KEY=".length) ?? "";
    expect(fileLines[2]?.startsWith("TOKEN_ENC_KEY=")).toBe(true);
    expect(rotated).not.toBe("old-key-value");
    expect(Buffer.from(rotated, "base64")).toHaveLength(32);
    expect(text).toBe(original.replace("TOKEN_ENC_KEY=old-key-value", `TOKEN_ENC_KEY=${rotated}`));
    expect(statSync(envFile).mode & 0o777).toBe(0o600);

    expect(puts().map((c) => c.stdin)).toEqual([rotated]);
    for (const c of calls) for (const v of [rotated, "old-key-value"]) expect(c.args.join(" ")).not.toContain(v);
    for (const v of [rotated, "old-key-value"]) expect(lines.join("\n")).not.toContain(v);
    expect(lines).toEqual(["env TOKEN_ENC_KEY rotated", "secret TOKEN_ENC_KEY set on gws-mcp"]);

    // A later run without --rotate uploads the rotated value as present and leaves the file alone.
    const again = stubSpawn();
    lines = [];
    expect((await putSecrets({ worker: "gws-mcp", names: ["TOKEN_ENC_KEY"], envFile, spawn: again.spawn, log })).exitCode).toBe(0);
    expect(again.puts().map((c) => c.stdin)).toEqual([rotated]);
    expect(readFileSync(envFile, "utf8")).toBe(text);
  });

  it("with --rotate, collapses repeated TOKEN_ENC_KEY lines into one at the first position", async () => {
    writeFileSync(envFile, "TOKEN_ENC_KEY=\nA=1\nexport TOKEN_ENC_KEY=old-one\nB=2\nTOKEN_ENC_KEY='old-two'", { mode: 0o600 });
    const { spawn, puts } = stubSpawn();
    const res = await putSecrets({ worker: "gws-mcp", names: ["TOKEN_ENC_KEY"], envFile, spawn, log, rotate: true });

    expect(res.exitCode).toBe(0);
    const fileLines = readFileSync(envFile, "utf8").split("\n");
    expect(fileLines).toHaveLength(3);
    expect(fileLines.slice(1)).toEqual(["A=1", "B=2"]);
    const rotated = fileLines[0]?.slice("TOKEN_ENC_KEY=".length) ?? "";
    expect(fileLines[0]?.startsWith("TOKEN_ENC_KEY=")).toBe(true);
    expect(Buffer.from(rotated, "base64")).toHaveLength(32);
    expect(puts().map((c) => c.stdin)).toEqual([rotated]);
    for (const v of [rotated, "old-one", "old-two"]) expect(lines.join("\n")).not.toContain(v);
  });

  it("with --rotate and no TOKEN_ENC_KEY in the env file, appends the new key", async () => {
    const original = `GOOGLE_CLIENT_ID=${DUMMY_ID}`;
    writeFileSync(envFile, original, { mode: 0o600 });
    const { spawn, puts } = stubSpawn();
    const res = await putSecrets({ worker: "gws-mcp", names: ["TOKEN_ENC_KEY"], envFile, spawn, log, rotate: true });

    expect(res.exitCode).toBe(0);
    const text = readFileSync(envFile, "utf8");
    expect(text).toMatch(new RegExp(`^${original}\\nTOKEN_ENC_KEY=[A-Za-z0-9+/]{43}=\\n$`));
    expect(puts().map((c) => c.stdin)).toEqual([text.slice(text.indexOf("TOKEN_ENC_KEY=") + 14).trimEnd()]);
    expect(lines[0]).toBe("env TOKEN_ENC_KEY rotated");
  });

  it("with --rotate, never regenerates names outside the rotate set", async () => {
    const original = `GOOGLE_CLIENT_ID=${DUMMY_ID}\nTOKEN_ENC_KEY=old-key-value\nGOOGLE_CLIENT_SECRET=${DUMMY_SECRET}\n`;
    writeFileSync(envFile, original, { mode: 0o600 });
    const { spawn, puts } = stubSpawn();
    const res = await putSecrets({
      worker: "gws-mcp",
      names: ["TOKEN_ENC_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      envFile,
      spawn,
      log,
      rotate: true,
    });

    expect(res.exitCode).toBe(0);
    const fileLines = readFileSync(envFile, "utf8").split("\n");
    expect(fileLines[0]).toBe(`GOOGLE_CLIENT_ID=${DUMMY_ID}`);
    expect(fileLines[2]).toBe(`GOOGLE_CLIENT_SECRET=${DUMMY_SECRET}`);
    const rotated = fileLines[1]?.slice("TOKEN_ENC_KEY=".length) ?? "";
    expect(rotated).not.toBe("old-key-value");
    expect(puts().map((c) => c.stdin)).toEqual([rotated, DUMMY_ID, DUMMY_SECRET]);
    expect(lines.slice(0, 3)).toEqual(["env TOKEN_ENC_KEY rotated", "env GOOGLE_CLIENT_ID present", "env GOOGLE_CLIENT_SECRET present"]);

    // The fake upstream's keys are not in the rotate set either.
    const fakeOriginal = `FAKE_ADMIN_TOKEN=${DUMMY_FAKE_ADMIN}\n`;
    writeFileSync(envFile, fakeOriginal, { mode: 0o600 });
    const fake = stubSpawn();
    expect((await putSecrets({ worker: "gws-mcp-fake-google", names: ["FAKE_ADMIN_TOKEN"], envFile, spawn: fake.spawn, log, rotate: true })).exitCode).toBe(0);
    expect(fake.puts().map((c) => c.stdin)).toEqual([DUMMY_FAKE_ADMIN]);
    expect(readFileSync(envFile, "utf8")).toBe(fakeOriginal);
  });

  it("with --rotate, a missing Google credential still blocks before the env file is written", async () => {
    const original = `TOKEN_ENC_KEY=old-key-value\nGOOGLE_CLIENT_ID=${DUMMY_ID}\n`;
    writeFileSync(envFile, original, { mode: 0o644 });
    const { spawn, calls } = stubSpawn();
    const res = await putSecrets({ worker: "gws-mcp", names: ["TOKEN_ENC_KEY", "GOOGLE_CLIENT_SECRET"], envFile, spawn, log, rotate: true });

    expect(res.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
    expect(readFileSync(envFile, "utf8")).toBe(original);
    expect(statSync(envFile).mode & 0o777).toBe(0o644);
    expect(lines).toEqual([expect.stringMatching(/^BLOCKED: GOOGLE_CLIENT_SECRET is missing/)]);
  });

  it("refuses when the deployed secrets cannot be listed", async () => {
    writeFileSync(envFile, "TOKEN_ENC_KEY=local-key-value\n", { mode: 0o600 });
    const { spawn, puts } = stubSpawn(0, false, { listCode: 1 });
    const res = await putSecrets({ worker: "gws-mcp", names: ["TOKEN_ENC_KEY"], envFile, spawn, log });
    expect(res.exitCode).toBe(1);
    expect(puts()).toHaveLength(0);
    expect(lines[0]).toMatch(/^REFUSED: could not list the secrets of gws-mcp/);
    expect(lines.join("\n")).not.toContain("local-key-value");
  });

  it("does not list deployed secrets when TOKEN_ENC_KEY is not among the names", async () => {
    writeFileSync(envFile, `GOOGLE_CLIENT_ID=${DUMMY_ID}\n`, { mode: 0o600 });
    const { spawn, lists, puts } = stubSpawn(0, false, { deployed: ["TOKEN_ENC_KEY"] });
    const res = await putSecrets({ worker: "gws-mcp", names: ["GOOGLE_CLIENT_ID"], envFile, spawn, log });
    expect(res.exitCode).toBe(0);
    expect(lists()).toHaveLength(0);
    expect(puts().map((c) => c.stdin)).toEqual([DUMMY_ID]);
  });

  it("reads export-prefixed lines, so an exported key is present rather than regenerated", async () => {
    const original = "# deployment keys\nexport TOKEN_ENC_KEY=exported-key-value\n  export   FAKE_ADMIN_TOKEN = 'quoted-admin-value'\n";
    writeFileSync(envFile, original, { mode: 0o600 });
    const main = stubSpawn();
    expect((await putSecrets({ worker: "gws-mcp", names: ["TOKEN_ENC_KEY"], envFile, spawn: main.spawn, log })).exitCode).toBe(0);
    expect(main.puts().map((c) => c.stdin)).toEqual(["exported-key-value"]);
    const fake = stubSpawn();
    expect((await putSecrets({ worker: "gws-mcp-fake-google", names: ["FAKE_ADMIN_TOKEN"], envFile, spawn: fake.spawn, log })).exitCode).toBe(0);
    expect(fake.puts().map((c) => c.stdin)).toEqual(["quoted-admin-value"]);
    expect(readFileSync(envFile, "utf8")).toBe(original);
    expect(lines.filter((l) => l.startsWith("env "))).toEqual(["env TOKEN_ENC_KEY present", "env FAKE_ADMIN_TOKEN present"]);
    for (const v of ["exported-key-value", "quoted-admin-value"]) expect(lines.join("\n")).not.toContain(v);
  });

  describe("the fake-mode E2E Worker gws-mcp-e2e", () => {
    const PROD_KEY = "production-token-enc-key-value";
    const E2E_KEY = "e2e-token-enc-key-value";
    const ALL = ["TOKEN_ENC_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
    const realEnv = (extra = "") => `GOOGLE_CLIENT_ID=${DUMMY_ID}\nGOOGLE_CLIENT_SECRET=${DUMMY_SECRET}\nTOKEN_ENC_KEY=${PROD_KEY}\n${extra}`;

    /** Neither the real Google pair nor the production key appears in any argv, stdin or output line. */
    const expectNoProductionValues = (calls: Spawned[]) => {
      for (const c of calls) {
        for (const v of [DUMMY_ID, DUMMY_SECRET, PROD_KEY]) {
          expect(c.stdin).not.toContain(v);
          expect(c.args.join(" ")).not.toContain(v);
        }
      }
      for (const v of [DUMMY_ID, DUMMY_SECRET, PROD_KEY, E2E_KEY]) expect(lines.join("\n")).not.toContain(v);
    };

    it("sends E2E_TOKEN_ENC_KEY and the fake client placeholders, never the real Google pair or the production key", async () => {
      const original = realEnv(`E2E_TOKEN_ENC_KEY=${E2E_KEY}\n`);
      writeFileSync(envFile, original, { mode: 0o600 });
      const { spawn, calls, puts, lists } = stubSpawn();
      const res = await putSecrets({ worker: "gws-mcp-e2e", names: ALL, envFile, spawn, log });

      expect(res.exitCode).toBe(0);
      expect(puts().map((c) => [c.args[3], c.stdin])).toEqual([
        ["TOKEN_ENC_KEY", E2E_KEY],
        ["GOOGLE_CLIENT_ID", FAKE_CLIENT_ID],
        ["GOOGLE_CLIENT_SECRET", FAKE_CLIENT_SECRET],
      ]);
      for (const c of calls) {
        expect(c.args[c.args.indexOf("--name") + 1]).toBe("gws-mcp-e2e");
        // Its own untracked config, never production's wrangler.jsonc or a tracked example.
        expect(c.args[c.args.indexOf("--config") + 1]).toMatch(/(^|\/)wrangler\.e2e\.jsonc$/);
        expect(c.args[c.args.indexOf("--config") + 1]).not.toContain("fake-google");
      }
      expect(lists().map((c) => c.args[c.args.indexOf("--name") + 1])).toEqual(["gws-mcp-e2e"]);
      expectNoProductionValues(calls);
      expect(readFileSync(envFile, "utf8")).toBe(original);
      expect(lines).toEqual([
        "env E2E_TOKEN_ENC_KEY present (for TOKEN_ENC_KEY)",
        "fixed GOOGLE_CLIENT_ID (fake placeholder, not read from secrets-fixture.txt)",
        "fixed GOOGLE_CLIENT_SECRET (fake placeholder, not read from secrets-fixture.txt)",
        "secret TOKEN_ENC_KEY set on gws-mcp-e2e",
        "secret GOOGLE_CLIENT_ID set on gws-mcp-e2e",
        "secret GOOGLE_CLIENT_SECRET set on gws-mcp-e2e",
      ]);
    });

    it("generates a missing E2E_TOKEN_ENC_KEY instead of falling back to the production key", async () => {
      const original = realEnv();
      writeFileSync(envFile, original, { mode: 0o644 });
      const { spawn, calls, puts } = stubSpawn();
      const res = await putSecrets({ worker: "gws-mcp-e2e", names: ["TOKEN_ENC_KEY"], envFile, spawn, log });

      expect(res.exitCode).toBe(0);
      const text = readFileSync(envFile, "utf8");
      expect(text.startsWith(original)).toBe(true);
      const appended = text.slice(original.length);
      expect(appended).toMatch(/^E2E_TOKEN_ENC_KEY=[A-Za-z0-9+/]{43}=\n$/);
      const generated = appended.trimEnd().slice("E2E_TOKEN_ENC_KEY=".length);
      expect(generated).not.toBe(PROD_KEY);
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
      expect(puts().map((c) => c.stdin)).toEqual([generated]);
      expectNoProductionValues(calls);
      expect(lines.join("\n")).not.toContain(generated);
      expect(lines[0]).toBe("env E2E_TOKEN_ENC_KEY generated (for TOKEN_ENC_KEY)");
    });

    it("never needs the Google values in the env file: their absence does not block it", async () => {
      writeFileSync(envFile, `E2E_TOKEN_ENC_KEY=${E2E_KEY}\n`, { mode: 0o600 });
      const { spawn, puts } = stubSpawn();
      const res = await putSecrets({ worker: "gws-mcp-e2e", names: ALL, envFile, spawn, log });
      expect(res.exitCode).toBe(0);
      expect(puts().map((c) => c.stdin)).toEqual([E2E_KEY, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET]);
      expect(lines.some((l) => l.startsWith("BLOCKED"))).toBe(false);
    });

    it("refuses to replace its deployed TOKEN_ENC_KEY without --rotate", async () => {
      const original = realEnv(`E2E_TOKEN_ENC_KEY=${E2E_KEY}\n`);
      writeFileSync(envFile, original, { mode: 0o600 });
      const { spawn, calls, puts, lists } = stubSpawn(0, false, { deployed: ["TOKEN_ENC_KEY"] });
      const res = await putSecrets({ worker: "gws-mcp-e2e", names: ALL, envFile, spawn, log });

      expect(res.exitCode).toBe(2);
      expect(puts()).toHaveLength(0);
      expect(lists()).toHaveLength(1);
      expect(readFileSync(envFile, "utf8")).toBe(original);
      expect(lines).toEqual([expect.stringMatching(/^REFUSED: TOKEN_ENC_KEY is already set on gws-mcp-e2e.*--rotate/)]);
      expectNoProductionValues(calls);
    });

    it("with --rotate, rewrites only the E2E_TOKEN_ENC_KEY line and leaves the production key alone", async () => {
      const original = realEnv(`E2E_TOKEN_ENC_KEY=${E2E_KEY}\nOTHER=1\n`);
      writeFileSync(envFile, original, { mode: 0o600 });
      const { spawn, calls, puts, lists } = stubSpawn(0, false, { deployed: ["TOKEN_ENC_KEY"] });
      const res = await putSecrets({ worker: "gws-mcp-e2e", names: ["TOKEN_ENC_KEY"], envFile, spawn, log, rotate: true });

      expect(res.exitCode).toBe(0);
      expect(lists()).toHaveLength(0);
      const text = readFileSync(envFile, "utf8");
      const rotated = /^E2E_TOKEN_ENC_KEY=(.*)$/m.exec(text)?.[1] ?? "";
      expect(Buffer.from(rotated, "base64")).toHaveLength(32);
      expect(text).toBe(original.replace(`E2E_TOKEN_ENC_KEY=${E2E_KEY}`, `E2E_TOKEN_ENC_KEY=${rotated}`));
      expect(text).toContain(`TOKEN_ENC_KEY=${PROD_KEY}\n`);
      expect(puts().map((c) => c.stdin)).toEqual([rotated]);
      expectNoProductionValues(calls);
      expect(lines).toEqual(["env E2E_TOKEN_ENC_KEY rotated (for TOKEN_ENC_KEY)", "secret TOKEN_ENC_KEY set on gws-mcp-e2e"]);
    });

    it("leaves the production worker on its own values when the env file also holds the E2E key", async () => {
      writeFileSync(envFile, realEnv(`E2E_TOKEN_ENC_KEY=${E2E_KEY}\n`), { mode: 0o600 });
      const { spawn, calls, puts } = stubSpawn();
      const res = await putSecrets({ worker: "gws-mcp", names: ALL, envFile, spawn, log });

      expect(res.exitCode).toBe(0);
      expect(puts().map((c) => c.stdin)).toEqual([PROD_KEY, DUMMY_ID, DUMMY_SECRET]);
      for (const c of calls) {
        expect(c.args[c.args.indexOf("--name") + 1]).toBe("gws-mcp");
        for (const v of [E2E_KEY, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET]) expect(c.stdin).not.toBe(v);
      }
      expect(lines.slice(0, 3)).toEqual(["env TOKEN_ENC_KEY present", "env GOOGLE_CLIENT_ID present", "env GOOGLE_CLIENT_SECRET present"]);
    });
  });
});
