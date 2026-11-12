// Which gws-mcp the harness may drive, and where its secrets and D1 come from. The harness needs fake mode, so it
// runs only against a loopback `npm run dev:e2e` or the deployed fake-mode E2E Worker named in the operator's
// untracked wrangler.e2e.jsonc; the production Worker runs real Google and is refused before anything is sent.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONFIGS, configVar, readWranglerConfig } from "../wrangler";
import { dockerContainer, type D1Mode } from "./d1-scan";

/** The deployed fake-mode E2E Worker and the deployed fake Google it is bound to. */
export interface DeployedE2E {
  /** The E2E Worker's origin: `vars.PUBLIC_BASE_URL` of the local wrangler.e2e.jsonc. */
  origin: string;
  /** The fake's origin: `vars.FAKE_GOOGLE_PUBLIC_URL` of the same config. */
  fake: string;
}

/** A URL's origin (lowercased host, no default port), or the text itself when it is not a URL. */
function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

/** The Worker name in a local config under `root`, if that config exists and names one. */
function localWorkerName(root: string, kind: keyof typeof CONFIGS): string | undefined {
  const file = path.join(root, CONFIGS[kind].local);
  if (!existsSync(file)) return undefined;
  const name = readWranglerConfig(file).name;
  return typeof name === "string" ? name : undefined;
}

/**
 * Why the E2E config must not be driven, or null. It must run fake mode with FAKE_GOOGLE bound to the fake Google
 * Worker, and must not name the production Worker (its name, or its PUBLIC_BASE_URL when production sets one): a
 * copy mistake would otherwise send the harness's clients and traffic to the real-Google Worker.
 */
function e2eConfigRefusal(root: string, config: Record<string, unknown>, base: string): string | null {
  const fakeWorker = localWorkerName(root, "fake") ?? "gws-mcp-fake-google";
  const services = Array.isArray(config.services) ? (config.services as unknown[]) : [];
  const bindsFake = services.some((s) => {
    const rec = typeof s === "object" && s !== null ? (s as Record<string, unknown>) : {};
    return rec.binding === "FAKE_GOOGLE" && rec.service === fakeWorker;
  });
  if (configVar(config, "GOOGLE_UPSTREAM") !== "fake" || !bindsFake) {
    return `is not a fake-mode E2E config (GOOGLE_UPSTREAM must be "fake" and FAKE_GOOGLE must bind ${fakeWorker})`;
  }
  const mainFile = path.join(root, CONFIGS.main.local);
  if (existsSync(mainFile)) {
    const main = readWranglerConfig(mainFile);
    const mainBase = configVar(main, "PUBLIC_BASE_URL");
    if (main.name === config.name || (mainBase !== undefined && originOf(mainBase) === originOf(base))) {
      return `names the production Worker (its name or its PUBLIC_BASE_URL, from ${CONFIGS.main.local})`;
    }
  }
  return null;
}

/**
 * The deployed E2E target from the operator's local wrangler.e2e.jsonc, or null when that file or its
 * `PUBLIC_BASE_URL` is absent. Never from the tracked example, whose hosts are placeholders. The config must be a
 * fake-mode E2E config that does not name production (`e2eConfigRefusal`), and both origins must be https
 * (`targetOrigin`), else this throws.
 */
export function readDeployedE2E(root: string): DeployedE2E | null {
  const file = path.join(root, CONFIGS.e2e.local);
  if (!existsSync(file)) return null;
  const config = readWranglerConfig(file);
  const base = configVar(config, "PUBLIC_BASE_URL");
  if (base === undefined) return null;
  const refusal = e2eConfigRefusal(root, config, base);
  if (refusal) throw new Error(`${CONFIGS.e2e.local} ${refusal}; nothing was sent`);
  const fake = configVar(config, "FAKE_GOOGLE_PUBLIC_URL");
  if (fake === undefined) throw new Error(`${CONFIGS.e2e.local} sets PUBLIC_BASE_URL but not FAKE_GOOGLE_PUBLIC_URL; nothing was sent`);
  const deployed = { origin: targetOrigin(`${CONFIGS.e2e.local} PUBLIC_BASE_URL`, base), fake: targetOrigin(`${CONFIGS.e2e.local} FAKE_GOOGLE_PUBLIC_URL`, fake) };
  if (isLoopback(deployed.origin) || isLoopback(deployed.fake)) throw new Error(`${CONFIGS.e2e.local} must name deployed (non-loopback) origins; nothing was sent`);
  return deployed;
}

/** Fake secrets every run reads; the token key's name depends on the target. */
const FAKE_SECRET_NAMES = ["FAKE_ADMIN_TOKEN", "FAKE_LOGIN_SECRET", "FAKE_SIGNING_KEY"] as const;

export interface RunTarget {
  /** The fake Google origin the run may send the fake admin token and picker login secret to. */
  fake: string;
  /** Local state of `npm run dev:e2e`, the deployed `gws-mcp-e2e` database, or the SQLite file of a `gws-mcp-e2e-*` Docker container. */
  d1: D1Mode;
  /** Dotenv files read by path, in order (first non-empty value of a key wins). */
  envFiles: string[];
  /** The env key holding the target's TOKEN_ENC_KEY: never the production key for the deployed E2E Worker. */
  tokenKeyName: "TOKEN_ENC_KEY" | "E2E_TOKEN_ENC_KEY";
}

export function isLoopback(url: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
}

/**
 * The origin of a target URL. The run sends secrets there (the fake admin token, the picker login secret,
 * MCP bearer tokens and session cookies), so plain http is refused unless the host is loopback.
 */
export function targetOrigin(flag: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${flag} is not a URL`);
  }
  const plainLoopback = url.protocol === "http:" && isLoopback(url.href);
  if (url.protocol !== "https:" && !plainLoopback) {
    throw new Error(`${flag} must be https (plain http only for localhost, 127.0.0.1 or [::1]); nothing was sent`);
  }
  return url.origin;
}

/**
 * Resolves `--base` and `--fake` origins (from `targetOrigin`) to the target's fake, D1, env files and token key
 * name. The fake receives the fake admin token and the picker login secret, so it is pinned to the target's own.
 * - loopback: a loopback fake only; local D1 of `npm run dev:e2e`, `.dev.vars` + `fake-google/.dev.vars`,
 *   `TOKEN_ENC_KEY` (the local dev key); `--remote-d1` is refused, a local server never uses the deployed database.
 * - a Docker container (`docker`, a `gws-mcp-e2e-*` name; the Node host's image run by scripts/e2e/docker.sh): the same
 *   loopback rules, the database is that container's SQLite file, and the env files must be named (`--env-file`; the
 *   dev files of the Worker are never a default there).
 * - the deployed E2E Worker (`readDeployedE2E`, from the local wrangler.e2e.jsonc): exactly the deployed fake it is
 *   bound to; database `gws-mcp-e2e` remote, `.env`, `E2E_TOKEN_ENC_KEY`.
 * - anything else: refused.
 * `envFiles` (from `--env-file`) replaces the default files; the key name stays the target's.
 */
export function resolveTarget(
  base: string,
  opts: { fake: string; root: string; remoteD1: boolean; envFiles: readonly string[]; docker?: string },
): RunTarget {
  if (opts.docker !== undefined && !isLoopback(base)) throw new Error("--docker needs a loopback --base (the container's published port); nothing was sent");
  const deployed = isLoopback(base) ? null : readDeployedE2E(opts.root);
  const files = (defaults: string[]) => (opts.envFiles.length > 0 ? opts.envFiles.map((f) => path.resolve(f)) : defaults);
  if (isLoopback(base)) {
    if (opts.remoteD1) throw new Error("--remote-d1 needs the deployed E2E Worker as --base; a local server uses its local D1; nothing was sent");
    if (!isLoopback(opts.fake)) throw new Error("--fake must be a loopback fake for a loopback --base; nothing was sent");
    if (opts.docker !== undefined) {
      const d1: D1Mode = `docker:${opts.docker}`;
      dockerContainer(d1);
      if (opts.envFiles.length === 0) throw new Error("--docker needs --env-file (the throwaway secrets of the run); nothing was sent");
      return { fake: opts.fake, d1, envFiles: files([]), tokenKeyName: "TOKEN_ENC_KEY" };
    }
    return {
      fake: opts.fake,
      d1: "local",
      envFiles: files([path.join(opts.root, ".dev.vars"), path.join(opts.root, "fake-google", ".dev.vars")]),
      tokenKeyName: "TOKEN_ENC_KEY",
    };
  }
  if (deployed !== null && base === deployed.origin) {
    if (opts.fake !== deployed.fake) throw new Error(`--fake must be ${deployed.fake} for ${deployed.origin}; nothing was sent`);
    return { fake: opts.fake, d1: "remote", envFiles: files([path.join(opts.root, ".env")]), tokenKeyName: "E2E_TOKEN_ENC_KEY" };
  }
  const allowed = deployed === null ? `(no deployed E2E Worker: ${CONFIGS.e2e.local} sets no PUBLIC_BASE_URL)` : `or ${deployed.origin}`;
  throw new Error(`--base must be loopback ${allowed}: the harness needs the fake upstream (the production Worker runs real Google); nothing was sent`);
}

/** Reads `names` from dotenv files by path. Values are returned, never printed. */
export function readSecrets(files: readonly string[], names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      const [, key = "", raw = ""] = m ?? [];
      if (!names.includes(key) || key in out) continue;
      const value = raw.replace(/^(['"])(.*)\1$/, "$2");
      if (value !== "") out[key] = value;
    }
  }
  return out;
}

export interface RunSecrets {
  adminToken?: string;
  loginSecret?: string;
  /** The target's TOKEN_ENC_KEY value (read from `tokenKeyName`), for the moved-row decryption test. */
  tokenEncKey?: string;
  /** Every value read, for evidence redaction and output scans. */
  all: string[];
}

/** Reads the fake secrets and the target's token key; no other key (the production key above all) is read. */
export function loadRunSecrets(target: RunTarget): RunSecrets {
  const read = readSecrets(target.envFiles, [...FAKE_SECRET_NAMES, target.tokenKeyName]);
  return {
    ...(read.FAKE_ADMIN_TOKEN ? { adminToken: read.FAKE_ADMIN_TOKEN } : {}),
    ...(read.FAKE_LOGIN_SECRET ? { loginSecret: read.FAKE_LOGIN_SECRET } : {}),
    ...(read[target.tokenKeyName] ? { tokenEncKey: read[target.tokenKeyName] } : {}),
    all: Object.values(read),
  };
}
