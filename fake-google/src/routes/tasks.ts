import { googleError, randomToken } from "../oauth";
import { fakeKey, type JsonValue } from "../store";
import type { FakeContext, FakeRoute, SeedPresets } from "./index";

// ---------- model ----------

/**
 * Stored at `tasks:tasklist:<email>:<id>`. `order` holds every task id of the list in display order
 * (subtasks right after their parent); positions are computed from it per sibling group.
 */
interface TaskListRecord {
  [key: string]: JsonValue;
  id: string;
  title: string;
  updated: string;
  version: number;
  /** The list `@default` names; it cannot be deleted. */
  isDefault: boolean;
  order: string[];
}

/**
 * Stored at `tasks:task:<email>:<listId>/<taskId>`. A deleted task is kept with `deleted: true`.
 * Optional string fields: `parent`, `notes`, `due`, `completed` (read with `field`).
 */
interface TaskRecord {
  [key: string]: JsonValue;
  id: string;
  title: string;
  status: "needsAction" | "completed";
  updated: string;
  version: number;
  hidden: boolean;
  deleted: boolean;
}

const MAX_TITLE = 1024;
const MAX_NOTES = 8192;
const TASKS_PAGE = { default: 20, max: 100 };
const LISTS_PAGE = { default: 1000, max: 1000 };
const DEFAULT_ALIAS = "@default";

const listKey = (email: string, id: string) => fakeKey("tasks", "tasklist", email, id);
const listPrefix = (email: string) => `tasks:tasklist:${email}:`;
const taskKey = (email: string, listId: string, id: string) => fakeKey("tasks", "task", email, `${listId}/${id}`);
const taskPrefix = (email: string, listId: string) => `tasks:task:${email}:${listId}/`;

/** An optional string field of a task record. */
const field = (rec: TaskRecord, k: "parent" | "notes" | "due" | "completed") => (typeof rec[k] === "string" ? (rec[k] as string) : undefined);

const etag = (version: number) => `"fake-${version}"`;
const iso = (ms: number) => new Date(ms).toISOString();

function renderList(rec: TaskListRecord): Record<string, JsonValue> {
  return {
    kind: "tasks#taskList",
    id: rec.id,
    etag: etag(rec.version),
    title: rec.title,
    updated: rec.updated,
    selfLink: `https://www.googleapis.com/tasks/v1/users/@me/lists/${rec.id}`,
  };
}

/** Position among the task's siblings (same parent), as Google's zero-padded 20-digit string. */
function position(list: TaskListRecord, tasks: Map<string, TaskRecord>, task: TaskRecord): string {
  const parent = field(task, "parent");
  const siblings = list.order.filter((id) => {
    const t = tasks.get(id);
    return t !== undefined && field(t, "parent") === parent;
  });
  return String(Math.max(0, siblings.indexOf(task.id))).padStart(20, "0");
}

function renderTask(listId: string, rec: TaskRecord, pos: string): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {
    kind: "tasks#task",
    id: rec.id,
    etag: etag(rec.version),
    title: rec.title,
    updated: rec.updated,
    selfLink: `https://www.googleapis.com/tasks/v1/lists/${listId}/tasks/${rec.id}`,
  };
  const parent = field(rec, "parent");
  if (parent !== undefined) out.parent = parent;
  out.position = pos;
  const notes = field(rec, "notes");
  if (notes !== undefined) out.notes = notes;
  out.status = rec.status;
  for (const k of ["due", "completed"] as const) {
    const v = field(rec, k);
    if (v !== undefined) out[k] = v;
  }
  if (rec.deleted) out.deleted = true;
  if (rec.hidden) out.hidden = true;
  out.links = [];
  out.webViewLink = `https://tasks.google.com/task/${rec.id}?sa=6`;
  return out;
}

// ---------- errors ----------

function notFound(id: string): Response {
  const message = "Requested entity was not found.";
  return googleError(404, message, "NOT_FOUND", { errors: [{ message: `${message} (${id})`, domain: "global", reason: "notFound" }] });
}

function badRequest(message: string, reason = "invalid"): Response {
  return googleError(400, message, "INVALID_ARGUMENT", { errors: [{ message, domain: "global", reason }] });
}

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

// ---------- query parameters ----------

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

function pageParams(url: URL, limits: { default: number; max: number }): Parsed<{ size: number; offset: number }> {
  const sizeRaw = url.searchParams.get("maxResults");
  const size = sizeRaw === null ? limits.default : Number(sizeRaw);
  if (!Number.isInteger(size) || size < 1) return { ok: false, response: badRequest("Invalid value for maxResults", "invalidParameter") };
  const tokenRaw = url.searchParams.get("pageToken");
  if (tokenRaw !== null && !/^\d{1,9}$/.test(tokenRaw)) return { ok: false, response: badRequest("Invalid pageToken", "invalidParameter") };
  return { ok: true, value: { size: Math.min(size, limits.max), offset: tokenRaw === null ? 0 : Number(tokenRaw) } };
}

function boolParam(url: URL, name: string, fallback: boolean): Parsed<boolean> {
  const raw = url.searchParams.get(name);
  if (raw === null) return { ok: true, value: fallback };
  if (raw !== "true" && raw !== "false") return { ok: false, response: badRequest(`Invalid value for ${name}: ${raw}`, "invalidParameter") };
  return { ok: true, value: raw === "true" };
}

function timeParam(url: URL, name: string): Parsed<number | undefined> {
  const raw = url.searchParams.get(name);
  if (raw === null) return { ok: true, value: undefined };
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return { ok: false, response: badRequest(`Invalid value for ${name}: ${raw}`, "invalidParameter") };
  return { ok: true, value: ms };
}

// ---------- state ----------

const listIdOf = (ctx: FakeContext) => decodeURIComponent(ctx.match[1] ?? "");
const taskIdOf = (ctx: FakeContext) => decodeURIComponent(ctx.match[2] ?? "");

/** The list a path names; `@default` is the account's default list. */
async function loadList(ctx: FakeContext, id: string): Promise<TaskListRecord | undefined> {
  if (id !== DEFAULT_ALIAS) return ctx.store.get<TaskListRecord>(listKey(ctx.email, id));
  const lists = await ctx.store.list<TaskListRecord>(listPrefix(ctx.email));
  return lists.map(([, l]) => l).find((l) => l.isDefault);
}

async function loadTasks(ctx: FakeContext, listId: string): Promise<Map<string, TaskRecord>> {
  return new Map((await ctx.store.list<TaskRecord>(taskPrefix(ctx.email, listId))).map(([, t]) => [t.id, t]));
}

async function saveTask(ctx: FakeContext, listId: string, rec: TaskRecord): Promise<void> {
  await ctx.store.put(taskKey(ctx.email, listId, rec.id), rec);
}

// ---------- task writes ----------

/** Google keeps the date of `due` only: the time of day is discarded. */
function dueDate(raw: string): string | undefined {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : `${iso(ms).slice(0, 10)}T00:00:00.000Z`;
}

/**
 * Applies the writable fields of a request body to `rec`. `replace` (update) clears fields the body omits;
 * otherwise (insert, patch) only given fields change, and `null` clears one. Returns an error message.
 */
function applyTaskFields(rec: TaskRecord, body: Record<string, unknown>, replace: boolean, now: number): string | undefined {
  const has = (k: string) => body[k] !== undefined;
  if (has("title") || replace) {
    const title = body.title ?? "";
    if (typeof title !== "string" || title.length > MAX_TITLE) return "Invalid value for title";
    rec.title = title;
  }
  for (const k of ["notes", "due"] as const) {
    if (!has(k) && !replace) continue;
    const v = body[k];
    if (v === undefined || v === null) {
      delete rec[k];
      continue;
    }
    if (typeof v !== "string") return `Invalid value for ${k}`;
    if (k === "notes") {
      if (v.length > MAX_NOTES) return "Invalid value for notes";
      rec.notes = v;
    } else {
      const due = dueDate(v);
      if (due === undefined) return `Invalid value for due: ${v}`;
      rec.due = due;
    }
  }
  if (has("status") || replace) {
    const status = body.status ?? "needsAction";
    if (status !== "needsAction" && status !== "completed") return `Invalid value for status: ${String(status)}`;
    rec.status = status;
  }
  if (rec.status === "completed") {
    const completed = body.completed;
    if (completed !== undefined && completed !== null) {
      if (typeof completed !== "string" || Number.isNaN(Date.parse(completed))) return "Invalid value for completed";
      rec.completed = iso(Date.parse(completed));
    } else if (field(rec, "completed") === undefined) {
      rec.completed = iso(now);
    }
  } else {
    delete rec.completed;
  }
  return undefined;
}

// ---------- tasklist handlers ----------

async function listLists(ctx: FakeContext): Promise<Response> {
  const page = pageParams(ctx.url, LISTS_PAGE);
  if (!page.ok) return page.response;
  const { size, offset } = page.value;
  const lists = (await ctx.store.list<TaskListRecord>(listPrefix(ctx.email))).map(([, l]) => l);
  // The default list comes first, as in Google Tasks.
  lists.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.updated.localeCompare(b.updated) || a.id.localeCompare(b.id));
  const items = lists.slice(offset, offset + size);
  const body: Record<string, JsonValue> = { kind: "tasks#taskLists", etag: '"fake-tasklists"' };
  if (offset + items.length < lists.length) body.nextPageToken = String(offset + items.length);
  body.items = items.map(renderList);
  return Response.json(body);
}

async function insertList(ctx: FakeContext): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.", "parseError");
  if (typeof body.title !== "string" || body.title === "" || body.title.length > MAX_TITLE) {
    return badRequest("Invalid value for title", "invalid");
  }
  const rec: TaskListRecord = {
    id: randomToken(16),
    title: body.title,
    updated: iso(ctx.now()),
    version: 1,
    isDefault: false,
    order: [],
  };
  await ctx.store.put(listKey(ctx.email, rec.id), rec);
  return Response.json(renderList(rec));
}

async function getList(ctx: FakeContext): Promise<Response> {
  const list = await loadList(ctx, listIdOf(ctx));
  return list ? Response.json(renderList(list)) : notFound(listIdOf(ctx));
}

async function deleteList(ctx: FakeContext): Promise<Response> {
  const list = await loadList(ctx, listIdOf(ctx));
  if (!list) return notFound(listIdOf(ctx));
  if (list.isDefault) return badRequest("The default task list cannot be deleted.", "invalid");
  for (const [key] of await ctx.store.list(taskPrefix(ctx.email, list.id))) await ctx.store.delete(key);
  await ctx.store.delete(listKey(ctx.email, list.id));
  return new Response(null, { status: 204 });
}

// ---------- task handlers ----------

async function listTasks(ctx: FakeContext): Promise<Response> {
  const list = await loadList(ctx, listIdOf(ctx));
  if (!list) return notFound(listIdOf(ctx));
  const page = pageParams(ctx.url, TASKS_PAGE);
  if (!page.ok) return page.response;
  const flags = { showCompleted: true, showHidden: false, showDeleted: false };
  for (const name of Object.keys(flags) as Array<keyof typeof flags>) {
    const v = boolParam(ctx.url, name, flags[name]);
    if (!v.ok) return v.response;
    flags[name] = v.value;
  }
  const bounds: Record<string, number | undefined> = {};
  for (const name of ["dueMin", "dueMax", "completedMin", "completedMax", "updatedMin"]) {
    const v = timeParam(ctx.url, name);
    if (!v.ok) return v.response;
    bounds[name] = v.value;
  }
  /** Lower bounds are inclusive, upper bounds exclusive; a task without the field never matches a bound. */
  const within = (value: string | undefined, min: number | undefined, max: number | undefined) => {
    if (min === undefined && max === undefined) return true;
    if (value === undefined) return false;
    const t = Date.parse(value);
    return (min === undefined || t >= min) && (max === undefined || t < max);
  };

  const tasks = await loadTasks(ctx, list.id);
  const shown = list.order
    .map((id) => tasks.get(id))
    .filter((t): t is TaskRecord => t !== undefined)
    .filter((t) => (flags.showDeleted || !t.deleted) && (flags.showHidden || !t.hidden) && (flags.showCompleted || t.status !== "completed"))
    .filter((t) => within(field(t, "due"), bounds.dueMin, bounds.dueMax))
    .filter((t) => within(field(t, "completed"), bounds.completedMin, bounds.completedMax))
    .filter((t) => within(t.updated, bounds.updatedMin, undefined));
  const { size, offset } = page.value;
  const items = shown.slice(offset, offset + size);
  const body: Record<string, JsonValue> = { kind: "tasks#tasks", etag: `"fake-tasks-${list.version}"` };
  if (offset + items.length < shown.length) body.nextPageToken = String(offset + items.length);
  body.items = items.map((t) => renderTask(list.id, t, position(list, tasks, t)));
  return Response.json(body);
}

async function getTask(ctx: FakeContext): Promise<Response> {
  const list = await loadList(ctx, listIdOf(ctx));
  if (!list) return notFound(listIdOf(ctx));
  const tasks = await loadTasks(ctx, list.id);
  const task = tasks.get(taskIdOf(ctx));
  return task ? Response.json(renderTask(list.id, task, position(list, tasks, task))) : notFound(taskIdOf(ctx));
}

async function insertTask(ctx: FakeContext): Promise<Response> {
  const list = await loadList(ctx, listIdOf(ctx));
  if (!list) return notFound(listIdOf(ctx));
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.", "parseError");
  const tasks = await loadTasks(ctx, list.id);
  /** A task of this list that is not deleted. */
  const live = (id: string | null) => {
    const t = id === null ? undefined : tasks.get(id);
    return t && !t.deleted ? t : undefined;
  };

  const parentId = ctx.url.searchParams.get("parent");
  const previousId = ctx.url.searchParams.get("previous");
  if (parentId !== null && !live(parentId)) return badRequest(`Invalid parent: ${parentId}`, "invalid");
  const previous = live(previousId);
  if (previousId !== null && (!previous || field(previous, "parent") !== (parentId ?? undefined))) {
    return badRequest(`Invalid previous: ${previousId}`, "invalid");
  }

  const now = ctx.now();
  const rec: TaskRecord = { id: randomToken(16), title: "", status: "needsAction", updated: iso(now), version: 1, hidden: false, deleted: false };
  const error = applyTaskFields(rec, body, false, now);
  if (error) return badRequest(error, "invalid");
  if (parentId !== null) rec.parent = parentId;

  // Without `previous` the task goes first among its siblings; with it, right after that sibling's subtasks.
  let at: number;
  if (previous) {
    at = list.order.indexOf(previous.id) + 1;
    while (at < list.order.length) {
      const next = tasks.get(list.order[at] ?? "");
      if (!next || field(next, "parent") !== previous.id) break;
      at++;
    }
  } else {
    at = parentId === null ? 0 : list.order.indexOf(parentId) + 1;
  }
  list.order.splice(at, 0, rec.id);
  list.version += 1;
  tasks.set(rec.id, rec);
  await saveTask(ctx, list.id, rec);
  await ctx.store.put(listKey(ctx.email, list.id), list);
  return Response.json(renderTask(list.id, rec, position(list, tasks, rec)));
}

/** PATCH (`replace` false) and PUT (`replace` true). */
async function writeTask(ctx: FakeContext, replace: boolean): Promise<Response> {
  const list = await loadList(ctx, listIdOf(ctx));
  if (!list) return notFound(listIdOf(ctx));
  const tasks = await loadTasks(ctx, list.id);
  const task = tasks.get(taskIdOf(ctx));
  if (!task) return notFound(taskIdOf(ctx));
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.", "parseError");
  const now = ctx.now();
  const error = applyTaskFields(task, body, replace, now);
  if (error) return badRequest(error, "invalid");
  task.updated = iso(now);
  task.version += 1;
  await saveTask(ctx, list.id, task);
  return Response.json(renderTask(list.id, task, position(list, tasks, task)));
}

async function deleteTask(ctx: FakeContext): Promise<Response> {
  const list = await loadList(ctx, listIdOf(ctx));
  if (!list) return notFound(listIdOf(ctx));
  const tasks = await loadTasks(ctx, list.id);
  const task = tasks.get(taskIdOf(ctx));
  if (!task) return notFound(taskIdOf(ctx));
  const updated = iso(ctx.now());
  // Deleting a task deletes its subtasks too.
  for (const t of tasks.values()) {
    if (t.id !== task.id && field(t, "parent") !== task.id) continue;
    if (t.deleted) continue;
    t.deleted = true;
    t.updated = updated;
    t.version += 1;
    await saveTask(ctx, list.id, t);
  }
  return new Response(null, { status: 204 });
}

async function clearList(ctx: FakeContext): Promise<Response> {
  const list = await loadList(ctx, listIdOf(ctx));
  if (!list) return notFound(listIdOf(ctx));
  const updated = iso(ctx.now());
  for (const t of (await loadTasks(ctx, list.id)).values()) {
    if (t.status !== "completed" || t.hidden || t.deleted) continue;
    t.hidden = true;
    t.updated = updated;
    t.version += 1;
    await saveTask(ctx, list.id, t);
  }
  return new Response(null, { status: 204 });
}

// ---------- routes ----------

const G = "https://www.googleapis.com/auth/";
const V1 = "^/tasks\\.googleapis\\.com/tasks/v1";
const LISTS = `${V1}/users/(?:@|%40)me/lists`;
const ID = "([^/]+)";

/** Scopes per route: the Discovery `scopes` of the method (checked against the generated SDK in tests). */
const SCOPES = {
  write: [`${G}tasks`],
  read: [`${G}tasks`, `${G}tasks.readonly`],
};

export const routes: FakeRoute[] = [
  { method: "GET", pattern: new RegExp(`${LISTS}$`), scopes: SCOPES.read, handle: listLists },
  { method: "POST", pattern: new RegExp(`${LISTS}$`), scopes: SCOPES.write, handle: insertList },
  { method: "GET", pattern: new RegExp(`${LISTS}/${ID}$`), scopes: SCOPES.read, handle: getList },
  { method: "DELETE", pattern: new RegExp(`${LISTS}/${ID}$`), scopes: SCOPES.write, handle: deleteList },
  { method: "POST", pattern: new RegExp(`${V1}/lists/${ID}/clear$`), scopes: SCOPES.write, handle: clearList },
  { method: "GET", pattern: new RegExp(`${V1}/lists/${ID}/tasks$`), scopes: SCOPES.read, handle: listTasks },
  { method: "POST", pattern: new RegExp(`${V1}/lists/${ID}/tasks$`), scopes: SCOPES.write, handle: insertTask },
  { method: "GET", pattern: new RegExp(`${V1}/lists/${ID}/tasks/${ID}$`), scopes: SCOPES.read, handle: getTask },
  { method: "PATCH", pattern: new RegExp(`${V1}/lists/${ID}/tasks/${ID}$`), scopes: SCOPES.write, handle: (ctx) => writeTask(ctx, false) },
  { method: "PUT", pattern: new RegExp(`${V1}/lists/${ID}/tasks/${ID}$`), scopes: SCOPES.write, handle: (ctx) => writeTask(ctx, true) },
  { method: "DELETE", pattern: new RegExp(`${V1}/lists/${ID}/tasks/${ID}$`), scopes: SCOPES.write, handle: deleteTask },
];

// ---------- seed preset ----------

const SEED_LIST = "seed-tasklist-default";
const SEEDED = "2026-11-01T09:00:00.000Z";

function seedTask(id: string, fields: Partial<TaskRecord>): { key: string; value: TaskRecord } {
  const value: TaskRecord = { id, title: "", status: "needsAction", updated: SEEDED, version: 1, hidden: false, deleted: false, ...fields };
  return { key: `tasks:task:{email}:${SEED_LIST}/${id}`, value };
}

/** The account's default list "My Tasks" (`@default`) with an open and a completed task. */
export const presets: SeedPresets = {
  default: [
    {
      key: `tasks:tasklist:{email}:${SEED_LIST}`,
      value: { id: SEED_LIST, title: "My Tasks", updated: SEEDED, version: 1, isDefault: true, order: ["seed-task-1", "seed-task-2"] },
    },
    seedTask("seed-task-1", { title: "Book flights", notes: "Hanoi trip", due: "2026-11-12T00:00:00.000Z" }),
    seedTask("seed-task-2", { title: "Send weekly report", status: "completed", completed: "2026-11-08T03:00:00.000Z" }),
  ],
};
