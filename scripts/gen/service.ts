import type { GoogleService } from "../../src/config";
import type { MethodMeta } from "../../src/contracts";
import type { DiscoveryMethod, DiscoveryParam, DiscoveryResource, DiscoveryDoc, Unsupported } from "./types";
import {
  UnsupportedShape,
  byteOrder,
  lit,
  propKey,
  refsOf,
  schemaAccess,
  tsDeclaration,
  tsType,
  zodParam,
  zodSchema,
} from "./zod-emit";

/** POST methods that only read: they take a query in the request body. src/core/registry.ts mirrors this list. */
export const POST_READS: ReadonlySet<string> = new Set([
  "analyticsadmin.accounts.runAccessReport",
  "analyticsadmin.properties.runAccessReport",
  "analyticsdata.properties.batchRunPivotReports",
  "analyticsdata.properties.batchRunReports",
  "analyticsdata.properties.checkCompatibility",
  "analyticsdata.properties.runPivotReport",
  "analyticsdata.properties.runRealtimeReport",
  "analyticsdata.properties.runReport",
  "calendar.freebusy.query",
  "googleads.customers.googleAds.search",
  "googleads.customers.googleAds.searchStream",
  "searchconsole.urlInspection.index.inspect",
  "sheets.spreadsheets.getByDataFilter",
  "sheets.spreadsheets.developerMetadata.search",
  "sheets.spreadsheets.values.batchGetByDataFilter",
  "tagmanager.accounts.containers.workspaces.folders.entities",
  "webmasters.searchanalytics.query",
]);

/**
 * Methods whose runtime answer is a JSON array of the documented response, although Discovery types one response.
 * Google Ads streams batches of rows, so `searchStream` answers `[batch, batch, ...]`.
 */
const ARRAY_RESPONSE_IDS: ReadonlySet<string> = new Set(["googleads.customers.googleAds.searchStream"]);

/** Which methods of a Discovery document are generated; everything else is omitted and named in UNSUPPORTED's header. */
export interface MethodAllowlist {
  /** Method ids that start with one of these. */
  readonly idPrefixes?: readonly string[];
  /** Method ids that are exactly one of these. */
  readonly ids?: readonly string[];
  /** Method ids that end with one of these. */
  readonly idSuffixes?: readonly string[];
}

export interface ApiSpec {
  /** The SDK service the api's functions belong to. */
  readonly service: GoogleService;
  readonly allow?: MethodAllowlist;
}

/**
 * Every Discovery document the SDK is generated from, in output order. The key is the pin and file stem
 * (`discovery/<api>.<version>.json`); several apis can serve one service. Without `allow`, every method is considered.
 */
export const GENERATED_APIS = {
  gmail: { service: "gmail" },
  drive: { service: "drive" },
  calendar: { service: "calendar" },
  sheets: { service: "sheets" },
  docs: { service: "docs" },
  forms: { service: "forms" },
  tasks: { service: "tasks" },
  slides: { service: "slides" },
  searchconsole: { service: "searchconsole" },
  analyticsdata: { service: "analytics" },
  analyticsadmin: { service: "analyticsadmin" },
  admin: { service: "groups", allow: { idPrefixes: ["directory.groups.", "directory.members."] } },
  groupssettings: { service: "groups" },
  tagmanager: { service: "tagmanager" },
  googleads: {
    service: "ads",
    allow: {
      ids: ["googleads.customers.listAccessibleCustomers", "googleads.customers.googleAds.search", "googleads.customers.googleAds.searchStream"],
      idSuffixes: [".mutate"],
    },
  },
} as const satisfies Record<string, ApiSpec>;
export type ApiName = keyof typeof GENERATED_APIS;
export const API_NAMES = Object.keys(GENERATED_APIS) as ApiName[];

const allowed = (id: string, allow: MethodAllowlist | undefined): boolean =>
  allow === undefined ||
  (allow.ids ?? []).includes(id) ||
  (allow.idPrefixes ?? []).some((p) => id.startsWith(p)) ||
  (allow.idSuffixes ?? []).some((p) => id.endsWith(p));

/**
 * Push-notification plumbing that needs a public receiver. `*.watch` and `*.channels.stop` are matched by id suffix,
 * and every method of a `watches` resource (for example Forms' create/list/renew/delete) by id segment.
 */
const PUSH_ONLY: ReadonlySet<string> = new Set(["gmail.users.stop"]);
const isPushChannel = (id: string): boolean =>
  id.endsWith(".watch") || id.endsWith(".channels.stop") || id.includes(".watches.") || PUSH_ONLY.has(id);

/**
 * Discovery globals exposed on every method. Only `fields` (the partial-response selector): `key`, `access_token`,
 * `oauth_token`, `uploadType`, `upload_protocol`, `callback`, `$.xgafv` and `prettyPrint` are transport-owned,
 * `alt` is added only to downloadable methods, and `quotaUser`/`userIp` are not needed.
 */
const GLOBAL_QUERY_PARAMS = ["fields"] as const;

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const SIGNATURE_ENUM_LIMIT = 6;
const DESCRIPTION_LIMIT = 300;

const MEDIA_OUT_ZOD = "z.object({ dataBase64: z.string(), mimeType: z.string(), sizeBytes: z.number().int() })";
const MEDIA_OUT_TS = "MediaContent";
const MEDIA_OUT_DECL = "interface MediaContent {\n  dataBase64: string;\n  mimeType: string;\n  sizeBytes: number;\n}";
const MEDIA_IN_ZOD =
  "z.union([z.strictObject({ dataBase64: z.string(), mimeType: z.string() }), z.strictObject({ mimeType: z.string(), text: z.string() })]).optional()";
const MEDIA_IN_TS = "{ mimeType: string; dataBase64: string } | { mimeType: string; text: string }";

export interface GenMethod {
  id: string;
  service: GoogleService;
  meta: MethodMeta;
  description: string;
  signature: string;
  example: string;
  tags: string[];
  scopes: string[];
  inputExpr: string;
  outputExpr: string;
  /** `type Input = ...; type Output = ...;` plus inline helper types. */
  tsHead: string;
  /** Named schemas the full declaration expands. */
  refs: string[];
}

export interface EmittedSchema {
  expr: string;
  ts: string;
  deps: string[];
}

export interface EmittedService {
  /** The pin and module name; equals `service` unless several documents serve one service. */
  api: string;
  service: GoogleService;
  version: string;
  revision: string;
  methods: GenMethod[];
  unsupported: Unsupported[];
  total: number;
  /** Only schemas reachable from supported methods, in byte order. */
  schemas: Map<string, EmittedSchema>;
  /** Supported methods whose message-only media upload variant was dropped in favour of the JSON body. */
  droppedUploads: string[];
}

function collectMethods(res: DiscoveryResource, into: DiscoveryMethod[] = []): DiscoveryMethod[] {
  for (const m of Object.values(res.methods ?? {})) into.push(m);
  for (const child of Object.values(res.resources ?? {})) collectMethods(child, into);
  return into;
}

const words = (id: string): string[] =>
  id
    .split(".")
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" "))
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);

function exampleValue(name: string, p: DiscoveryParam): string {
  if (p.repeated === true) return "[]";
  if (p.type === "boolean") return "false";
  if (p.type === "integer" || p.type === "number") return p.format === "int64" || p.format === "uint64" ? `"0"` : "0";
  if (p.enum !== undefined && p.enum.length > 0) return lit(p.enum[0]!);
  return `"<${name}>"`;
}

/**
 * A Discovery path pattern the host can enforce: anchored, and made only of literal segments and one-segment
 * wildcards (`^accounts/[^/]+/containers/[^/]+$`). Such a pattern fixes how many segments a value has and what
 * each literal is, and matches in linear time. Anything looser (`^.*$`) would not stop a value naming another
 * resource, so the method is not generated.
 */
const SEGMENT = String.raw`(?:[A-Za-z0-9_-]+|\[\^/\]\+)`;
const ENFORCEABLE_PATTERN = new RegExp(String.raw`^\^${SEGMENT}(?:/${SEGMENT})*\$$`);

/** The pattern kept for one path parameter. A reserved (`{+name}`) parameter must have an enforceable one. */
function pathPattern(name: string, p: DiscoveryParam, reserved: boolean): string | undefined {
  if (p.pattern === undefined) {
    if (reserved) throw new UnsupportedShape(`reserved path parameter ${name} has no pattern`);
    return undefined;
  }
  if (!ENFORCEABLE_PATTERN.test(p.pattern)) throw new UnsupportedShape(`path parameter ${name}: pattern ${p.pattern} is not a fixed segment pattern`);
  return p.pattern;
}

interface FieldInfo {
  name: string;
  required: boolean;
  zod: string;
  ts: string;
  sigTs: string;
  example?: string;
}

function emitMethod(
  service: GoogleService,
  doc: DiscoveryDoc,
  m: DiscoveryMethod,
  schemas: ReadonlyMap<string, EmittedSchema>,
  badSchemas: ReadonlyMap<string, string>,
): { method: GenMethod; dropped: boolean } {
  const id = m.id;
  if (isPushChannel(m.id)) {
    throw new UnsupportedShape("push notification channel; needs a public receiver");
  }
  if (!HTTP_METHODS.has(m.httpMethod)) throw new UnsupportedShape(`http method ${m.httpMethod}`);

  // Media upload: only the simple/multipart protocol is supported; message uploads keep their JSON-body variant.
  let mediaUpload: MethodMeta["mediaUpload"];
  let dropped = false;
  if (m.supportsMediaUpload === true) {
    const upload = m.mediaUpload;
    const simple = upload?.protocols?.simple;
    if (upload === undefined || simple === undefined) {
      throw new UnsupportedShape("resumable-only media upload");
    }
    if (simple.multipart !== true) throw new UnsupportedShape("simple media upload without multipart");
    if (upload.accept.every((a) => a.startsWith("message/"))) {
      dropped = true;
    } else {
      mediaUpload = {
        multipartPath: simple.path,
        simplePath: simple.path,
        accept: [...upload.accept].sort(byteOrder),
        maxBytes: Number(upload.maxSize ?? 0),
      };
    }
  }

  const params = m.parameters ?? {};
  const fields: FieldInfo[] = [];
  const queryParams: MethodMeta["queryParams"] = [];
  for (const [name, p] of Object.entries(params)) {
    if (p.location !== "path" && p.location !== "query") {
      throw new UnsupportedShape(`parameter ${name}: location ${p.location}`);
    }
    if (name === "requestBody" || name === "media" || name === "account") {
      throw new UnsupportedShape(`parameter name ${name} collides with a reserved input key`);
    }
    const required = p.location === "path" || p.required === true;
    fields.push({
      name,
      required,
      zod: zodParam(name, p.location === "path" ? { ...p, required: true } : p),
      ts: tsType(p),
      sigTs: tsType(p, { enumLimit: SIGNATURE_ENUM_LIMIT }),
      ...(required ? { example: exampleValue(name, p) } : {}),
    });
    // repeated params are wrapped in array types
    const last = fields[fields.length - 1]!;
    if (p.repeated === true) {
      last.ts = `${last.ts.includes(" | ") ? `(${last.ts})` : last.ts}[]`;
      last.sigTs = `${last.sigTs.includes(" | ") ? `(${last.sigTs})` : last.sigTs}[]`;
    }
    if (p.location === "query") queryParams.push({ name, repeated: p.repeated === true });
  }

  for (const name of GLOBAL_QUERY_PARAMS) {
    const g = doc.parameters?.[name];
    if (g === undefined || params[name] !== undefined) continue;
    const optionalString =
      g.location === "query" && g.type === "string" && g.enum === undefined && g.repeated !== true && g.required !== true && g.default === undefined;
    if (!optionalString) {
      // Not an UnsupportedShape: a changed global would silently alter every method, so generation stops instead.
      throw new Error(`global parameter ${name} is no longer an optional string query parameter`);
    }
    fields.push({ name, required: false, zod: zodParam(name, g), ts: tsType(g), sigTs: tsType(g, { enumLimit: SIGNATURE_ENUM_LIMIT }) });
    queryParams.push({ name, repeated: false });
  }

  const pathParams: MethodMeta["pathParams"] = [];
  for (const match of m.path.matchAll(/\{(\+?)([^}]+)\}/g)) {
    const name = match[2]!;
    const param = params[name];
    if (param?.location !== "path") throw new UnsupportedShape(`path template variable ${name} has no path parameter`);
    const reserved = match[1] === "+";
    const pattern = pathPattern(name, param, reserved);
    pathParams.push({ name, reserved, ...(pattern !== undefined ? { pattern } : {}) });
  }
  // An upload template expands the same params, so each of its variables must be one of them with the same
  // expansion; a `{+x}` only there would send a value no pattern was checked for.
  if (mediaUpload !== undefined) {
    for (const match of mediaUpload.simplePath.matchAll(/\{(\+?)([^}]+)\}/g)) {
      const declared = pathParams.find((p) => p.name === match[2]);
      if (declared === undefined || declared.reserved !== (match[1] === "+")) {
        throw new UnsupportedShape(`upload path variable ${match[2]} does not match a path parameter of the method path`);
      }
    }
  }

  // Downloads: an `alt` switch for media, and a media output shape.
  const mediaDownload = m.supportsMediaDownload === true;
  const responseRef = m.response?.$ref;
  if (mediaDownload && responseRef !== undefined && params.alt === undefined) {
    fields.push({
      name: "alt",
      required: false,
      zod: 'z.enum(["json", "media"]).optional()',
      ts: '"json" | "media"',
      sigTs: '"json" | "media"',
    });
    queryParams.push({ name: "alt", repeated: false });
  }

  // Reachability and unsupported-schema check across request and response closures.
  const refs = new Set<string>();
  for (const root of [m.request?.$ref, responseRef]) {
    if (root !== undefined) closure(root, schemas, badSchemas, refs);
  }

  const sorted = [...fields].sort((a, b) =>
    a.required === b.required ? byteOrder(a.name, b.name) : a.required ? -1 : 1,
  );
  const entries = sorted.map((f) => ({ key: f.name, zod: f.zod, ts: f.ts, sig: f.sigTs, required: f.required }));
  if (m.request !== undefined) {
    entries.push({
      key: "requestBody",
      zod: `${schemaAccess(m.request.$ref)}().optional()`,
      ts: m.request.$ref,
      sig: m.request.$ref,
      required: false,
    });
  }
  if (mediaUpload !== undefined) {
    entries.push({ key: "media", zod: MEDIA_IN_ZOD, ts: MEDIA_IN_TS, sig: "{ mimeType: string, dataBase64 | text: string }", required: false });
  }
  entries.push({ key: "account", zod: "z.string().optional()", ts: "string", sig: "string", required: false });

  const inputExpr = `z.strictObject({ ${entries.map((e) => `${propKey(e.key)}: ${e.zod}`).join(", ")} })`;
  const inputTs = `{\n${entries.map((e) => `  ${propKey(e.key)}${e.required ? "" : "?"}: ${e.ts};`).join("\n")}\n}`;
  const sigInput = `{ ${entries.map((e) => `${e.key}${e.required ? "" : "?"}: ${e.sig}`).join(", ")} }`;

  let outputExpr: string;
  let outputTs: string;
  if (mediaDownload) {
    outputExpr = responseRef === undefined ? MEDIA_OUT_ZOD : `z.union([${MEDIA_OUT_ZOD}, ${schemaAccess(responseRef)}()])`;
    outputTs = responseRef === undefined ? MEDIA_OUT_TS : `${MEDIA_OUT_TS} | ${responseRef}`;
  } else if (responseRef !== undefined && ARRAY_RESPONSE_IDS.has(id)) {
    outputExpr = `z.union([${schemaAccess(responseRef)}(), z.array(${schemaAccess(responseRef)}())])`;
    outputTs = `${responseRef} | ${responseRef}[]`;
  } else if (responseRef !== undefined) {
    outputExpr = `${schemaAccess(responseRef)}()`;
    outputTs = responseRef;
  } else {
    outputExpr = "z.unknown()";
    outputTs = "unknown";
  }

  const effect = POST_READS.has(id) || m.httpMethod === "GET" ? "read" : "write";
  const meta: MethodMeta = {
    id,
    service,
    httpMethod: m.httpMethod as MethodMeta["httpMethod"],
    rootUrl: doc.rootUrl,
    servicePath: doc.servicePath,
    path: m.path,
    pathParams,
    queryParams: queryParams.sort((a, b) => byteOrder(a.name, b.name)),
    requestBody: m.request !== undefined,
    ...(mediaUpload !== undefined ? { mediaUpload } : {}),
    mediaDownload,
    scopes: [...(m.scopes ?? [])].sort(byteOrder),
    effect,
  };

  const required = sorted.filter((f) => f.required && f.example !== undefined);
  const example = `await sdk.${id}({ ${required.map((f) => `${f.name}: ${f.example}`).join(", ")} })`.replace("({  })", "({})");
  const tsHeadParts = [`type Input = ${inputTs};`, `type Output = ${outputTs};`];
  if (mediaDownload) tsHeadParts.push(MEDIA_OUT_DECL);

  const description = (m.description ?? "").replace(/\s+/g, " ").trim();
  const tags = [...new Set([...words(id), effect])];
  return {
    dropped,
    method: {
      id,
      service,
      meta,
      description: description.length > DESCRIPTION_LIMIT ? `${description.slice(0, DESCRIPTION_LIMIT - 3)}...` : description,
      signature: `${id}(${sigInput}): Promise<${outputTs}>`,
      example,
      tags,
      scopes: meta.scopes,
      inputExpr,
      outputExpr,
      tsHead: tsHeadParts.join("\n"),
      refs: [...refs].sort(byteOrder),
    },
  };
}

/** Adds the transitive closure of `name` to `into`; throws when it reaches a schema that cannot be emitted. */
function closure(
  name: string,
  schemas: ReadonlyMap<string, EmittedSchema>,
  bad: ReadonlyMap<string, string>,
  into: Set<string>,
): void {
  if (into.has(name)) return;
  const reason = bad.get(name);
  if (reason !== undefined) throw new UnsupportedShape(`schema ${name}: ${reason}`);
  const schema = schemas.get(name);
  if (schema === undefined) throw new UnsupportedShape(`schema ${name}: unknown $ref`);
  into.add(name);
  for (const dep of schema.deps) closure(dep, schemas, bad, into);
}

/** Maps one Discovery document to generator records, listing methods it cannot support with a reason. */
export function emitService(service: GoogleService, doc: DiscoveryDoc, opts: { api?: string; allow?: MethodAllowlist } = {}): EmittedService {
  const all = new Map<string, EmittedSchema>();
  const bad = new Map<string, string>();
  for (const name of Object.keys(doc.schemas).sort(byteOrder)) {
    const node = doc.schemas[name]!;
    try {
      all.set(name, {
        expr: zodSchema(node),
        ts: tsDeclaration(name, node),
        deps: [...refsOf(node)].sort(byteOrder),
      });
    } catch (err) {
      if (!(err instanceof UnsupportedShape)) throw err;
      bad.set(name, err.message);
    }
  }

  const discovered = collectMethods(doc)
    .filter((m) => allowed(m.id, opts.allow))
    .sort((a, b) => byteOrder(a.id, b.id));
  const methods: GenMethod[] = [];
  const unsupported: Unsupported[] = [];
  const droppedUploads: string[] = [];
  const reachable = new Set<string>();
  for (const m of discovered) {
    try {
      const { method, dropped } = emitMethod(service, doc, m, all, bad);
      methods.push(method);
      if (dropped) droppedUploads.push(m.id);
      for (const r of method.refs) reachable.add(r);
    } catch (err) {
      if (!(err instanceof UnsupportedShape)) throw err;
      unsupported.push({ method: m.id, reason: err.message });
    }
  }

  const schemas = new Map<string, EmittedSchema>();
  for (const name of [...reachable].sort(byteOrder)) schemas.set(name, all.get(name)!);
  return {
    api: opts.api ?? service,
    service,
    version: doc.version,
    revision: doc.revision,
    methods,
    unsupported,
    total: discovered.length,
    schemas,
    droppedUploads,
  };
}
