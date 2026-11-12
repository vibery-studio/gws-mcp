import { readFileSync, statSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import { loadConfig, type Config, type ConfigKey } from "../../config";
import { SECRET_NAMES, type SecretName } from "../../contracts";
import { isGwsError } from "../../errors";
import { importKey } from "../../store/crypto";

/**
 * The Node host's configuration, from the process environment plus an optional secrets file.
 *
 * - Worker vars: the same names and validation as the Worker's vars (src/config.ts). PUBLIC_BASE_URL is required:
 *   every request URL is built from it, never from the client's Host header.
 * - Secrets: TOKEN_ENC_KEY always (base64 of 32 bytes); GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET when the upstream
 *   is Google (fake mode uses the fake's fixed client, as on Workers). Each comes from the environment or from the
 *   file named by GWS_SECRETS_FILE, never both. The file must be a regular file nobody but its owner can read or
 *   write.
 * - Host settings: the GWS_* names below.
 *
 * Errors name keys only, never values.
 */

export class NodeHostConfigError extends Error {
  override readonly name = "NodeHostConfigError";
}

/** Every Worker var the host passes through. The type check below fails when src/config.ts gains a key. */
const WORKER_VARS = [
  "GOOGLE_UPSTREAM",
  "PUBLIC_BASE_URL",
  "FAKE_GOOGLE_PUBLIC_URL",
  "GOOGLE_SCOPE_PRESET",
  "LOGIN_ACCOUNTS",
  "CALLS_PER_EXECUTE",
  "CALL_RESPONSE_MAX_BYTES",
  "RESULT_MAX_BYTES",
  "RATE_USER_PER_MIN",
  "RATE_CLIENT_PER_MIN",
  "SEARCH_MAX_BYTES",
  "EXECUTE_TIMEOUT_MS",
  "EXECUTE_RESPONSE_MAX_BYTES",
  "UPSTREAM_CONCURRENCY",
  "CALL_INPUT_MAX_BYTES",
  "GWS_HUMAN_APPROVAL",
] as const satisfies readonly ConfigKey[];
type MissingWorkerVar = Exclude<ConfigKey, (typeof WORKER_VARS)[number]>;
const allWorkerVars: [MissingWorkerVar] extends [never] ? true : MissingWorkerVar = true;
void allWorkerVars;

/** The forwarding headers a trusted proxy may set for the client address. */
export const CLIENT_IP_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"] as const;
export type ClientIpHeader = (typeof CLIENT_IP_HEADERS)[number];

/** The secrets file is small; anything larger is not one. */
const MAX_SECRETS_FILE_BYTES = 64 * 1024;

const int = (def: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(def);

const HostSchema = z.object({
  GWS_HOST: z.string().min(1).default("127.0.0.1"),
  GWS_PORT: int(8787, 0, 65_535),
  GWS_DB_FILE: z.string().min(1),
  GWS_SECRETS_FILE: z.string().min(1).optional(),
  GWS_TRUSTED_PROXIES: z.string().optional(),
  GWS_CLIENT_IP_HEADER: z.enum(CLIENT_IP_HEADERS).default("x-forwarded-for"),
  GWS_MAX_BODY_BYTES: int(1024 * 1024, 1024, 32 * 1024 * 1024),
  GWS_SHUTDOWN_TIMEOUT_MS: int(25_000, 1000, 300_000),
  GWS_SANDBOX_CONCURRENCY: int(4, 1, 32),
  GWS_FAKE_GOOGLE_URL: z.url({ protocol: /^https?$/ }).optional(),
});
type HostKey = keyof z.input<typeof HostSchema>;
const HOST_KEYS = Object.keys(HostSchema.shape) as HostKey[];

export interface TrustedProxies {
  /** The configured entries, as written (addresses and CIDR ranges; not secret). */
  entries: readonly string[];
  /** True when `address` (a socket's peer address) is one of them. */
  has(address: string): boolean;
}

export interface NodeHostConfig {
  listenHost: string;
  port: number;
  dbFile: string;
  /** The validated Worker config (PUBLIC_BASE_URL included). */
  worker: Config;
  /** The Worker vars as given, for the env the Worker entry reads. */
  vars: Record<string, string>;
  /** The secrets present, for the env only. Never logged. */
  secrets: Partial<Record<SecretName, string>>;
  /** Where each present secret came from. */
  secretSources: Partial<Record<SecretName, "env" | "file">>;
  trustedProxies: TrustedProxies | null;
  clientIpHeader: ClientIpHeader;
  /** Whether GWS_CLIENT_IP_HEADER was given (else its default applies). */
  clientIpHeaderSet: boolean;
  maxBodyBytes: number;
  shutdownTimeoutMs: number;
  sandboxConcurrency: number;
  /** Fake mode only: where the host's own calls reach the fake (the FAKE_GOOGLE binding on Workers). */
  fakeGoogleUrl: string | undefined;
}

type Environment = Readonly<Record<string, string | undefined>>;

function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/** An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) as its IPv4 address; any other text unchanged. */
export function plainAddress(address: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return m?.[1] ?? address;
}

/** GWS_TRUSTED_PROXIES: comma-separated IP addresses and CIDR ranges (`10.0.0.0/8`, `fd00::/8`). */
export function parseTrustedProxies(text: string): TrustedProxies {
  const list = new BlockList();
  const entries = text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (entries.length === 0) throw new NodeHostConfigError("invalid config: GWS_TRUSTED_PROXIES (no address)");
  for (const entry of entries) {
    const [address = "", prefix, extra] = entry.split("/");
    const family = isIP(address);
    const bits = prefix === undefined ? undefined : Number(prefix);
    const maxBits = family === 4 ? 32 : 128;
    if (family === 0 || extra !== undefined || (bits !== undefined && (!/^\d{1,3}$/.test(prefix ?? "") || bits > maxBits))) {
      throw new NodeHostConfigError(`invalid config: GWS_TRUSTED_PROXIES (${JSON.stringify(entry)} is not an IP address or CIDR range)`);
    }
    const type = family === 4 ? "ipv4" : "ipv6";
    if (bits === undefined) list.addAddress(address, type);
    else list.addSubnet(address, bits, type);
  }
  return {
    entries,
    has(peer: string): boolean {
      const address = plainAddress(peer);
      const family = isIP(address);
      return family !== 0 && list.check(address, family === 4 ? "ipv4" : "ipv6");
    },
  };
}

/** The secrets file's NAME=value lines (`#` comments and blank lines allowed; one pair of quotes stripped). */
export function readSecretsFile(file: string): Partial<Record<SecretName, string>> {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    throw new NodeHostConfigError("GWS_SECRETS_FILE does not name a readable file");
  }
  if (!stat.isFile()) throw new NodeHostConfigError("GWS_SECRETS_FILE is not a regular file");
  if ((stat.mode & 0o077) !== 0) {
    throw new NodeHostConfigError(
      `GWS_SECRETS_FILE is open to group or others (mode ${(stat.mode & 0o777).toString(8)}); make it owner-only (chmod 600)`,
    );
  }
  if (stat.size > MAX_SECRETS_FILE_BYTES) throw new NodeHostConfigError("GWS_SECRETS_FILE is too large to be a secrets file");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new NodeHostConfigError("GWS_SECRETS_FILE could not be read");
  }
  const names: ReadonlySet<string> = new Set(SECRET_NAMES);
  const out: Partial<Record<SecretName, string>> = {};
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    const name = eq < 0 ? "" : line.slice(0, eq).trim();
    // A line that is not NAME=value may be a pasted secret: only its line number is reported.
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new NodeHostConfigError(`GWS_SECRETS_FILE line ${i + 1} is not NAME=value`);
    if (!names.has(name)) throw new NodeHostConfigError(`GWS_SECRETS_FILE line ${i + 1}: unknown secret ${name} (known: ${SECRET_NAMES.join(", ")})`);
    if (name in out) throw new NodeHostConfigError(`GWS_SECRETS_FILE sets ${name} twice`);
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1);
    if (value === "") throw new NodeHostConfigError(`GWS_SECRETS_FILE sets ${name} to an empty value`);
    out[name as SecretName] = value;
  });
  return out;
}

function parseHost(env: Environment): z.output<typeof HostSchema> {
  const raw: Record<string, unknown> = {};
  for (const key of HOST_KEYS) if (present(env[key])) raw[key] = env[key];
  const parsed = HostSchema.safeParse(raw);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "?")))].sort();
    throw new NodeHostConfigError(`invalid config: ${keys.join(", ")}`);
  }
  return parsed.data;
}

function parseWorker(env: Environment): { worker: Config; vars: Record<string, string> } {
  const vars: Record<string, string> = {};
  for (const key of WORKER_VARS) {
    const value = env[key];
    if (present(value)) vars[key] = value;
  }
  if (vars.PUBLIC_BASE_URL === undefined) throw new NodeHostConfigError("missing config: PUBLIC_BASE_URL (the public https origin, e.g. https://gws.example.com)");
  if (vars.GOOGLE_UPSTREAM === undefined) throw new NodeHostConfigError("missing config: GOOGLE_UPSTREAM (google, or fake for tests)");
  try {
    return { worker: loadConfig(vars), vars };
  } catch (e) {
    if (isGwsError(e)) throw new NodeHostConfigError(e.message);
    throw e;
  }
}

type Secrets = { secrets: Partial<Record<SecretName, string>>; secretSources: Partial<Record<SecretName, "env" | "file">> };

/** The secrets from the environment or GWS_SECRETS_FILE (never both); the ones the upstream needs are required. */
async function loadSecrets(env: Environment, host: z.output<typeof HostSchema>, worker: Config): Promise<Secrets> {
  const fromFile = host.GWS_SECRETS_FILE === undefined ? {} : readSecretsFile(path.resolve(host.GWS_SECRETS_FILE));
  const secrets: Partial<Record<SecretName, string>> = {};
  const secretSources: Partial<Record<SecretName, "env" | "file">> = {};
  for (const name of SECRET_NAMES) {
    const inEnv = env[name];
    const inFile = fromFile[name];
    if (present(inEnv) && inFile !== undefined) throw new NodeHostConfigError(`${name} is set both in the environment and in GWS_SECRETS_FILE; keep one`);
    if (present(inEnv)) {
      secrets[name] = inEnv;
      secretSources[name] = "env";
    } else if (inFile !== undefined) {
      secrets[name] = inFile;
      secretSources[name] = "file";
    }
  }
  const required: SecretName[] = worker.GOOGLE_UPSTREAM === "google" ? ["TOKEN_ENC_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] : ["TOKEN_ENC_KEY"];
  const missing = required.filter((name) => secrets[name] === undefined);
  if (missing.length > 0) throw new NodeHostConfigError(`missing secret: ${missing.join(", ")} (set in the environment or GWS_SECRETS_FILE)`);
  try {
    await importKey(secrets);
  } catch (e) {
    if (isGwsError(e)) throw new NodeHostConfigError(e.message);
    throw e;
  }
  return { secrets, secretSources };
}

/**
 * Loads and checks the whole configuration; throws NodeHostConfigError naming the first problem's keys. With
 * `secrets: false` (the access command, which uses none) no secret is read or required, and the result holds none.
 */
export async function loadNodeHostConfig(env: Environment, opts: { secrets?: boolean } = {}): Promise<NodeHostConfig> {
  const host = parseHost(env);
  const { worker, vars } = parseWorker(env);
  const { secrets, secretSources }: Secrets = opts.secrets === false ? { secrets: {}, secretSources: {} } : await loadSecrets(env, host, worker);

  if (worker.GOOGLE_UPSTREAM !== "fake" && host.GWS_FAKE_GOOGLE_URL !== undefined) {
    throw new NodeHostConfigError("invalid config: GWS_FAKE_GOOGLE_URL (only for GOOGLE_UPSTREAM=fake)");
  }
  const fakeGoogleUrl = worker.GOOGLE_UPSTREAM === "fake" ? new URL(host.GWS_FAKE_GOOGLE_URL ?? worker.FAKE_GOOGLE_PUBLIC_URL ?? "").origin : undefined;

  return {
    listenHost: host.GWS_HOST,
    port: host.GWS_PORT,
    dbFile: path.resolve(host.GWS_DB_FILE),
    worker,
    vars,
    secrets,
    secretSources,
    trustedProxies: present(host.GWS_TRUSTED_PROXIES) ? parseTrustedProxies(host.GWS_TRUSTED_PROXIES) : null,
    clientIpHeader: host.GWS_CLIENT_IP_HEADER,
    clientIpHeaderSet: present(env.GWS_CLIENT_IP_HEADER),
    maxBodyBytes: host.GWS_MAX_BODY_BYTES,
    shutdownTimeoutMs: host.GWS_SHUTDOWN_TIMEOUT_MS,
    sandboxConcurrency: host.GWS_SANDBOX_CONCURRENCY,
    fakeGoogleUrl,
  };
}

/** What the host logs about its configuration at boot: no secret value, only where each secret came from. */
export function configSummary(c: NodeHostConfig): Record<string, unknown> {
  return {
    publicBaseUrl: c.worker.PUBLIC_BASE_URL,
    listen: `${c.listenHost}:${c.port}`,
    dbFile: c.dbFile,
    upstream: c.worker.GOOGLE_UPSTREAM,
    scopePreset: c.worker.GOOGLE_SCOPE_PRESET,
    secrets: c.secretSources,
    trustedProxies: c.trustedProxies?.entries ?? [],
    clientIpHeader: c.trustedProxies === null ? null : c.clientIpHeader,
    maxBodyBytes: c.maxBodyBytes,
    sandboxConcurrency: c.sandboxConcurrency,
    ...(c.fakeGoogleUrl === undefined ? {} : { fakeGoogleUrl: c.fakeGoogleUrl }),
  };
}

/**
 * Proxy-trust settings worth a boot warning: both are safe (nothing can be spoofed) but easy to get wrong behind a
 * reverse proxy. The trusted header must be one the proxy overwrites with the client address (Caddy:
 * `header_up X-Real-IP {remote_host}`); X-Forwarded-For is read right to left, so only the hop the proxy appended
 * counts.
 */
export function startupWarnings(c: NodeHostConfig): string[] {
  if (c.trustedProxies === null) {
    return [
      "GWS_TRUSTED_PROXIES is not set: if this server runs behind a reverse proxy, every client shares the proxy's address for the per-address rate limits (one client can use them up for all); set it to the proxy's address",
    ];
  }
  if (!c.clientIpHeaderSet) {
    return [
      `GWS_CLIENT_IP_HEADER is not set, so the client address is read from ${c.clientIpHeader}; set it to the header your proxy overwrites with the client address (e.g. x-real-ip with Caddy header_up X-Real-IP {remote_host})`,
    ];
  }
  return [];
}

/** Removes the secrets from the process environment once read, so no child process or thread inherits them. */
export function scrubSecretsFromEnv(env: Record<string, string | undefined>): void {
  for (const name of SECRET_NAMES) delete env[name];
}
