import { getAccount, googleError, randomToken } from "../oauth";
import { fakeKey, type FakeStore, type JsonValue } from "../store";
import { baseMimeType, headerParam, headerValue, parseEntity, splitMultipart } from "./gmail";
import type { FakeContext, FakeRoute, SeedPresets } from "./index";

// ---------- model ----------

/** Stored at `drive:file:<email>:<id>`. Content, when any, is at `drive:blob:<email>:<id>` (standard base64). */
interface FileRecord {
  [key: string]: JsonValue;
  kind: "drive#file";
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  starred: boolean;
  createdTime: string;
  modifiedTime: string;
  version: string;
  webViewLink: string;
}

/** Stored at `drive:permission:<email>:<fileId>:<permissionId>`. */
interface PermissionRecord {
  [key: string]: JsonValue;
  kind: "drive#permission";
  id: string;
  type: string;
  role: string;
}

const FOLDER = "application/vnd.google-apps.folder";
const GOOGLE_APPS = "application/vnd.google-apps.";
const FAKE_PDF = new TextEncoder().encode("%PDF-1.4\n%fake export\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

const fileKey = (email: string, id: string) => fakeKey("drive", "file", email, id);
const blobKey = (email: string, id: string) => fakeKey("drive", "blob", email, id);
const permissionPrefix = (email: string, fileId: string) => `drive:permission:${email}:${fileId}:`;

const webViewLink = (id: string, mimeType: string) =>
  mimeType === FOLDER ? `https://drive.google.com/drive/folders/${id}` : `https://drive.google.com/file/d/${id}/view?usp=drivesdk`;

// ---------- encoding ----------

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- field selection (`fields` parameter) ----------

type FieldSpec = Map<string, FieldSpec | null>;

/** Parses `a,b(c,d),*` into a tree; returns undefined on a syntax error. */
function parseFields(text: string): FieldSpec | undefined {
  let at = 0;
  function list(): FieldSpec | undefined {
    const spec: FieldSpec = new Map();
    while (true) {
      const m = /^\s*(\*|[A-Za-z][A-Za-z0-9_]*)\s*/.exec(text.slice(at));
      if (!m || m[1] === undefined) return undefined;
      at += m[0].length;
      let sub: FieldSpec | null = null;
      if (text[at] === "(") {
        at++;
        const inner = list();
        if (!inner || text[at] !== ")") return undefined;
        at++;
        sub = inner;
      }
      spec.set(m[1], sub);
      while (text[at] === " ") at++;
      if (text[at] !== ",") return spec;
      at++;
    }
  }
  const spec = list();
  return spec && at === text.length ? spec : undefined;
}

function project(value: JsonValue, spec: FieldSpec | null): JsonValue {
  if (spec === null || spec.has("*")) return value;
  if (Array.isArray(value)) return value.map((v) => project(v, spec));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, JsonValue> = {};
  for (const [name, sub] of spec) {
    const v = value[name];
    if (v !== undefined) out[name] = project(v, sub);
  }
  return out;
}

/** Applies `fields`, or Drive v3's default partial response when it is absent. */
function selected(ctx: FakeContext, body: JsonValue, defaults: string): Response {
  const spec = parseFields(ctx.url.searchParams.get("fields") ?? defaults);
  if (!spec) return badRequest("Invalid field selection", "invalidParameter");
  return Response.json(project(body, spec));
}

// ---------- errors ----------

function fileNotFound(id: string): Response {
  const message = `File not found: ${id}.`;
  return googleError(404, message, "NOT_FOUND", {
    errors: [{ message, domain: "global", reason: "notFound", location: "fileId", locationType: "parameter" }],
  });
}

function badRequest(message: string, reason = "badRequest"): Response {
  return googleError(400, message, "INVALID_ARGUMENT", { errors: [{ message, domain: "global", reason }] });
}

function forbidden(message: string, reason: string): Response {
  return googleError(403, message, "PERMISSION_DENIED", { errors: [{ message, domain: "global", reason }] });
}

// ---------- shared ----------

async function readJsonObject(req: Request): Promise<Record<string, unknown> | undefined> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function loadFile(ctx: FakeContext, id: string): Promise<FileRecord | undefined> {
  return ctx.store.get<FileRecord>(fileKey(ctx.email, id));
}

/** Full resource view: the record plus the owner, as `fields=*` would return it. */
async function fullView(store: FakeStore, email: string, rec: FileRecord): Promise<Record<string, JsonValue>> {
  const sub = (await getAccount(store, email))?.sub ?? "0";
  const owner = { kind: "drive#user", displayName: email.split("@")[0] ?? email, emailAddress: email, me: true, permissionId: sub };
  return { ...rec, owners: [owner], ownedByMe: true };
}

const FILE_DEFAULT = "kind,id,name,mimeType";
const FILE_LIST_DEFAULT = `kind,incompleteSearch,nextPageToken,files(${FILE_DEFAULT})`;
const PERMISSION_DEFAULT = "kind,id,type,role";
const PERMISSION_LIST_DEFAULT = "kind,nextPageToken,permissions(kind,id,type,emailAddress,domain,role,allowFileDiscovery)";

/**
 * Applies writable metadata from a request body. Returns an error message for a wrongly typed field.
 * `trashed` is writable on update only, as in Drive v3.
 */
function applyMetadata(rec: FileRecord, body: Record<string, unknown>, allowTrashed: boolean): string | undefined {
  for (const k of ["name", "mimeType", "description"] as const) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== "string") return `Invalid value for ${k}`;
    rec[k] = body[k] as string;
  }
  for (const k of allowTrashed ? (["starred", "trashed"] as const) : (["starred"] as const)) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== "boolean") return `Invalid value for ${k}`;
    rec[k] = body[k] as boolean;
  }
  for (const k of ["appProperties", "properties"] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (typeof v !== "object" || v === null || Array.isArray(v) || !Object.values(v).every((x) => typeof x === "string")) {
      return `Invalid value for ${k}`;
    }
    rec[k] = { ...(rec[k] as Record<string, string> | undefined), ...(v as Record<string, string>) };
  }
  return undefined;
}

/** Every parent must be "root" or an existing folder of the account. */
async function checkParents(ctx: FakeContext, parents: unknown): Promise<{ ok: true; parents?: string[] } | { ok: false; response: Response }> {
  if (parents === undefined) return { ok: true };
  if (!Array.isArray(parents) || !parents.every((p) => typeof p === "string")) {
    return { ok: false, response: badRequest("Invalid value for parents", "invalidParameter") };
  }
  for (const p of parents as string[]) {
    if (p === "root") continue;
    const folder = await loadFile(ctx, p);
    if (!folder || folder.mimeType !== FOLDER) return { ok: false, response: fileNotFound(p) };
  }
  return { ok: true, parents: parents as string[] };
}

async function newFile(ctx: FakeContext, meta: Record<string, unknown>, media?: { mimeType: string; bytes: Uint8Array }): Promise<Response> {
  const parents = await checkParents(ctx, meta.parents);
  if (!parents.ok) return parents.response;
  const now = new Date(ctx.now()).toISOString();
  const id = `1${randomToken(24)}`;
  const rec: FileRecord = {
    kind: "drive#file",
    id,
    name: "Untitled",
    mimeType: media?.mimeType ?? "application/octet-stream",
    parents: parents.parents ?? ["root"],
    trashed: false,
    starred: false,
    createdTime: now,
    modifiedTime: now,
    version: "1",
    webViewLink: "",
  };
  const error = applyMetadata(rec, meta, false);
  if (error) return badRequest(error, "invalidParameter");
  rec.webViewLink = webViewLink(id, rec.mimeType);
  if (media) {
    rec.size = String(media.bytes.length);
    rec.sha256Checksum = await sha256Hex(media.bytes);
    await ctx.store.put(blobKey(ctx.email, id), toBase64(media.bytes));
  }
  await ctx.store.put(fileKey(ctx.email, id), rec);
  return selected(ctx, await fullView(ctx.store, ctx.email, rec), FILE_DEFAULT);
}

// ---------- files.list query ----------

type Clause = (f: FileRecord) => boolean;

const QUOTED = "'((?:[^'\\\\]|\\\\.)*)'";
const unquote = (s: string) => s.replace(/\\(.)/g, "$1");

/** Splits on `and` outside quotes. */
function splitAnd(q: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < q.length; i++) {
    const c = q[i] ?? "";
    if (c === "\\" && quoted) {
      cur += c + (q[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "'") quoted = !quoted;
    if (!quoted && /^\sand\s/i.test(q.slice(i, i + 5))) {
      out.push(cur);
      cur = "";
      i += 4;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Supports `name|mimeType (=|!=|contains) '…'`, `trashed (=|!=) true|false` and `'id' in parents`. */
function parseQuery(q: string): Clause[] | undefined {
  const clauses: Clause[] = [];
  for (const part of splitAnd(q)) {
    let m = new RegExp(`^${QUOTED}\\s+in\\s+parents$`).exec(part);
    if (m) {
      const id = unquote(m[1] ?? "");
      clauses.push((f) => f.parents.includes(id));
      continue;
    }
    m = new RegExp(`^(name|mimeType)\\s*(=|!=|contains)\\s*${QUOTED}$`).exec(part);
    if (m) {
      const [, field = "name", op, raw = ""] = m;
      const v = unquote(raw);
      clauses.push((f) => {
        const actual = field === "name" ? f.name : f.mimeType;
        if (op === "contains") return actual.toLowerCase().includes(v.toLowerCase());
        return op === "=" ? actual === v : actual !== v;
      });
      continue;
    }
    m = /^trashed\s*(=|!=)\s*(true|false)$/.exec(part);
    if (m) {
      const want = (m[2] === "true") === (m[1] === "=");
      clauses.push((f) => f.trashed === want);
      continue;
    }
    return undefined;
  }
  return clauses;
}

// ---------- handlers ----------

const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;
const fileIdOf = (ctx: FakeContext) => decodeURIComponent(ctx.match[1] ?? "");

async function listFiles(ctx: FakeContext): Promise<Response> {
  const p = ctx.url.searchParams;
  const q = p.get("q")?.trim();
  const clauses = q ? parseQuery(q) : [];
  if (!clauses) {
    const message = "Invalid Value";
    return googleError(400, message, "INVALID_ARGUMENT", {
      errors: [{ message, domain: "global", reason: "invalid", location: "q", locationType: "parameter" }],
    });
  }
  const sizeRaw = p.get("pageSize");
  const size = sizeRaw === null ? DEFAULT_PAGE : Number(sizeRaw);
  if (!Number.isInteger(size) || size < 1) return badRequest("Invalid pageSize", "invalidParameter");
  const tokenRaw = p.get("pageToken");
  if (tokenRaw !== null && !/^\d{1,9}$/.test(tokenRaw)) return badRequest("Invalid pageToken", "invalidParameter");
  const offset = tokenRaw === null ? 0 : Number(tokenRaw);

  const files = (await ctx.store.list<FileRecord>(`drive:file:${ctx.email}:`))
    .map(([, f]) => f)
    .filter((f) => clauses.every((c) => c(f)))
    .sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : a.modifiedTime > b.modifiedTime ? -1 : a.name.localeCompare(b.name)));
  const page = files.slice(offset, offset + Math.min(size, MAX_PAGE));
  const body: Record<string, JsonValue> = { kind: "drive#fileList", incompleteSearch: false };
  if (offset + page.length < files.length) body.nextPageToken = String(offset + page.length);
  body.files = await Promise.all(page.map((f) => fullView(ctx.store, ctx.email, f)));
  return selected(ctx, body, FILE_LIST_DEFAULT);
}

async function createFile(ctx: FakeContext): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  return newFile(ctx, body);
}

async function uploadFile(ctx: FakeContext): Promise<Response> {
  const uploadType = ctx.url.searchParams.get("uploadType");
  const contentType = ctx.req.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await ctx.req.arrayBuffer());
  if (uploadType === "media") {
    return newFile(ctx, {}, { mimeType: baseMimeType(contentType) || "application/octet-stream", bytes });
  }
  if (uploadType !== "multipart") return badRequest(`Invalid uploadType: ${uploadType ?? "(missing)"}`, "invalidParameter");
  const boundary = headerParam(contentType, "boundary");
  if (baseMimeType(contentType) !== "multipart/related" || !boundary) return badRequest("Expected multipart/related with a boundary");
  const parts = splitMultipart(bytes, boundary).map(parseEntity);
  const [metaPart, mediaPart] = parts;
  if (parts.length !== 2 || !metaPart || !mediaPart) return badRequest("Multipart upload needs exactly a metadata part and a media part");
  let meta: unknown;
  try {
    meta = JSON.parse(new TextDecoder().decode(metaPart.body));
  } catch {
    return badRequest("Invalid JSON payload received.");
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return badRequest("Invalid JSON payload received.");
  const mediaType = baseMimeType(headerValue(mediaPart.headers, "content-type")) || "application/octet-stream";
  return newFile(ctx, meta as Record<string, unknown>, { mimeType: mediaType, bytes: mediaPart.body });
}

async function getFile(ctx: FakeContext): Promise<Response> {
  const id = fileIdOf(ctx);
  const rec = await loadFile(ctx, id);
  if (!rec) return fileNotFound(id);
  const alt = ctx.url.searchParams.get("alt") ?? "json";
  if (alt === "json") return selected(ctx, await fullView(ctx.store, ctx.email, rec), FILE_DEFAULT);
  if (alt !== "media") return badRequest(`Invalid value for alt: ${alt}`, "invalidParameter");
  if (rec.mimeType.startsWith(GOOGLE_APPS)) {
    return forbidden("Only files with binary content can be downloaded. Use Export with Docs Editors files.", "fileNotDownloadable");
  }
  const blob = await ctx.store.get<string>(blobKey(ctx.email, id));
  return new Response(blob === undefined ? new Uint8Array(0) : fromBase64(blob), { headers: { "content-type": rec.mimeType } });
}

async function updateFile(ctx: FakeContext): Promise<Response> {
  const id = fileIdOf(ctx);
  const rec = await loadFile(ctx, id);
  if (!rec) return fileNotFound(id);
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  const error = applyMetadata(rec, body, true);
  if (error) return badRequest(error, "invalidParameter");
  const add = (ctx.url.searchParams.get("addParents") ?? "").split(",").filter(Boolean);
  const remove = new Set((ctx.url.searchParams.get("removeParents") ?? "").split(",").filter(Boolean));
  const added = await checkParents(ctx, add);
  if (!added.ok) return added.response;
  rec.parents = [...new Set([...rec.parents.filter((p) => !remove.has(p)), ...add])];
  rec.modifiedTime = new Date(ctx.now()).toISOString();
  rec.version = String(Number(rec.version) + 1);
  await ctx.store.put(fileKey(ctx.email, id), rec);
  return selected(ctx, await fullView(ctx.store, ctx.email, rec), FILE_DEFAULT);
}

async function removeFile(store: FakeStore, email: string, id: string): Promise<void> {
  await store.delete(fileKey(email, id));
  await store.delete(blobKey(email, id));
  for (const [key] of await store.list(permissionPrefix(email, id))) await store.delete(key);
}

async function deleteFile(ctx: FakeContext): Promise<Response> {
  const id = fileIdOf(ctx);
  if (!(await loadFile(ctx, id))) return fileNotFound(id);
  await removeFile(ctx.store, ctx.email, id);
  return new Response(null, { status: 204 });
}

async function emptyTrash(ctx: FakeContext): Promise<Response> {
  for (const [, f] of await ctx.store.list<FileRecord>(`drive:file:${ctx.email}:`)) {
    if (f.trashed) await removeFile(ctx.store, ctx.email, f.id);
  }
  return new Response(null, { status: 204 });
}

async function copyFile(ctx: FakeContext): Promise<Response> {
  const id = fileIdOf(ctx);
  const src = await loadFile(ctx, id);
  if (!src) return fileNotFound(id);
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  const blob = await ctx.store.get<string>(blobKey(ctx.email, id));
  const meta: Record<string, unknown> = {
    name: `Copy of ${src.name}`,
    mimeType: src.mimeType,
    parents: src.parents,
    ...(typeof src.description === "string" ? { description: src.description } : {}),
    ...body,
  };
  return newFile(ctx, meta, blob === undefined ? undefined : { mimeType: src.mimeType, bytes: fromBase64(blob) });
}

async function exportFile(ctx: FakeContext): Promise<Response> {
  const id = fileIdOf(ctx);
  const rec = await loadFile(ctx, id);
  if (!rec) return fileNotFound(id);
  const mimeType = ctx.url.searchParams.get("mimeType");
  if (!mimeType) return badRequest("Required parameter: mimeType", "required");
  if (!rec.mimeType.startsWith(GOOGLE_APPS) || rec.mimeType === FOLDER) {
    return forbidden("Export only supports Docs Editors files.", "fileNotExportable");
  }
  if (mimeType !== "application/pdf") return badRequest("The requested conversion is not supported.");
  return new Response(FAKE_PDF, { headers: { "content-type": "application/pdf" } });
}

const PERMISSION_TYPES = new Set(["user", "group", "domain", "anyone"]);
const PERMISSION_ROLES = new Set(["owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"]);

async function createPermission(ctx: FakeContext): Promise<Response> {
  const fileId = fileIdOf(ctx);
  if (!(await loadFile(ctx, fileId))) return fileNotFound(fileId);
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  const { type, role, emailAddress, domain, allowFileDiscovery } = body;
  if (typeof type !== "string" || !PERMISSION_TYPES.has(type)) return badRequest("The permission type field is required.", "required");
  if (typeof role !== "string" || !PERMISSION_ROLES.has(role)) return badRequest("The permission role field is required.", "required");
  if ((type === "user" || type === "group") && typeof emailAddress !== "string") {
    return badRequest("The permission emailAddress field is required.", "required");
  }
  if (type === "domain" && typeof domain !== "string") return badRequest("The permission domain field is required.", "required");
  const discoverable = allowFileDiscovery === true;
  const id =
    type === "anyone"
      ? discoverable
        ? "anyone"
        : "anyoneWithLink"
      : Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => String(b % 10)).join("");
  const rec: PermissionRecord = { kind: "drive#permission", id, type, role };
  if (typeof emailAddress === "string") rec.emailAddress = emailAddress;
  if (typeof domain === "string") rec.domain = domain;
  if (type === "anyone" || type === "domain") rec.allowFileDiscovery = discoverable;
  await ctx.store.put(`${permissionPrefix(ctx.email, fileId)}${id}`, rec);
  return selected(ctx, rec, PERMISSION_DEFAULT);
}

async function getPermission(ctx: FakeContext): Promise<Response> {
  const fileId = fileIdOf(ctx);
  if (!(await loadFile(ctx, fileId))) return fileNotFound(fileId);
  const permissionId = decodeURIComponent(ctx.match[2] ?? "");
  const sub = (await getAccount(ctx.store, ctx.email))?.sub ?? "0";
  const rec =
    permissionId === sub
      ? ({ kind: "drive#permission", id: sub, type: "user", role: "owner", emailAddress: ctx.email } satisfies PermissionRecord)
      : await ctx.store.get<PermissionRecord>(`${permissionPrefix(ctx.email, fileId)}${permissionId}`);
  if (!rec) {
    const message = `Permission not found: ${permissionId}.`;
    return googleError(404, message, "NOT_FOUND", { errors: [{ message, domain: "global", reason: "notFound", location: "permissionId", locationType: "parameter" }] });
  }
  return selected(ctx, rec, PERMISSION_DEFAULT);
}

async function listPermissions(ctx: FakeContext): Promise<Response> {
  const fileId = fileIdOf(ctx);
  if (!(await loadFile(ctx, fileId))) return fileNotFound(fileId);
  const sub = (await getAccount(ctx.store, ctx.email))?.sub ?? "0";
  const owner: PermissionRecord = { kind: "drive#permission", id: sub, type: "user", role: "owner", emailAddress: ctx.email };
  const shared = (await ctx.store.list<PermissionRecord>(permissionPrefix(ctx.email, fileId))).map(([, p]) => p);
  return selected(ctx, { kind: "drive#permissionList", permissions: [owner, ...shared] }, PERMISSION_LIST_DEFAULT);
}

// ---------- routes ----------

const G = "https://www.googleapis.com/auth/";
const FILES = "^/www\\.googleapis\\.com/drive/v3/files";
const FILE_ID = "([^/]+)";

/** Scopes per route: the Discovery `scopes` of the method (checked against the generated SDK in tests). */
const SCOPES = {
  list: [`${G}drive`, `${G}drive.appdata`, `${G}drive.file`, `${G}drive.meet.readonly`, `${G}drive.metadata`, `${G}drive.metadata.readonly`, `${G}drive.photos.readonly`, `${G}drive.readonly`],
  get: [`${G}drive`, `${G}drive.appdata`, `${G}drive.file`, `${G}drive.meet.readonly`, `${G}drive.metadata`, `${G}drive.metadata.readonly`, `${G}drive.photos.readonly`, `${G}drive.readonly`],
  create: [`${G}drive`, `${G}drive.appdata`, `${G}drive.file`],
  copy: [`${G}drive`, `${G}drive.appdata`, `${G}drive.file`, `${G}drive.photos.readonly`],
  update: [`${G}drive`, `${G}drive.appdata`, `${G}drive.file`, `${G}drive.metadata`, `${G}drive.scripts`],
  delete: [`${G}drive`, `${G}drive.appdata`, `${G}drive.file`],
  emptyTrash: [`${G}drive`],
  export: [`${G}drive`, `${G}drive.file`, `${G}drive.meet.readonly`, `${G}drive.readonly`],
  permissionsCreate: [`${G}drive`, `${G}drive.file`],
  permissionsList: [`${G}drive`, `${G}drive.file`, `${G}drive.meet.readonly`, `${G}drive.metadata`, `${G}drive.metadata.readonly`, `${G}drive.photos.readonly`, `${G}drive.readonly`],
};

// Order matters: `files/trash` must win over `files/{fileId}`.
export const routes: FakeRoute[] = [
  { method: "DELETE", pattern: new RegExp(`${FILES}/trash$`), scopes: SCOPES.emptyTrash, handle: emptyTrash },
  { method: "GET", pattern: new RegExp(`${FILES}$`), scopes: SCOPES.list, handle: listFiles },
  { method: "POST", pattern: new RegExp(`${FILES}$`), scopes: SCOPES.create, handle: createFile },
  { method: "POST", pattern: /^\/www\.googleapis\.com\/upload\/drive\/v3\/files$/, scopes: SCOPES.create, handle: uploadFile },
  { method: "GET", pattern: new RegExp(`${FILES}/${FILE_ID}/export$`), scopes: SCOPES.export, handle: exportFile },
  { method: "POST", pattern: new RegExp(`${FILES}/${FILE_ID}/copy$`), scopes: SCOPES.copy, handle: copyFile },
  { method: "POST", pattern: new RegExp(`${FILES}/${FILE_ID}/permissions$`), scopes: SCOPES.permissionsCreate, handle: createPermission },
  { method: "GET", pattern: new RegExp(`${FILES}/${FILE_ID}/permissions$`), scopes: SCOPES.permissionsList, handle: listPermissions },
  { method: "GET", pattern: new RegExp(`${FILES}/${FILE_ID}/permissions/([^/]+)$`), scopes: SCOPES.permissionsList, handle: getPermission },
  { method: "GET", pattern: new RegExp(`${FILES}/${FILE_ID}$`), scopes: SCOPES.get, handle: getFile },
  { method: "PATCH", pattern: new RegExp(`${FILES}/${FILE_ID}$`), scopes: SCOPES.update, handle: updateFile },
  { method: "DELETE", pattern: new RegExp(`${FILES}/${FILE_ID}$`), scopes: SCOPES.delete, handle: deleteFile },
];

// ---------- seed preset ----------

function seedFile(id: string, name: string, mimeType: string, parents: string[], extra: Record<string, JsonValue> = {}) {
  const value: FileRecord = {
    kind: "drive#file",
    id,
    name,
    mimeType,
    parents,
    trashed: false,
    starred: false,
    createdTime: "2026-11-01T09:00:00.000Z",
    modifiedTime: "2026-11-01T09:00:00.000Z",
    version: "1",
    webViewLink: webViewLink(id, mimeType),
    ...extra,
  };
  return { key: `drive:file:{email}:${id}`, value };
}

export const presets: SeedPresets = {
  default: [
    seedFile("seed-folder-projects", "Projects", FOLDER, ["root"]),
    seedFile("seed-file-readme", "README.txt", "text/plain", ["seed-folder-projects"], {
      size: "27",
      sha256Checksum: "f7e82ab03837e85f2a92948e20f249bb966d1a60c5548e3e0eaf4246ee9e88e6",
      modifiedTime: "2026-11-02T09:00:00.000Z",
    }),
    { key: "drive:blob:{email}:seed-file-readme", value: "SGVsbG8gZnJvbSB0aGUgZmFrZSBEcml2ZS4K" },
    seedFile("seed-doc-notes", "Meeting notes", "application/vnd.google-apps.document", ["root"], {
      modifiedTime: "2026-11-03T09:00:00.000Z",
    }),
    seedFile("seed-file-old-draft", "old-draft.txt", "text/plain", ["root"], {
      trashed: true,
      size: "11",
      sha256Checksum: "fbadc8ac373acdac24801f09d34a9f78dcf895df5f9684fed515dc380ccf2f6e",
    }),
    { key: "drive:blob:{email}:seed-file-old-draft", value: "T2xkIGRyYWZ0Lgo=" },
  ],
};
