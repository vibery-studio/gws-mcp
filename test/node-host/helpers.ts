// Shared pieces of the Node host tests: a free loopback port, the fake Google as a Node HTTP server, and the built
// host run as a child process (exactly what `npm run serve:node` runs).
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createFakeGoogle } from "../../fake-google/src/app";
import { MemoryStore } from "../../fake-google/src/store";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET } from "../../src/config";

export const testOnly = (bytes = 24): string => randomBytes(bytes).toString("base64url");

/** A port nothing listens on right now (the OS picks it; the caller binds it next). */
export async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export interface FakeServer {
  origin: string;
  close(): Promise<void>;
}

/** The fake Google, deployed-shape (admin token and picker secret), redirecting only to `redirectUris`. */
export async function startFakeGoogle(secrets: { adminToken: string; loginSecret: string }, redirectUris: string[]): Promise<FakeServer> {
  const handler = createFakeGoogle({
    store: new MemoryStore(),
    signingKey: testOnly(),
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    adminToken: secrets.adminToken,
    loginSecret: secrets.loginSecret,
    redirectUris,
  });
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const method = req.method ?? "GET";
      const response = await handler(
        new Request(new URL(req.url ?? "/", "http://fake-google"), {
          method,
          headers,
          ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
          redirect: "manual",
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface HostProcess {
  child: ChildProcess;
  /** Every stdout and stderr line so far. */
  lines: string[];
  /** The exit code and signal, once the process has exited. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Resolves with the first JSON log line whose `msg` is `msg`. */
  waitFor(msg: string, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/** Runs the built host (`<dir>/server.js`) with exactly `env` (plus PATH): nothing of this process's env leaks in. */
export function runHost(dir: string, env: Record<string, string>): HostProcess {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(dir, "server.js")], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const waiters: Array<{ msg: string; resolve: (v: Record<string, unknown>) => void }> = [];
  const onLine = (line: string) => {
    lines.push(line);
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    for (const w of waiters.filter((x) => x.msg === parsed?.msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(parsed);
    }
  };
  for (const stream of [child.stdout, child.stderr]) {
    let buffered = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      buffered += chunk;
      let nl = buffered.indexOf("\n");
      while (nl >= 0) {
        onLine(buffered.slice(0, nl));
        buffered = buffered.slice(nl + 1);
        nl = buffered.indexOf("\n");
      }
    });
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return {
    child,
    lines,
    exited,
    waitFor(msg, timeoutMs = 20_000) {
      const seen = lines.map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      });
      const found = seen.find((l) => l?.msg === msg);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no "${msg}" log line within ${timeoutMs} ms; output:\n${lines.join("\n")}`)), timeoutMs);
        void exited.then(({ code }) => {
          clearTimeout(timer);
          reject(new Error(`the host exited (${code}) before "${msg}"; output:\n${lines.join("\n")}`));
        });
        waiters.push({
          msg,
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
        });
      });
    },
  };
}

/** Stops a host process: SIGTERM, then SIGKILL if it has not exited within `ms`. */
export async function stopHost(host: HostProcess, ms = 15_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (host.child.exitCode !== null || host.child.signalCode !== null) return host.exited;
  host.child.kill("SIGTERM");
  const timer = setTimeout(() => host.child.kill("SIGKILL"), ms);
  try {
    return await host.exited;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `<dir>/server.js <args>` (the host's commands) with exactly `env` (plus PATH) and waits for it to exit. */
export function runCommand(dir: string, env: Record<string, string>, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(dir, "server.js"), ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
