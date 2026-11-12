import type { MethodMeta, PlanRequest } from "../contracts";
import { GwsError } from "../errors";
import { generatedFns } from "../sdk/generated/index";
import { buildUpload } from "./media";
import { assertGoogleUrl } from "./transport";

/** A fully resolved upstream request. `plan` is the redacted view material and is never sent. */
export interface BuiltRequest {
  method: MethodMeta["httpMethod"];
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  plan: { body?: unknown };
}

export interface BuildOptions {
  /** Omitted for dry-run plans, which never reach upstream. */
  accessToken?: string;
  /** Multipart boundary; random when omitted. */
  boundary?: string;
}

/** SDK-level inputs that are never Google parameters. */
const NEVER_SENT: ReadonlySet<string> = new Set(["account", "media", "requestBody"]);

/**
 * Discovery's global query parameters that only the transport may control (upload protocol, credentials, JSONP,
 * error format, output format). Input can never set them, whatever a method declares. `alt` is the exception on
 * downloadable methods, where the generator adds it as the media switch.
 */
const TRANSPORT_OWNED: ReadonlySet<string> = new Set([
  "uploadType",
  "upload_protocol",
  "access_token",
  "oauth_token",
  "key",
  "callback",
  "$.xgafv",
  "prettyPrint",
  "alt",
]);

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** An unpaired UTF-16 surrogate: encodeURIComponent throws on it and URLSearchParams silently replaces it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const TEMPLATE_VAR = /\{(\+?)([A-Za-z0-9_.-]+)\}/g;
const SIMPLE_VAR_SEGMENT = /^\{([A-Za-z0-9_.-]+)\}$/;

function invalid(message: string, details: Record<string, unknown>): GwsError {
  return new GwsError("GWS_INVALID_INPUT", message, { details });
}

/** Per method id, per simple path param: the literal segments of sibling routes that value would reach instead. */
export type PathCollisions = ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;

/** Every path template a method can send to, relative to `rootUrl`, split into segments. */
function templates(meta: MethodMeta): string[][] {
  const all = [`${meta.servicePath}${meta.path}`];
  if (meta.mediaUpload) all.push(meta.mediaUpload.simplePath, meta.mediaUpload.multipartPath);
  return [...new Set(all.map((t) => t.replace(/^\//, "")))].map((t) => t.split("/"));
}

/**
 * Finds path values that would make a request reach a different method. Google routes literal segments before
 * variables, so `DELETE files/{fileId}` with fileId "trash" runs `DELETE files/trash` (emptyTrash), not a delete
 * of one file. A sibling is another method with the same HTTP method and rootUrl and a template of the same
 * length, equal where both are literal, with a literal wherever this method has a simple variable that differs.
 * Each such literal is recorded for that variable (conservatively, even when the sibling differs at several).
 */
export function pathCollisions(metas: readonly MethodMeta[]): PathCollisions {
  const out = new Map<string, Map<string, Set<string>>>();
  for (const m of metas) {
    for (const s of metas) {
      if (s === m || s.id === m.id || s.httpMethod !== m.httpMethod || s.rootUrl !== m.rootUrl) continue;
      for (const tm of templates(m)) {
        for (const ts of templates(s)) {
          if (tm.length !== ts.length) continue;
          const hits: Array<[string, string]> = [];
          const matches = tm.every((a, i) => {
            const b = ts[i] as string;
            const varA = SIMPLE_VAR_SEGMENT.exec(a)?.[1];
            const varB = SIMPLE_VAR_SEGMENT.test(b);
            if (varA !== undefined && varB) return true;
            if (varA !== undefined && !b.includes("{")) {
              hits.push([varA, b]);
              return true;
            }
            return a === b;
          });
          if (!matches) continue;
          for (const [param, literal] of hits) {
            const params = out.get(m.id) ?? new Map<string, Set<string>>();
            out.set(m.id, params);
            const literals = params.get(param) ?? new Set<string>();
            params.set(param, literals);
            literals.add(literal);
          }
        }
      }
    }
  }
  return out;
}

let generatedCollisions: PathCollisions | undefined;

/** Collisions among the generated Google methods, computed once on first use. */
function collisionsFor(meta: MethodMeta): ReadonlyMap<string, ReadonlySet<string>> | undefined {
  generatedCollisions ??= pathCollisions(generatedFns.flatMap((f) => (f.method ? [f.method] : [])));
  return generatedCollisions.get(meta.id);
}

/**
 * Reserved values keep "/" as the segment separator, so a percent sign could smuggle an escaped separator, dot or
 * double escape past the pattern check if anything decodes the path more than once. No resource name of a
 * reserved-path method needs one, so reserved values refuse "%" outright.
 */
const PERCENT = "%";

const compiledPatterns = new Map<string, RegExp>();

/** The compiled Discovery pattern; generated patterns are anchored fixed-segment expressions (see scripts/gen). */
function compiled(pattern: string): RegExp {
  let re = compiledPatterns.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(pattern, "u");
    } catch {
      throw new GwsError("GWS_INTERNAL", "a path parameter pattern does not compile", { details: { reason: "bad-path-pattern" } });
    }
    compiledPatterns.set(pattern, re);
  }
  return re;
}

type PathParam = MethodMeta["pathParams"][number];

/**
 * Validates and encodes one path param. Simple expansion percent-encodes everything (including "/"); reserved
 * expansion keeps "/" between individually encoded segments. Dot segments are refused for both, and empty
 * segments and percent signs for reserved values (a leading "//" or "/" could otherwise retarget the
 * request). A param with a Discovery pattern must match it, so a reserved value cannot name another resource.
 */
function expandParam(param: PathParam, value: unknown, routeLiterals: ReadonlySet<string> | undefined): string {
  const { name, pattern, reserved } = param;
  if (value === undefined || value === null) throw invalid(`missing path parameter ${name}`, { param: name, reason: "missing" });
  if (typeof value !== "string" && typeof value !== "number") {
    throw invalid(`path parameter ${name} must be a string`, { param: name, reason: "not-scalar" });
  }
  const text = String(value);
  if (text === "") throw invalid(`path parameter ${name} is empty`, { param: name, reason: "empty" });
  if (CONTROL_CHARS.test(text)) throw invalid(`path parameter ${name} has control characters`, { param: name, reason: "control-char" });
  if (LONE_SURROGATE.test(text)) throw invalid(`path parameter ${name} is not well-formed Unicode`, { param: name, reason: "malformed-unicode" });
  const segments = text.split("/");
  if (segments.some((s) => s === "." || s === "..")) {
    throw invalid(`path parameter ${name} has a dot segment`, { param: name, reason: "dot-segment" });
  }
  if (!reserved && routeLiterals?.has(text)) {
    throw invalid(`path parameter ${name} would reach a different method`, { param: name, reason: "path-collides-with-route" });
  }
  if (reserved && segments.some((s) => s === "")) {
    throw invalid(`path parameter ${name} has an empty segment`, { param: name, reason: "empty-segment" });
  }
  if (reserved && text.includes(PERCENT)) {
    throw invalid(`path parameter ${name} has a percent sign`, { param: name, reason: "percent-sign" });
  }
  if (pattern !== undefined && !compiled(pattern).test(text)) {
    throw invalid(`path parameter ${name} does not match the expected form ${pattern}`, {
      param: name,
      reason: "pattern-mismatch",
      expected: pattern,
    });
  }
  if (!reserved) return encodeURIComponent(text);
  return segments.map(encodeURIComponent).join("/");
}

function expandPath(meta: MethodMeta, template: string, input: Record<string, unknown>): string {
  const declared = new Map(meta.pathParams.map((p) => [p.name, p]));
  const collisions = collisionsFor(meta);
  return template.replace(TEMPLATE_VAR, (_m, plus: string, name: string) => {
    const param = declared.get(name);
    if (!param) throw new GwsError("GWS_INTERNAL", `path template names an undeclared parameter ${name}`);
    // Every template of a method (its path and upload paths) must expand a param the way it was declared, so a
    // reserved expansion always comes with the pattern and checks of a reserved param.
    if ((plus === "+") !== param.reserved) {
      throw new GwsError("GWS_INTERNAL", `path template expands ${name} unlike its declaration`, { details: { reason: "expansion-mismatch" } });
    }
    return expandParam(param, input[name], collisions?.get(name));
  });
}

function scalar(name: string, value: unknown): string {
  if (typeof value === "string") {
    if (LONE_SURROGATE.test(value)) throw invalid(`query parameter ${name} is not well-formed Unicode`, { param: name, reason: "malformed-unicode" });
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw invalid(`query parameter ${name} must be a scalar`, { param: name, reason: "not-scalar" });
}

function appendQuery(meta: MethodMeta, input: Record<string, unknown>, query: URLSearchParams): void {
  for (const { name, repeated } of meta.queryParams) {
    if (NEVER_SENT.has(name)) continue;
    const value = input[name];
    if (value === undefined || value === null) continue;
    if (TRANSPORT_OWNED.has(name) && !(name === "alt" && meta.mediaDownload)) {
      throw invalid(`query parameter ${name} is set by the transport, not by input`, { param: name, reason: "transport-owned" });
    }
    if (Array.isArray(value)) {
      if (!repeated) throw invalid(`query parameter ${name} takes one value`, { param: name, reason: "not-repeated" });
      for (const v of value) query.append(name, scalar(name, v));
    } else {
      query.append(name, scalar(name, value));
    }
  }
}

/**
 * A rootUrl must be exactly an origin plus "/". That closes the authority before any template or parameter text
 * is appended, so the expanded path can never complete or change the host, and the origin+pathname comparison
 * after parsing is enough to prove the target is the one that was built.
 */
function assertRootUrl(rootUrl: string): void {
  let origin: string | undefined;
  try {
    origin = new URL(rootUrl).origin;
  } catch {
    origin = undefined;
  }
  if (origin === undefined || rootUrl !== `${origin}/`) {
    throw new GwsError("GWS_INTERNAL", "method rootUrl is not an origin followed by a slash", { details: { reason: "bad-root-url" } });
  }
}

/**
 * Builds the upstream request for one Google method from SDK input: `rootUrl + servicePath + path` (or the
 * media upload path), path params expanded and validated, declared query params only, `requestBody` as JSON,
 * `media` as a simple or multipart upload. The final URL must stay on the method's allowlisted Google host
 * and keep exactly the path that was built.
 */
export function buildRequest(meta: MethodMeta, input: unknown, opts: BuildOptions = {}): BuiltRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalid("input must be an object", { reason: "not-object" });
  }
  assertRootUrl(meta.rootUrl);
  const args = input as Record<string, unknown>;
  const headers: Record<string, string> = {};
  const query = new URLSearchParams();
  const json = args.requestBody;
  if (json !== undefined && !meta.requestBody) {
    throw invalid("this method takes no requestBody", { param: "requestBody", reason: "not-accepted" });
  }

  let pathTemplate = `${meta.servicePath}${meta.path}`;
  let body: string | Uint8Array | undefined;
  let planBody: unknown = json;
  if (args.media !== undefined) {
    const upload = buildUpload(meta, args.media, json, opts.boundary);
    pathTemplate = upload.pathTemplate;
    query.append("uploadType", upload.uploadType);
    headers["content-type"] = upload.contentType;
    body = upload.body;
    planBody = json === undefined ? { media: upload.media } : { metadata: json, media: upload.media };
  } else if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  appendQuery(meta, args, query);

  const path = expandPath(meta, pathTemplate, args);
  const qs = query.toString();
  const url = `${meta.rootUrl}${path}${qs ? `?${qs}` : ""}`;
  const parsed = assertGoogleUrl(url);
  if (`${parsed.origin}${parsed.pathname}` !== `${meta.rootUrl}${path}`) {
    throw invalid("the request path would be rewritten by URL parsing", { reason: "target-changed" });
  }

  if (opts.accessToken !== undefined) headers.authorization = `Bearer ${opts.accessToken}`;
  const req: BuiltRequest = { method: meta.httpMethod, url, headers, plan: {} };
  if (body !== undefined) req.body = body;
  if (planBody !== undefined) req.plan.body = planBody;
  return req;
}

/** Plan view of a request: no headers (so no Authorization), query split out, media shown as `{mimeType, bytes}`. */
export function describeRequest(req: BuiltRequest): PlanRequest {
  const u = new URL(req.url);
  const query: Record<string, string | string[]> = {};
  for (const [k, v] of u.searchParams) {
    const prev = query[k];
    query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  const plan: PlanRequest = { method: req.method, url: `${u.origin}${u.pathname}`, query };
  if (req.plan.body !== undefined) plan.body = req.plan.body;
  return plan;
}
