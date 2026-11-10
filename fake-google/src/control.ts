import { z } from "zod";
import { EmailSchema, SeedRequestSchema } from "./fixtures";
import { TOKEN_PREFIX, accountKey, safeEqual, type FakeAccount } from "./oauth";
import type { SeedPresets } from "./routes/index";
import { RESERVED_NAMESPACES, fakeKey, parseKey, type FakeStore, type JsonValue } from "./store";

export type { SeedRequest } from "./fixtures";

export const ADMIN_HEADER = "x-fake-admin";

export interface RequestLogEntry {
  ts: number;
  method: string;
  /** Host-prefixed path. */
  path: string;
  /** Query parameters with credential-like values replaced by "[REDACTED]". */
  query: Record<string, string | string[]>;
}

export interface StateSnapshot {
  email: string;
  now?: number;
  account?: FakeAccount;
  /** Granted scopes per OAuth client id. */
  grants: Record<string, string[]>;
  /** Seeded or route-created resources of this account, by store key. */
  resources: Record<string, JsonValue>;
}

/** Largest server-generated fault padding: above the gws-mcp per-call cap, far below a Worker's 128 MB. */
export const MAX_PAD_BYTES = 8_000_000;

const FaultSchema = z.strictObject({
  /** Only requests whose bearer token belongs to this account; any request when omitted. */
  email: EmailSchema.optional(),
  method: z.union([z.literal("*"), z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])]),
  /** Matched against the host-prefixed path. */
  pathRegex: z
    .string()
    .min(1)
    .max(500)
    .refine((s) => {
      try {
        new RegExp(s);
        return true;
      } catch {
        return false;
      }
    }, "invalid regex"),
  times: z.number().int().min(1).max(1000),
  response: z
    .strictObject({
      status: z.number().int().min(200).max(599),
      headers: z.record(z.string(), z.string()).optional(),
      body: (z.json() as z.ZodType<JsonValue>).optional(),
      /**
       * Adds a `padding` field of this many "x" characters to the JSON object body when the fault fires, so a
       * large upstream response is produced server-side. Only the number is stored; capped to bound memory.
       */
      padBytes: z.number().int().min(1).max(MAX_PAD_BYTES).optional(),
    })
    .superRefine((r, ctx) => {
      if (r.padBytes === undefined || r.body === undefined) return;
      if (typeof r.body !== "object" || r.body === null || Array.isArray(r.body)) {
        ctx.addIssue({ code: "custom", path: ["body"], message: "padBytes needs a JSON object body (or none)" });
      } else if (Object.hasOwn(r.body, "padding")) {
        ctx.addIssue({ code: "custom", path: ["body", "padding"], message: "padBytes sets padding itself" });
      }
    }),
});
export type FaultSpec = z.input<typeof FaultSchema>;
type FaultRule = z.output<typeof FaultSchema> & { [key: string]: JsonValue };

const ResetSchema = z.strictObject({ email: EmailSchema.optional() });

const clockKey = (email: string) => fakeKey("clock", "now", email, "ms");
const logKey = (email: string, seq: string) => fakeKey("log", "req", email, seq);
const faultKey = (email: string, id: string) => fakeKey("fault", "rule", email, id);
/** Log/fault owner used when a request cannot be attributed to an account. */
export const NO_ACCOUNT = "_";

export function readClock(store: FakeStore, email: string): Promise<number | undefined> {
  return store.get<number>(clockKey(email));
}

const SENSITIVE_QUERY = /^(token|access_token|refresh_token|id_token|code|code_verifier|client_secret|key|assertion|password)$/i;

export function redactQuery(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, raw] of params) {
    const v = SENSITIVE_QUERY.test(k) ? "[REDACTED]" : raw;
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

let logSeq = 0;

export async function appendLog(store: FakeStore, email: string, entry: RequestLogEntry): Promise<void> {
  const seq = `${String(entry.ts).padStart(13, "0")}-${String(logSeq++).padStart(9, "0")}`;
  await store.put(logKey(email, seq), { ...entry });
}

/** Returns and consumes the first matching fault, if any. */
export async function takeFault(
  store: FakeStore,
  req: { method: string; path: string; email?: string },
): Promise<Response | undefined> {
  for (const [key, rule] of await store.list<FaultRule>("fault:rule:")) {
    if (rule.method !== "*" && rule.method !== req.method) continue;
    if (rule.email !== undefined && rule.email !== req.email) continue;
    if (!new RegExp(rule.pathRegex).test(req.path)) continue;
    if (rule.times <= 1) await store.delete(key);
    else await store.put(key, { ...rule, times: rule.times - 1 });
    const { status, headers = {}, body, padBytes } = rule.response;
    if (padBytes !== undefined) {
      const base = typeof body === "object" && body !== null && !Array.isArray(body) ? body : {};
      return Response.json({ ...base, padding: "x".repeat(padBytes) }, { status, headers });
    }
    if (body === undefined) return new Response(null, { status, headers });
    if (typeof body === "string") return new Response(body, { status, headers });
    return Response.json(body, { status, headers });
  }
  return undefined;
}

function belongsTo(key: string, value: JsonValue, email: string): boolean {
  if (key.startsWith(TOKEN_PREFIX)) {
    return typeof value === "object" && value !== null && !Array.isArray(value) && value.email === email;
  }
  return parseKey(key)?.email === email;
}

function fill(value: JsonValue, email: string): JsonValue {
  if (typeof value === "string") return value.replaceAll("{email}", email);
  if (Array.isArray(value)) return value.map((v) => fill(v, email));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, email)]));
  }
  return value;
}

const json = (body: JsonValue, status = 200) => Response.json(body, { status });

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await req.text();
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function badRequest(error: z.ZodError | string): Response {
  const message =
    typeof error === "string" ? error : error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
  return json({ error: "bad_request", message }, 400);
}

export interface ControlDeps {
  store: FakeStore;
  adminToken?: string;
  presets: SeedPresets;
}

/** `/__fake/*`: test control routes. Guarded by the admin header whenever an admin token is configured. */
export async function handleControl(req: Request, url: URL, deps: ControlDeps): Promise<Response> {
  const { store } = deps;
  if (deps.adminToken !== undefined && !safeEqual(req.headers.get(ADMIN_HEADER) ?? "", deps.adminToken)) {
    return json({ error: "unauthorized" }, 401);
  }
  const route = `${req.method} ${url.pathname}`;

  if (route === "POST /__fake/reset") {
    const body = await readJson(req);
    if (!body.ok) return badRequest("invalid JSON");
    const parsed = ResetSchema.safeParse(body.value);
    if (!parsed.success) return badRequest(parsed.error);
    const email = parsed.data.email;
    let deleted = 0;
    for (const [key, value] of await store.list("")) {
      if (email === undefined || belongsTo(key, value, email)) {
        await store.delete(key);
        deleted++;
      }
    }
    return json({ ok: true, deleted });
  }

  if (route === "POST /__fake/seed") {
    const body = await readJson(req);
    if (!body.ok) return badRequest("invalid JSON");
    const parsed = SeedRequestSchema.safeParse(body.value);
    if (!parsed.success) return badRequest(parsed.error);
    const seed = parsed.data;
    const writes: Array<[string, JsonValue]> = [];
    for (const a of seed.accounts) {
      writes.push([accountKey(a.email), { email: a.email, sub: a.sub }]);
      if (a.preset !== undefined) {
        const preset = deps.presets[a.preset];
        if (!preset) return badRequest(`unknown preset ${a.preset}`);
        for (const item of preset) {
          const key = item.key.replaceAll("{email}", a.email);
          const parts = parseKey(key);
          if (!parts || RESERVED_NAMESPACES.has(parts.svc)) return badRequest(`invalid preset key in ${a.preset}`);
          writes.push([key, fill(item.value, a.email)]);
        }
      }
      if (seed.now !== undefined) writes.push([clockKey(a.email), seed.now]);
    }
    for (const r of seed.resources ?? []) writes.push([r.key, r.value]);
    for (const [k, v] of writes) await store.put(k, v);
    return json({ ok: true, accounts: seed.accounts.map((a) => a.email) });
  }

  if (route === "POST /__fake/faults") {
    const body = await readJson(req);
    if (!body.ok) return badRequest("invalid JSON");
    const parsed = FaultSchema.safeParse(body.value);
    if (!parsed.success) return badRequest(parsed.error);
    const id = crypto.randomUUID();
    await store.put(faultKey(parsed.data.email ?? NO_ACCOUNT, id), parsed.data as FaultRule);
    return json({ ok: true, id });
  }

  if (route === "GET /__fake/requests" || route === "GET /__fake/state") {
    const email = EmailSchema.safeParse(url.searchParams.get("email") ?? "");
    if (!email.success) return badRequest("email query parameter required");
    if (route === "GET /__fake/requests") {
      const entries = await store.list<RequestLogEntry & { [key: string]: JsonValue }>(`log:req:${email.data}:`);
      return json({ requests: entries.map(([, e]) => e) });
    }
    return json(await snapshot(store, email.data));
  }

  return json({ error: "not_found" }, 404);
}

async function snapshot(store: FakeStore, email: string): Promise<StateSnapshot & { [key: string]: JsonValue }> {
  const out: StateSnapshot & { [key: string]: JsonValue } = { email, grants: {}, resources: {} };
  for (const [key, value] of await store.list("")) {
    const parts = parseKey(key);
    if (!parts || parts.email !== email) continue;
    if (parts.svc === "oauth" && parts.kind === "account") out.account = value as FakeAccount;
    else if (parts.svc === "oauth" && parts.kind === "grant") {
      out.grants[parts.id] = (value as { scopes: string[] }).scopes;
    } else if (parts.svc === "clock") out.now = value as number;
    else if (!RESERVED_NAMESPACES.has(parts.svc)) out.resources[key] = value;
  }
  return out;
}
