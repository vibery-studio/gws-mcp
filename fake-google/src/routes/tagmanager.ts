import { fakeKey, type JsonValue } from "../store";
import { badRequest, conflict, noContent, notFound, paginate, readJsonObject } from "./google-http";
import type { FakeContext, FakeRoute, SeedPresets } from "./index";

// ---------- model ----------

type Entity = Record<string, JsonValue>;
type Snapshot = Record<string, Entity>;

/** The three entity kinds with routes: the URL segment, the store kind, the id field and the list response field. */
const ENTITIES = {
  tags: { kind: "tag", idField: "tagId", listField: "tag" },
  triggers: { kind: "trigger", idField: "triggerId", listField: "trigger" },
  variables: { kind: "variable", idField: "variableId", listField: "variable" },
} as const;
type EntityPlural = keyof typeof ENTITIES;
const ENTITY_KINDS = Object.values(ENTITIES);

/** Fields the server owns: a request never sets them. */
const SERVER_FIELDS = ["accountId", "containerId", "workspaceId", "tagId", "triggerId", "variableId", "path", "fingerprint", "tagManagerUrl"];

const TRIGGER_TYPES = [
  "pageview", "domReady", "windowLoaded", "customEvent", "triggerGroup", "init", "consentInit", "serverPageview", "always",
  "formSubmission", "click", "linkClick", "jsError", "historyChange", "timer", "youTubeVideo", "scrollDepth", "elementVisibility",
  "ampClick", "ampTimer", "ampScroll", "ampVisibility",
];
const FIRING_OPTIONS = ["unlimited", "oncePerEvent", "oncePerLoad"];
const ACCOUNT_PERMISSIONS = ["noAccess", "user", "admin"];
const CONTAINER_PERMISSIONS = ["noAccess", "read", "edit", "approve", "publish"];
const MISSING = "Not found or permission denied.";
const UI = "https://tagmanager.google.com/#/container/";

const accountKey = (email: string, a: string) => fakeKey("tagmanager", "account", email, a);
const containerKey = (email: string, a: string, c: string) => fakeKey("tagmanager", "container", email, `${a}/${c}`);
const workspaceKey = (email: string, a: string, c: string, w: string) => fakeKey("tagmanager", "workspace", email, `${a}/${c}/${w}`);
const entityKey = (email: string, kind: string, a: string, c: string, w: string, id: string) => fakeKey("tagmanager", kind, email, `${a}/${c}/${w}/${id}`);
const entityPrefix = (email: string, kind: string, a: string, c: string, w: string) => `tagmanager:${kind}:${email}:${a}/${c}/${w}/`;
const baselineKey = (email: string, a: string, c: string, w: string) => fakeKey("tagmanager", "baseline", email, `${a}/${c}/${w}`);
const versionKey = (email: string, a: string, c: string, v: string) => fakeKey("tagmanager", "version", email, `${a}/${c}/${v}`);
const liveKey = (email: string, a: string, c: string) => fakeKey("tagmanager", "live", email, `${a}/${c}`);
const seqKey = (email: string, a: string, c: string) => fakeKey("tagmanager", "seq", email, `${a}/${c}`);
const permissionKey = (email: string, a: string, p: string) => fakeKey("tagmanager", "permission", email, `${a}/${p}`);

const accountPath = (a: string) => `accounts/${a}`;
const containerPath = (a: string, c: string) => `accounts/${a}/containers/${c}`;
const workspacePath = (a: string, c: string, w: string) => `accounts/${a}/containers/${c}/workspaces/${w}`;

/** Content-derived, so an unchanged entity keeps its fingerprint and any change moves it. */
function fingerprintOf(value: JsonValue): string {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(value)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return String(h);
}

function withFingerprint(entity: Entity): Entity {
  const { fingerprint: _drop, ...rest } = entity;
  return { ...rest, fingerprint: fingerprintOf(rest) };
}

const missing = () => notFound(MISSING);
const invalid = (message: string) => badRequest(message);

// ---------- store access ----------

type SeqKind = "tag" | "trigger" | "variable" | "workspace" | "version";
type Seq = Record<SeqKind, number>;

/** The next id of `kind` in a container. Ids are never reused, and never collide with an existing key. */
async function nextId(ctx: FakeContext, a: string, c: string, kind: SeqKind, exists: (id: string) => Promise<boolean>): Promise<string> {
  const key = seqKey(ctx.email, a, c);
  const seq: Seq = (await ctx.store.get<Seq>(key)) ?? { tag: 0, trigger: 0, variable: 0, workspace: 0, version: 0 };
  let n = seq[kind];
  do n += 1;
  while (await exists(String(n)));
  await ctx.store.put(key, { ...seq, [kind]: n });
  return String(n);
}

async function entities(ctx: FakeContext, kind: string, a: string, c: string, w: string): Promise<Entity[]> {
  const rows = await ctx.store.list<Entity>(entityPrefix(ctx.email, kind, a, c, w));
  return rows.map(([, e]) => e).sort((x, y) => Number(x[`${kind}Id`]) - Number(y[`${kind}Id`]));
}

async function snapshotOf(ctx: FakeContext, a: string, c: string, w: string): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const { kind, idField } of ENTITY_KINDS) {
    for (const e of await entities(ctx, kind, a, c, w)) out[`${kind}/${String(e[idField])}`] = e;
  }
  return out;
}

async function putSnapshot(ctx: FakeContext, a: string, c: string, w: string, snap: Snapshot): Promise<void> {
  for (const [name, e] of Object.entries(snap)) {
    const [kind = "", id = ""] = name.split("/");
    await ctx.store.put(entityKey(ctx.email, kind, a, c, w, id), { ...e, workspaceId: w, path: `${workspacePath(a, c, w)}/${kind}s/${id}` });
  }
}

async function deleteWorkspaceData(ctx: FakeContext, a: string, c: string, w: string): Promise<void> {
  for (const { kind } of ENTITY_KINDS) {
    for (const [k] of await ctx.store.list(entityPrefix(ctx.email, kind, a, c, w))) await ctx.store.delete(k);
  }
  await ctx.store.delete(baselineKey(ctx.email, a, c, w));
  await ctx.store.delete(workspaceKey(ctx.email, a, c, w));
}

const listBody = (field: string, rows: JsonValue[], page: { nextPageToken?: string }): Response => {
  const out: Record<string, JsonValue> = {};
  if (rows.length > 0) out[field] = rows;
  if (page.nextPageToken) out.nextPageToken = page.nextPageToken;
  return Response.json(out);
};

function pageOf<T>(ctx: FakeContext, all: T[]): { page: T[]; nextPageToken?: string } | Response {
  const paged = paginate(all, ctx.url.searchParams, "pageSize", 100, 100);
  return "error" in paged ? invalid(paged.error) : paged;
}

const group = (ctx: FakeContext, n: number): string => decodeURIComponent(ctx.match[n] ?? "");

async function loadContainer(ctx: FakeContext): Promise<{ a: string; c: string; container: Entity } | Response> {
  const a = group(ctx, 1);
  const c = group(ctx, 2);
  const container = await ctx.store.get<Entity>(containerKey(ctx.email, a, c));
  return container ? { a, c, container } : missing();
}

async function loadWorkspace(ctx: FakeContext): Promise<{ a: string; c: string; w: string; workspace: Entity } | Response> {
  const a = group(ctx, 1);
  const c = group(ctx, 2);
  const w = group(ctx, 3);
  const workspace = await ctx.store.get<Entity>(workspaceKey(ctx.email, a, c, w));
  return workspace ? { a, c, w, workspace } : missing();
}

// ---------- accounts, containers ----------

async function listAccounts(ctx: FakeContext): Promise<Response> {
  const all = (await ctx.store.list<Entity>(`tagmanager:account:${ctx.email}:`)).map(([, v]) => v);
  const paged = pageOf(ctx, all);
  return paged instanceof Response ? paged : listBody("account", paged.page, paged);
}

async function listContainers(ctx: FakeContext): Promise<Response> {
  const a = group(ctx, 1);
  if (!(await ctx.store.get(accountKey(ctx.email, a)))) return missing();
  const all = (await ctx.store.list<Entity>(`tagmanager:container:${ctx.email}:${a}/`)).map(([, v]) => v);
  const paged = pageOf(ctx, all);
  return paged instanceof Response ? paged : listBody("container", paged.page, paged);
}

async function getContainer(ctx: FakeContext): Promise<Response> {
  const found = await loadContainer(ctx);
  return found instanceof Response ? found : Response.json(found.container);
}

async function deleteContainer(ctx: FakeContext): Promise<Response> {
  const found = await loadContainer(ctx);
  if (found instanceof Response) return found;
  const { a, c } = found;
  for (const [k] of await ctx.store.list(`tagmanager:workspace:${ctx.email}:${a}/${c}/`)) {
    await deleteWorkspaceData(ctx, a, c, k.slice(k.lastIndexOf("/") + 1));
  }
  for (const [k] of await ctx.store.list(`tagmanager:version:${ctx.email}:${a}/${c}/`)) await ctx.store.delete(k);
  await ctx.store.delete(liveKey(ctx.email, a, c));
  await ctx.store.delete(seqKey(ctx.email, a, c));
  await ctx.store.delete(containerKey(ctx.email, a, c));
  return noContent();
}

// ---------- workspaces ----------

async function listWorkspaces(ctx: FakeContext): Promise<Response> {
  const found = await loadContainer(ctx);
  if (found instanceof Response) return found;
  const all = (await ctx.store.list<Entity>(`tagmanager:workspace:${ctx.email}:${found.a}/${found.c}/`))
    .map(([, v]) => v)
    .sort((x, y) => Number(x.workspaceId) - Number(y.workspaceId));
  const paged = pageOf(ctx, all);
  return paged instanceof Response ? paged : listBody("workspace", paged.page, paged);
}

async function getWorkspace(ctx: FakeContext): Promise<Response> {
  const found = await loadWorkspace(ctx);
  return found instanceof Response ? found : Response.json(found.workspace);
}

function workspaceRecord(a: string, c: string, w: string, name: string, description: string | undefined): Entity {
  return withFingerprint({
    accountId: a,
    containerId: c,
    workspaceId: w,
    name,
    ...(description === undefined ? {} : { description }),
    path: workspacePath(a, c, w),
    tagManagerUrl: `${UI}${workspacePath(a, c, w)}`,
  });
}

/** A new workspace holds what the container's live version holds, and has no pending changes. */
async function createWorkspace(ctx: FakeContext): Promise<Response> {
  const found = await loadContainer(ctx);
  if (found instanceof Response) return found;
  const body = await readJsonObject(ctx.req);
  if (!body) return invalid("Invalid JSON payload received.");
  if (typeof body.name !== "string" || body.name.trim() === "") return invalid("Workspace name is required.");
  if (body.description !== undefined && typeof body.description !== "string") return invalid("description must be a string.");
  const { a, c } = found;
  const id = await nextId(ctx, a, c, "workspace", (n) => ctx.store.get(workspaceKey(ctx.email, a, c, n)).then((v) => v !== undefined));
  const record = workspaceRecord(a, c, id, body.name, body.description);
  await ctx.store.put(workspaceKey(ctx.email, a, c, id), record);

  const live = await ctx.store.get<{ containerVersionId: string }>(liveKey(ctx.email, a, c));
  const version = live ? await ctx.store.get<Entity>(versionKey(ctx.email, a, c, live.containerVersionId)) : undefined;
  const snap: Snapshot = {};
  for (const { kind, listField } of ENTITY_KINDS) {
    for (const e of (version?.[listField] as Entity[] | undefined) ?? []) snap[`${kind}/${String(e[`${kind}Id`])}`] = e;
  }
  await putSnapshot(ctx, a, c, id, snap);
  await ctx.store.put(baselineKey(ctx.email, a, c, id), await snapshotOf(ctx, a, c, id));
  return Response.json(record);
}

/** Entities added, updated or deleted since the workspace's base version. No merge conflicts are modelled. */
async function workspaceStatus(ctx: FakeContext): Promise<Response> {
  const found = await loadWorkspace(ctx);
  if (found instanceof Response) return found;
  const { a, c, w } = found;
  const baseline = (await ctx.store.get<Snapshot>(baselineKey(ctx.email, a, c, w))) ?? {};
  const now = await snapshotOf(ctx, a, c, w);
  const changes: JsonValue[] = [];
  for (const { kind } of ENTITY_KINDS) {
    const names = new Set([...Object.keys(now), ...Object.keys(baseline)].filter((n) => n.startsWith(`${kind}/`)));
    for (const name of [...names].sort((x, y) => Number(x.split("/")[1]) - Number(y.split("/")[1]))) {
      const was = baseline[name];
      const is = now[name];
      if (was && is && was.fingerprint === is.fingerprint) continue;
      changes.push({ [kind]: (is ?? was) as Entity, changeStatus: !was ? "added" : !is ? "deleted" : "updated" });
    }
  }
  return Response.json(changes.length === 0 ? {} : { workspaceChange: changes });
}

// ---------- tags, triggers, variables ----------

/** Checks a request body and returns the entity fields to store, or the 400. */
async function readEntity(ctx: FakeContext, plural: EntityPlural, a: string, c: string, w: string): Promise<Entity | Response> {
  const body = await readJsonObject(ctx.req);
  if (!body) return invalid("Invalid JSON payload received.");
  if (typeof body.name !== "string" || body.name.trim() === "") return invalid(`The ${ENTITIES[plural].kind} name is required.`);
  if (typeof body.type !== "string" || body.type === "") return invalid(`The ${ENTITIES[plural].kind} type is required.`);
  if (plural === "triggers" && !TRIGGER_TYPES.includes(body.type)) return invalid(`Invalid trigger type: ${body.type}.`);
  if (plural === "tags") {
    if (body.tagFiringOption !== undefined && !FIRING_OPTIONS.includes(String(body.tagFiringOption))) return invalid("Invalid tagFiringOption.");
    const triggerIds = await entities(ctx, "trigger", a, c, w);
    for (const field of ["firingTriggerId", "blockingTriggerId"]) {
      const ids = body[field];
      if (ids === undefined) continue;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return invalid(`${field} must be a list of trigger ids.`);
      for (const id of ids) if (!triggerIds.some((t) => t.triggerId === id)) return invalid(`${field} refers to unknown trigger ${String(id)}.`);
    }
  }
  const fields = Object.fromEntries(Object.entries(body).filter(([k]) => !SERVER_FIELDS.includes(k)));
  return fields as Entity;
}

function shape(plural: EntityPlural, a: string, c: string, w: string, id: string, fields: Entity): Entity {
  const { idField, kind } = ENTITIES[plural];
  const path = `${workspacePath(a, c, w)}/${plural}/${id}`;
  return withFingerprint({
    path,
    accountId: a,
    containerId: c,
    workspaceId: w,
    [idField]: id,
    ...fields,
    tagManagerUrl: `${UI}${workspacePath(a, c, w)}/${plural}/${id}?apiLink=${kind}`,
  });
}

const entityRoute = (plural: EntityPlural) => {
  const { kind, listField } = ENTITIES[plural];
  return {
    async list(ctx: FakeContext): Promise<Response> {
      const found = await loadWorkspace(ctx);
      if (found instanceof Response) return found;
      const paged = pageOf(ctx, await entities(ctx, kind, found.a, found.c, found.w));
      return paged instanceof Response ? paged : listBody(listField, paged.page, paged);
    },
    async create(ctx: FakeContext): Promise<Response> {
      const found = await loadWorkspace(ctx);
      if (found instanceof Response) return found;
      const { a, c, w } = found;
      const fields = await readEntity(ctx, plural, a, c, w);
      if (fields instanceof Response) return fields;
      const id = await nextId(ctx, a, c, kind, async (n) => {
        for (const [, wsRecord] of await ctx.store.list<Entity>(`tagmanager:workspace:${ctx.email}:${a}/${c}/`)) {
          if ((await ctx.store.get(entityKey(ctx.email, kind, a, c, String(wsRecord.workspaceId), n))) !== undefined) return true;
        }
        return false;
      });
      const record = shape(plural, a, c, w, id, fields);
      await ctx.store.put(entityKey(ctx.email, kind, a, c, w, id), record);
      return Response.json(record);
    },
    async update(ctx: FakeContext): Promise<Response> {
      const found = await loadWorkspace(ctx);
      if (found instanceof Response) return found;
      const { a, c, w } = found;
      const id = group(ctx, 4);
      const key = entityKey(ctx.email, kind, a, c, w, id);
      const current = await ctx.store.get<Entity>(key);
      if (!current) return missing();
      const wanted = ctx.url.searchParams.get("fingerprint");
      if (wanted !== null && wanted !== current.fingerprint) return conflict("Fingerprint mismatch.", "conflict");
      const fields = await readEntity(ctx, plural, a, c, w);
      if (fields instanceof Response) return fields;
      const record = shape(plural, a, c, w, id, fields);
      await ctx.store.put(key, record);
      return Response.json(record);
    },
    async remove(ctx: FakeContext): Promise<Response> {
      const found = await loadWorkspace(ctx);
      if (found instanceof Response) return found;
      const key = entityKey(ctx.email, kind, found.a, found.c, found.w, group(ctx, 4));
      return (await ctx.store.delete(key)) ? noContent() : missing();
    },
  };
};

// ---------- versions ----------

const ofKind = (snap: Snapshot, kind: string): Entity[] =>
  Object.entries(snap)
    .filter(([name]) => name.startsWith(`${kind}/`))
    .map(([, e]) => e);

/** Saves the workspace as a new version, deletes the workspace and opens a fresh one on the new version, as Google does. */
async function createVersion(ctx: FakeContext): Promise<Response> {
  const found = await loadWorkspace(ctx);
  if (found instanceof Response) return found;
  const { a, c, w, workspace } = found;
  const container = await ctx.store.get<Entity>(containerKey(ctx.email, a, c));
  const body = await readJsonObject(ctx.req);
  if (!body || !container) return invalid("Invalid JSON payload received.");
  for (const field of ["name", "notes"]) if (body[field] !== undefined && typeof body[field] !== "string") return invalid(`${field} must be a string.`);

  const id = await nextId(ctx, a, c, "version", (n) => ctx.store.get(versionKey(ctx.email, a, c, n)).then((v) => v !== undefined));
  const snap = await snapshotOf(ctx, a, c, w);
  const version = withFingerprint({
    path: `${containerPath(a, c)}/versions/${id}`,
    accountId: a,
    containerId: c,
    containerVersionId: id,
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(typeof body.notes === "string" ? { description: body.notes } : {}),
    container,
    tag: ofKind(snap, "tag"),
    trigger: ofKind(snap, "trigger"),
    variable: ofKind(snap, "variable"),
    tagManagerUrl: `${UI}${containerPath(a, c)}/versions/${id}`,
  });
  await ctx.store.put(versionKey(ctx.email, a, c, id), version);

  await deleteWorkspaceData(ctx, a, c, w);
  const fresh = await nextId(ctx, a, c, "workspace", (n) => ctx.store.get(workspaceKey(ctx.email, a, c, n)).then((v) => v !== undefined));
  const record = workspaceRecord(a, c, fresh, String(workspace.name), typeof workspace.description === "string" ? workspace.description : undefined);
  await ctx.store.put(workspaceKey(ctx.email, a, c, fresh), record);
  await putSnapshot(ctx, a, c, fresh, snap);
  await ctx.store.put(baselineKey(ctx.email, a, c, fresh), await snapshotOf(ctx, a, c, fresh));
  return Response.json({ containerVersion: version, newWorkspacePath: workspacePath(a, c, fresh), compilerError: false });
}

async function publishVersion(ctx: FakeContext): Promise<Response> {
  const found = await loadContainer(ctx);
  if (found instanceof Response) return found;
  const { a, c } = found;
  const id = group(ctx, 3);
  const version = await ctx.store.get<Entity>(versionKey(ctx.email, a, c, id));
  if (!version) return missing();
  const wanted = ctx.url.searchParams.get("fingerprint");
  if (wanted !== null && wanted !== version.fingerprint) return conflict("Fingerprint mismatch.", "conflict");
  await ctx.store.put(liveKey(ctx.email, a, c), { containerVersionId: id });
  return Response.json({ containerVersion: version, compilerError: false });
}

// ---------- user permissions ----------

async function listPermissions(ctx: FakeContext): Promise<Response> {
  const a = group(ctx, 1);
  if (!(await ctx.store.get(accountKey(ctx.email, a)))) return missing();
  const all = (await ctx.store.list<Entity>(`tagmanager:permission:${ctx.email}:${a}/`)).map(([, v]) => v);
  const paged = pageOf(ctx, all);
  return paged instanceof Response ? paged : listBody("userPermission", paged.page, paged);
}

async function updatePermission(ctx: FakeContext): Promise<Response> {
  const a = group(ctx, 1);
  const key = permissionKey(ctx.email, a, group(ctx, 2));
  const current = await ctx.store.get<Entity>(key);
  if (!current) return missing();
  const body = await readJsonObject(ctx.req);
  if (!body) return invalid("Invalid JSON payload received.");
  if (body.emailAddress !== undefined && body.emailAddress !== current.emailAddress) return invalid("emailAddress cannot be changed.");
  const access = body.accountAccess;
  const permission = typeof access === "object" && access !== null && !Array.isArray(access) ? (access as Record<string, unknown>).permission : undefined;
  if (typeof permission !== "string" || !ACCOUNT_PERMISSIONS.includes(permission)) return invalid("accountAccess.permission must be noAccess, user or admin.");
  const containerAccess: JsonValue[] = [];
  for (const item of Array.isArray(body.containerAccess) ? body.containerAccess : body.containerAccess === undefined ? [] : [null]) {
    const row = typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined;
    if (!row || typeof row.containerId !== "string" || typeof row.permission !== "string" || !CONTAINER_PERMISSIONS.includes(row.permission)) {
      return invalid("containerAccess must list containerId and a permission of noAccess, read, edit, approve or publish.");
    }
    if (!(await ctx.store.get(containerKey(ctx.email, a, row.containerId)))) return invalid(`Unknown container ${row.containerId}.`);
    containerAccess.push({ containerId: row.containerId, permission: row.permission });
  }
  const record: Entity = { ...current, accountAccess: { permission }, containerAccess };
  await ctx.store.put(key, record);
  return Response.json(record);
}

// ---------- routes ----------

const T = "https://www.googleapis.com/auth/tagmanager.";
/** Scopes per route: the Discovery `scopes` of the method (checked against the generated SDK in tests). */
const SCOPES = {
  accounts: [`${T}edit.containers`, `${T}manage.accounts`, `${T}readonly`],
  read: [`${T}edit.containers`, `${T}readonly`],
  edit: [`${T}edit.containers`],
  versions: [`${T}edit.containerversions`],
  publish: [`${T}publish`],
  delete: [`${T}delete.containers`],
  users: [`${T}manage.users`],
};

const BASE = "^/tagmanager\\.googleapis\\.com/tagmanager/v2/accounts";
const ACCOUNT = "([^/:]+)";
const CONTAINER = `${BASE}/${ACCOUNT}/containers/([^/:]+)`;
const WORKSPACE = `${CONTAINER}/workspaces/([^/:]+)`;
const re = (source: string) => new RegExp(`${source}$`);

const entityRoutes = (plural: EntityPlural): FakeRoute[] => {
  const h = entityRoute(plural);
  return [
    { method: "GET", pattern: re(`${WORKSPACE}/${plural}`), scopes: SCOPES.read, handle: h.list },
    { method: "POST", pattern: re(`${WORKSPACE}/${plural}`), scopes: SCOPES.edit, handle: h.create },
    { method: "PUT", pattern: re(`${WORKSPACE}/${plural}/([^/:]+)`), scopes: SCOPES.edit, handle: h.update },
    { method: "DELETE", pattern: re(`${WORKSPACE}/${plural}/([^/:]+)`), scopes: SCOPES.edit, handle: h.remove },
  ];
};

export const routes: FakeRoute[] = [
  { method: "GET", pattern: re(BASE), scopes: SCOPES.accounts, handle: listAccounts },
  { method: "GET", pattern: re(`${BASE}/${ACCOUNT}/containers`), scopes: SCOPES.read, handle: listContainers },
  { method: "GET", pattern: re(CONTAINER), scopes: SCOPES.read, handle: getContainer },
  { method: "DELETE", pattern: re(CONTAINER), scopes: SCOPES.delete, handle: deleteContainer },
  { method: "GET", pattern: re(`${CONTAINER}/workspaces`), scopes: SCOPES.read, handle: listWorkspaces },
  { method: "POST", pattern: re(`${CONTAINER}/workspaces`), scopes: SCOPES.edit, handle: createWorkspace },
  { method: "GET", pattern: re(WORKSPACE), scopes: SCOPES.read, handle: getWorkspace },
  { method: "GET", pattern: re(`${WORKSPACE}/status`), scopes: SCOPES.read, handle: workspaceStatus },
  { method: "POST", pattern: re(`${WORKSPACE}:create_version`), scopes: SCOPES.versions, handle: createVersion },
  ...entityRoutes("tags"),
  ...entityRoutes("triggers"),
  ...entityRoutes("variables"),
  { method: "POST", pattern: re(`${CONTAINER}/versions/([^/:]+):publish`), scopes: SCOPES.publish, handle: publishVersion },
  { method: "GET", pattern: re(`${BASE}/${ACCOUNT}/user_permissions`), scopes: SCOPES.users, handle: listPermissions },
  { method: "PUT", pattern: re(`${BASE}/${ACCOUNT}/user_permissions/([^/:]+)`), scopes: SCOPES.users, handle: updatePermission },
];

// ---------- seed presets ----------

const ACCOUNT_ID = "6001001001";
const WEB = "9001001";
const SPARE = "9001002";
const WS = "1";
const rec = (kind: string, id: string, value: Entity) => ({ key: `tagmanager:${kind}:{email}:${id}`, value: withFingerprint(value) });

const container = (id: string, name: string, publicId: string, notes: string): Entity => ({
  path: containerPath(ACCOUNT_ID, id),
  accountId: ACCOUNT_ID,
  containerId: id,
  name,
  domainName: ["example.test"],
  publicId,
  tagIds: [publicId],
  usageContext: ["web"],
  notes,
  tagManagerUrl: `${UI}${containerPath(ACCOUNT_ID, id)}`,
});

const tag: Entity = {
  path: `${workspacePath(ACCOUNT_ID, WEB, WS)}/tags/1`,
  accountId: ACCOUNT_ID,
  containerId: WEB,
  workspaceId: WS,
  tagId: "1",
  name: "Page view pixel",
  type: "html",
  parameter: [{ type: "template", key: "html", value: "<script>window.seen = true;</script>" }],
  firingTriggerId: ["1"],
  tagFiringOption: "oncePerEvent",
  tagManagerUrl: `${UI}${workspacePath(ACCOUNT_ID, WEB, WS)}/tags/1?apiLink=tag`,
};
const trigger: Entity = {
  path: `${workspacePath(ACCOUNT_ID, WEB, WS)}/triggers/1`,
  accountId: ACCOUNT_ID,
  containerId: WEB,
  workspaceId: WS,
  triggerId: "1",
  name: "All pages",
  type: "pageview",
  tagManagerUrl: `${UI}${workspacePath(ACCOUNT_ID, WEB, WS)}/triggers/1?apiLink=trigger`,
};
const variable: Entity = {
  path: `${workspacePath(ACCOUNT_ID, WEB, WS)}/variables/1`,
  accountId: ACCOUNT_ID,
  containerId: WEB,
  workspaceId: WS,
  variableId: "1",
  name: "Page host",
  type: "u",
  parameter: [{ type: "template", key: "component", value: "HOST" }],
  tagManagerUrl: `${UI}${workspacePath(ACCOUNT_ID, WEB, WS)}/variables/1?apiLink=variable`,
};

const webContainer = withFingerprint(container(WEB, "Example site", "GTM-AB12CD", "The public website"));
const liveVersion = withFingerprint({
  path: `${containerPath(ACCOUNT_ID, WEB)}/versions/1`,
  accountId: ACCOUNT_ID,
  containerId: WEB,
  containerVersionId: "1",
  name: "Launch",
  description: "First published version",
  container: webContainer,
  tag: [withFingerprint(tag)],
  trigger: [withFingerprint(trigger)],
  variable: [withFingerprint(variable)],
  tagManagerUrl: `${UI}${containerPath(ACCOUNT_ID, WEB)}/versions/1`,
});

const workspaceSeed = (containerId: string, id: string): Entity => ({
  path: workspacePath(ACCOUNT_ID, containerId, id),
  accountId: ACCOUNT_ID,
  containerId,
  workspaceId: id,
  name: "Default Workspace",
  description: "The default workspace",
  tagManagerUrl: `${UI}${workspacePath(ACCOUNT_ID, containerId, id)}`,
});

const permission = (id: string, emailAddress: string, access: string, containerAccess: Array<[string, string]>) =>
  ({
    key: `tagmanager:permission:{email}:${ACCOUNT_ID}/${id}`,
    value: {
      path: `${accountPath(ACCOUNT_ID)}/user_permissions/${id}`,
      accountId: ACCOUNT_ID,
      emailAddress,
      accountAccess: { permission: access },
      containerAccess: containerAccess.map(([containerId, p]) => ({ containerId, permission: p })),
    },
  });

/**
 * `default`: one account (`6001001001`) with two containers. `GTM-AB12CD` (id `9001001`) has a live version 1 and
 * a default workspace holding its tag, trigger and variable with no pending changes. `GTM-EF34GH` (id `9001002`) is
 * an empty spare. The account is its own admin, and `dana@fake.test` can edit the website container.
 */
export const presets: SeedPresets = {
  default: [
    rec("account", ACCOUNT_ID, {
      path: accountPath(ACCOUNT_ID),
      accountId: ACCOUNT_ID,
      name: "Example Company",
      shareData: false,
      features: { supportUserPermissions: true, supportMultipleContainers: true },
      tagManagerUrl: `https://tagmanager.google.com/#/admin/accounts/${ACCOUNT_ID}`,
    }),
    { key: `tagmanager:container:{email}:${ACCOUNT_ID}/${WEB}`, value: webContainer },
    rec("container", `${ACCOUNT_ID}/${SPARE}`, container(SPARE, "Spare container", "GTM-EF34GH", "Not used yet")),
    { key: `tagmanager:version:{email}:${ACCOUNT_ID}/${WEB}/1`, value: liveVersion },
    { key: `tagmanager:live:{email}:${ACCOUNT_ID}/${WEB}`, value: { containerVersionId: "1" } },
    { key: `tagmanager:seq:{email}:${ACCOUNT_ID}/${WEB}`, value: { tag: 1, trigger: 1, variable: 1, workspace: 1, version: 1 } },
    rec("workspace", `${ACCOUNT_ID}/${WEB}/${WS}`, workspaceSeed(WEB, WS)),
    { key: `tagmanager:tag:{email}:${ACCOUNT_ID}/${WEB}/${WS}/1`, value: withFingerprint(tag) },
    { key: `tagmanager:trigger:{email}:${ACCOUNT_ID}/${WEB}/${WS}/1`, value: withFingerprint(trigger) },
    { key: `tagmanager:variable:{email}:${ACCOUNT_ID}/${WEB}/${WS}/1`, value: withFingerprint(variable) },
    {
      key: `tagmanager:baseline:{email}:${ACCOUNT_ID}/${WEB}/${WS}`,
      value: { "tag/1": withFingerprint(tag), "trigger/1": withFingerprint(trigger), "variable/1": withFingerprint(variable) },
    },
    rec("workspace", `${ACCOUNT_ID}/${SPARE}/${WS}`, workspaceSeed(SPARE, WS)),
    { key: `tagmanager:baseline:{email}:${ACCOUNT_ID}/${SPARE}/${WS}`, value: {} },
    { key: `tagmanager:seq:{email}:${ACCOUNT_ID}/${SPARE}`, value: { tag: 0, trigger: 0, variable: 0, workspace: 1, version: 0 } },
    permission("1000000001", "{email}", "admin", [[WEB, "publish"], [SPARE, "publish"]]),
    permission("1000000002", "dana@fake.test", "user", [[WEB, "edit"]]),
  ],
};
