// Drives the bundled `gws-mcp` command (the package's `bin`) as a user would, in an isolated config folder that
// never touches the OS keychain or opens a browser. The browser part of a sign-in is played by the harness.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { FakeControl } from "./fake-server";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The bundled command, as `npm run build:local` writes it and the package's `bin` names it. */
export const CLI = path.join(ROOT, "dist", "cli.js");

export function requireBundle(): void {
  if (!existsSync(CLI)) throw new Error("the bundled CLI is missing: run npm run build:local first");
}

/** The environment of every command: the run's config folder, no keychain, no browser, nothing else inherited. */
export function cliEnv(configDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: os.homedir(),
    GWS_MCP_CONFIG_DIR: configDir,
    GWS_MCP_NO_KEYCHAIN: "1",
    GWS_MCP_NO_BROWSER: "1",
  };
}

export interface CliRun {
  code: number;
  out: string;
  err: string;
  /** The arguments the command ran with (to show that no secret was among them). */
  argv: string[];
}

/** Runs one command to completion; `input` goes to its stdin. */
export function runCommand(configDir: string, argv: string[], input = ""): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], { env: cliEnv(configDir), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, out, err, argv }));
    child.stdin.end(input);
  });
}

export interface AddOutcome extends CliRun {
  /** The one-time link the command printed (no browser): the only sign-in URL it shows. */
  startUrl: string;
  /** Where the start link sent the browser: Google's URL, with the state and PKCE challenge. */
  authUrl: string;
  redirect: URL;
  /** Status of a second visit to the start link (must be refused, 410). */
  startAgainStatus: number;
  /** Status of the real callback without the browser's flow cookie (must be refused, 400). */
  noCookieStatus: number;
  /** Status of a callback with the cookie but a forged state (must be refused, 400). */
  forgedStatus: number;
  /** Status of the real callback (200). */
  callbackStatus: number;
  /** Whether the listener accepted a connection on a non-loopback address of this machine (must be false), or null. */
  reachableFromLan: boolean | null;
  /** Whether the listener still accepted connections after the sign-in (must be false). */
  openAfter: boolean;
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(1000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

function lanAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return undefined;
}

/**
 * `gws-mcp accounts add …`: waits for the printed one-time start link and plays the browser. It opens the link (taking
 * the flow cookie and the redirect to Google), checks that a second visit is refused, consents at the fake as `email`,
 * then sends the callback without the cookie and with a forged state (both refused), probes the listener from a LAN
 * address, and finally follows the real redirect with the cookie.
 */
export function addAccount(configDir: string, fake: FakeControl, email: string, args: string[]): Promise<AddOutcome> {
  const argv = ["accounts", "add", ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], { env: cliEnv(configDir), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let started = false;
    let browser: Promise<Omit<AddOutcome, keyof CliRun | "openAfter">> | undefined;
    child.stdin.end();
    child.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      out += c;
      const m = /^ {2}(http:\/\/\S+\/start\?t=\S+)$/m.exec(out);
      if (m?.[1] === undefined || started) return;
      started = true;
      const startUrl = m[1];
      browser = (async () => {
        const start = await fetch(startUrl, { redirect: "manual" });
        const cookie = (start.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
        const authUrl = start.headers.get("location") ?? "";
        const startAgainStatus = (await fetch(startUrl, { redirect: "manual" })).status;
        const redirect = await fake.consent(authUrl, email);
        const port = Number(redirect.port);
        const noCookieStatus = (await fetch(redirect)).status;
        const forged = new URL(redirect);
        forged.searchParams.set("state", "f".repeat(43));
        const forgedStatus = (await fetch(forged, { headers: { cookie } })).status;
        const lan = lanAddress();
        const reachableFromLan = lan === undefined ? null : await connects(lan, port);
        const callbackStatus = (await fetch(redirect, { headers: { cookie } })).status;
        return { startUrl, authUrl, redirect, startAgainStatus, noCookieStatus, forgedStatus, callbackStatus, reachableFromLan };
      })();
      browser.catch(() => child.kill());
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (browser === undefined) return reject(new Error(`accounts add ended (${code}) before printing a sign-in link: ${err.trim()}`));
      browser.then(
        async (b) => resolve({ ...b, code: code ?? -1, out, err, argv, openAfter: await connects("127.0.0.1", Number(b.redirect.port)) }),
        reject,
      );
    });
  });
}

/** An MCP client of `gws-mcp serve`, over stdio. */
export async function openServe(configDir: string): Promise<{ client: Client; stderr: () => string; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "serve"], env: cliEnv(configDir), stderr: "pipe" });
  let err = "";
  transport.stderr?.on("data", (c: Buffer) => (err += c.toString()));
  const client = new Client({ name: "gws-mcp-e2e-local", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr: () => err, close: () => client.close() };
}
