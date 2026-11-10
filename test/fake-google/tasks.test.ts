import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import tasklistsInsert from "../../fake-google/fixtures/tasks/tasklists-insert.json";
import tasklistsList from "../../fake-google/fixtures/tasks/tasklists-list.json";
import tasksGet from "../../fake-google/fixtures/tasks/tasks-get.json";
import tasksInsert from "../../fake-google/fixtures/tasks/tasks-insert.json";
import tasksList from "../../fake-google/fixtures/tasks/tasks-list.json";
import tasksPatch from "../../fake-google/fixtures/tasks/tasks-patch.json";
import { DoStore, type KvBackend } from "../../fake-google/src/do-store";
import { parseFixture, type Fixture } from "../../fake-google/src/fixtures";
import type { FakeRoute } from "../../fake-google/src/routes/index";
import { routes } from "../../fake-google/src/routes/tasks";
import type { FakeStore } from "../../fake-google/src/store";
import { loadConfig } from "../../src/config";
import { googleOAuth } from "../../src/google/oauth";
import { createTransport } from "../../src/google/transport";
import { generatedFns } from "../../src/sdk/generated/index";
import { authorizeAtFake } from "../helpers/accounts";
import { fake, fakeFetch, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const TASKS = `${G}tasks`;
const TASKS_RO = `${G}tasks.readonly`;
const BASE = "/tasks.googleapis.com/tasks/v1";
const LISTS = `${BASE}/users/@me/lists`;
const SEED_LIST = "seed-tasklist-default";
const FIXTURE_EMAIL = "alice@fake.test";
/** Fixed clock for accounts whose writes are compared with fixtures. */
const NOW = Date.parse("2026-11-10T03:00:00.000Z");

const tasksPath = (list: string) => `${BASE}/lists/${list}/tasks`;
const taskPath = (list: string, task: string) => `${tasksPath(list)}/${task}`;

const transport = createTransport(env, loadConfig(env));

async function account(scopes: string[], email = uniqueEmail("tasks")) {
  await fake.seed({ accounts: [{ email, sub: "100000000000000000001", preset: "default" }], now: NOW });
  const tokens = await googleOAuth(env, transport).exchangeCode(await authorizeAtFake({ email, scopes }));
  return { email, token: tokens.accessToken };
}

function api(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fakeFetch(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
}

function send(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return api(token, path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

interface TaskView {
  kind: string;
  id: string;
  title: string;
  status: string;
  position: string;
  updated: string;
  notes?: string;
  due?: string;
  completed?: string;
  parent?: string;
  hidden?: boolean;
  deleted?: boolean;
}

interface ListPage<T> {
  kind: string;
  items: T[];
  nextPageToken?: string;
}

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status).toBe(status);
  return (await r.json()) as T;
}

const listTasks = (token: string, list: string, query = "") => json<ListPage<TaskView>>(api(token, `${tasksPath(list)}${query}`));

function outputSchema(fn: string) {
  const def = generatedFns.find((f) => f.name === fn);
  if (!def) throw new Error(`no generated fn ${fn}`);
  return def.output;
}

describe("scopes", () => {
  const ROUTES = [
    { fn: "tasks.tasklists.list", method: "GET", path: LISTS },
    { fn: "tasks.tasklists.insert", method: "POST", path: LISTS },
    { fn: "tasks.tasklists.get", method: "GET", path: `${LISTS}/${SEED_LIST}` },
    { fn: "tasks.tasklists.delete", method: "DELETE", path: `${LISTS}/${SEED_LIST}` },
    { fn: "tasks.tasks.list", method: "GET", path: tasksPath(SEED_LIST) },
    { fn: "tasks.tasks.insert", method: "POST", path: tasksPath(SEED_LIST) },
    { fn: "tasks.tasks.get", method: "GET", path: taskPath(SEED_LIST, "seed-task-1") },
    { fn: "tasks.tasks.patch", method: "PATCH", path: taskPath(SEED_LIST, "seed-task-1") },
    { fn: "tasks.tasks.update", method: "PUT", path: taskPath(SEED_LIST, "seed-task-1") },
    { fn: "tasks.tasks.delete", method: "DELETE", path: taskPath(SEED_LIST, "seed-task-1") },
    { fn: "tasks.tasks.clear", method: "POST", path: `${BASE}/lists/${SEED_LIST}/clear` },
  ] as const;

  it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))("%s requires exactly the method's Discovery scopes", (_name, r) => {
    const route = routes.find((x) => x.method === r.method && x.pattern.test(r.path));
    expect(route, r.fn).toBeDefined();
    const meta = generatedFns.find((f) => f.name === r.fn)?.method;
    expect([...(route?.scopes ?? [])].sort()).toEqual([...(meta?.scopes ?? [])].sort());
  });

  it("refuses each route for a token without any of its scopes", async () => {
    const { token } = await account([`${G}calendar.events`]);
    for (const r of ROUTES) {
      const res = await api(token, r.path, { method: r.method });
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      const body = (await res.json()) as { error: { details: Array<{ reason: string }> } };
      expect(body.error.details[0]?.reason).toBe("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    }
  });

  it("lets tasks.readonly read but not write", async () => {
    const { token } = await account([TASKS_RO]);
    expect((await api(token, LISTS)).status).toBe(200);
    expect((await api(token, tasksPath(SEED_LIST))).status).toBe(200);
    expect((await send(token, "POST", tasksPath(SEED_LIST), { title: "x" })).status).toBe(403);
  });
});

describe("tasklists", () => {
  it("lists the seeded default list, also reachable as @default", async () => {
    const { token } = await account([TASKS]);
    const page = await json<ListPage<{ id: string; title: string; kind: string }>>(api(token, LISTS));
    expect(page.kind).toBe("tasks#taskLists");
    expect(page.items.map((l) => [l.id, l.title])).toEqual([[SEED_LIST, "My Tasks"]]);
    expect(outputSchema("tasks.tasklists.list").safeParse(page).success).toBe(true);

    for (const alias of ["@default", "%40default"]) {
      const list = await json<{ id: string }>(api(token, `${LISTS}/${alias}`));
      expect(list.id).toBe(SEED_LIST);
    }
  });

  it("inserts a list that a get and the listing then show, and pages with maxResults", async () => {
    const { token } = await account([TASKS]);
    const created = await json<{ id: string; title: string; kind: string; updated: string }>(send(token, "POST", LISTS, { title: "Errands" }));
    expect(created).toMatchObject({ kind: "tasks#taskList", title: "Errands", updated: new Date(NOW).toISOString() });
    expect(outputSchema("tasks.tasklists.insert").safeParse(created).success).toBe(true);
    expect(await json(api(token, `${LISTS}/${created.id}`))).toEqual(created);

    const first = await json<ListPage<{ id: string }>>(api(token, `${LISTS}?maxResults=1`));
    expect(first.items).toHaveLength(1);
    expect(first.nextPageToken).toBeDefined();
    const second = await json<ListPage<{ id: string }>>(api(token, `${LISTS}?maxResults=1&pageToken=${first.nextPageToken}`));
    expect(second.nextPageToken).toBeUndefined();
    expect([...first.items, ...second.items].map((l) => l.id).sort()).toEqual([created.id, SEED_LIST].sort());
  });

  it("deletes a list with its tasks, but never the default list", async () => {
    const { token } = await account([TASKS]);
    const { id } = await json<{ id: string }>(send(token, "POST", LISTS, { title: "Trip" }));
    await json(send(token, "POST", tasksPath(id), { title: "Pack" }));
    const del = await send(token, "DELETE", `${LISTS}/${id}`);
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    expect((await api(token, `${LISTS}/${id}`)).status).toBe(404);
    expect((await api(token, tasksPath(id))).status).toBe(404);

    expect((await send(token, "DELETE", `${LISTS}/${SEED_LIST}`)).status).toBe(400);
    expect((await send(token, "DELETE", `${LISTS}/@default`)).status).toBe(400);
    expect((await api(token, `${LISTS}/${SEED_LIST}`)).status).toBe(200);
  });

  it("rejects a list without a title and bad paging, and 404s an unknown list", async () => {
    const { token } = await account([TASKS]);
    expect((await send(token, "POST", LISTS, {})).status).toBe(400);
    expect((await send(token, "POST", LISTS, { title: 3 })).status).toBe(400);
    expect((await send(token, "POST", LISTS, { title: "x".repeat(1025) })).status).toBe(400);
    expect((await api(token, `${LISTS}?maxResults=0`)).status).toBe(400);
    expect((await api(token, `${LISTS}?pageToken=abc`)).status).toBe(400);
    expect((await api(token, `${LISTS}/nope`)).status).toBe(404);
    expect((await send(token, "DELETE", `${LISTS}/nope`)).status).toBe(404);
  });
});

describe("tasks", () => {
  it("lists the seeded tasks in position order", async () => {
    const { token } = await account([TASKS]);
    const page = await listTasks(token, SEED_LIST);
    expect(page.kind).toBe("tasks#tasks");
    expect(page.items.map((t) => [t.id, t.title, t.status, t.position])).toEqual([
      ["seed-task-1", "Book flights", "needsAction", "00000000000000000000"],
      ["seed-task-2", "Send weekly report", "completed", "00000000000000000001"],
    ]);
    expect(outputSchema("tasks.tasks.list").safeParse(page).success).toBe(true);
  });

  it("inserts at the top by default, after `previous`, and under `parent`; a get returns the same task", async () => {
    const { token } = await account([TASKS]);
    const top = await json<TaskView>(send(token, "POST", tasksPath("@default"), { title: "Call the venue", notes: "Ask about parking", due: "2026-11-14T10:30:00+07:00" }));
    expect(top).toMatchObject({ kind: "tasks#task", title: "Call the venue", status: "needsAction", notes: "Ask about parking", position: "00000000000000000000" });
    // Tasks records the due date only.
    expect(top.due).toBe("2026-11-14T00:00:00.000Z");
    expect(outputSchema("tasks.tasks.insert").safeParse(top).success).toBe(true);
    expect(await json(api(token, taskPath(SEED_LIST, top.id)))).toEqual(top);

    const after = await json<TaskView>(send(token, "POST", `${tasksPath(SEED_LIST)}?previous=seed-task-1`, { title: "Renew passport" }));
    const child = await json<TaskView>(send(token, "POST", `${tasksPath(SEED_LIST)}?parent=seed-task-1`, { title: "Compare fares" }));
    expect(child.parent).toBe("seed-task-1");
    expect(child.position).toBe("00000000000000000000");

    const page = await listTasks(token, SEED_LIST);
    const topLevel = page.items.filter((t) => t.parent === undefined);
    expect(topLevel.map((t) => [t.id, t.position])).toEqual([
      [top.id, "00000000000000000000"],
      ["seed-task-1", "00000000000000000001"],
      [after.id, "00000000000000000002"],
      ["seed-task-2", "00000000000000000003"],
    ]);
    expect(page.items.map((t) => t.id)).toContain(child.id);
  });

  it("patches only the given fields; completing sets `completed` and reopening clears it", async () => {
    const { token } = await account([TASKS]);
    const done = await json<TaskView>(send(token, "PATCH", taskPath(SEED_LIST, "seed-task-1"), { status: "completed" }));
    expect(done).toMatchObject({ title: "Book flights", notes: "Hanoi trip", status: "completed", completed: new Date(NOW).toISOString() });
    expect(outputSchema("tasks.tasks.patch").safeParse(done).success).toBe(true);
    expect(await json(api(token, taskPath(SEED_LIST, "seed-task-1")))).toEqual(done);

    const reopened = await json<TaskView>(send(token, "PATCH", taskPath(SEED_LIST, "seed-task-1"), { status: "needsAction", notes: null }));
    expect(reopened.completed).toBeUndefined();
    expect(reopened.notes).toBeUndefined();
    expect(reopened.title).toBe("Book flights");
  });

  it("update replaces the writable fields", async () => {
    const { token } = await account([TASKS]);
    const updated = await json<TaskView>(send(token, "PUT", taskPath(SEED_LIST, "seed-task-1"), { title: "Book trains" }));
    expect(updated).toMatchObject({ id: "seed-task-1", title: "Book trains", status: "needsAction" });
    expect(updated.notes).toBeUndefined();
    expect(updated.due).toBeUndefined();
    expect(outputSchema("tasks.tasks.update").safeParse(updated).success).toBe(true);
    expect(await json(api(token, taskPath(SEED_LIST, "seed-task-1")))).toEqual(updated);
  });

  it("deletes a task and its subtasks: hidden from the listing unless showDeleted", async () => {
    const { token } = await account([TASKS]);
    const child = await json<TaskView>(send(token, "POST", `${tasksPath(SEED_LIST)}?parent=seed-task-1`, { title: "Compare fares" }));
    const del = await send(token, "DELETE", taskPath(SEED_LIST, "seed-task-1"));
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    expect((await listTasks(token, SEED_LIST)).items.map((t) => t.id)).toEqual(["seed-task-2"]);
    const withDeleted = await listTasks(token, SEED_LIST, "?showDeleted=true");
    expect(withDeleted.items.filter((t) => t.deleted).map((t) => t.id).sort()).toEqual([child.id, "seed-task-1"].sort());
    expect((await json<TaskView>(api(token, taskPath(SEED_LIST, "seed-task-1")))).deleted).toBe(true);
  });

  it("clear hides completed tasks; showHidden and showCompleted filter the listing", async () => {
    const { token } = await account([TASKS]);
    expect((await listTasks(token, SEED_LIST, "?showCompleted=false")).items.map((t) => t.id)).toEqual(["seed-task-1"]);
    const res = await send(token, "POST", `${BASE}/lists/${SEED_LIST}/clear`);
    expect(res.status).toBe(204);
    expect((await listTasks(token, SEED_LIST)).items.map((t) => t.id)).toEqual(["seed-task-1"]);
    const hidden = await listTasks(token, SEED_LIST, "?showHidden=true");
    expect(hidden.items.find((t) => t.id === "seed-task-2")).toMatchObject({ hidden: true, status: "completed" });
  });

  it("filters by due date and pages with maxResults", async () => {
    const { token } = await account([TASKS]);
    const due = await listTasks(token, SEED_LIST, `?dueMin=${encodeURIComponent("2026-11-12T00:00:00Z")}`);
    expect(due.items.map((t) => t.id)).toEqual(["seed-task-1"]);
    expect((await listTasks(token, SEED_LIST, `?dueMax=${encodeURIComponent("2026-11-12T00:00:00Z")}`)).items).toEqual([]);

    const first = await listTasks(token, SEED_LIST, "?maxResults=1");
    expect(first.items.map((t) => t.id)).toEqual(["seed-task-1"]);
    expect(first.nextPageToken).toBeDefined();
    const second = await listTasks(token, SEED_LIST, `?maxResults=1&pageToken=${first.nextPageToken}`);
    expect(second.items.map((t) => t.id)).toEqual(["seed-task-2"]);
    expect(second.nextPageToken).toBeUndefined();
  });

  it("returns Google-shaped 400s and 404s", async () => {
    const { token } = await account([TASKS]);
    const bad: Array<[string, string, unknown?]> = [
      ["POST", tasksPath(SEED_LIST), { status: "done" }],
      ["POST", tasksPath(SEED_LIST), { title: 5 }],
      ["POST", tasksPath(SEED_LIST), { due: "tomorrow" }],
      ["POST", `${tasksPath(SEED_LIST)}?previous=nope`, { title: "x" }],
      ["POST", `${tasksPath(SEED_LIST)}?parent=nope`, { title: "x" }],
      ["PATCH", taskPath(SEED_LIST, "seed-task-1"), { notes: 7 }],
      ["GET", `${tasksPath(SEED_LIST)}?showCompleted=maybe`],
      ["GET", `${tasksPath(SEED_LIST)}?maxResults=-1`],
      ["GET", `${tasksPath(SEED_LIST)}?dueMin=soon`],
    ];
    for (const [method, path, body] of bad) {
      const res = await send(token, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(((await res.json()) as { error: { status: string } }).error.status).toBe("INVALID_ARGUMENT");
    }
    expect((await api(token, taskPath(SEED_LIST, "nope"))).status).toBe(404);
    expect((await api(token, tasksPath("nope"))).status).toBe(404);
    expect((await send(token, "DELETE", taskPath(SEED_LIST, "nope"))).status).toBe(404);
    // A task is only reachable through its own list.
    const { id } = await json<{ id: string }>(send(token, "POST", LISTS, { title: "Other" }));
    expect((await api(token, taskPath(id, "seed-task-1"))).status).toBe(404);
  });
});

describe("Durable Object state", () => {
  /** Durable Object storage semantics in memory: values are cloned on write and read, keys list in order. */
  function memoryBackend(): KvBackend {
    const data = new Map<string, unknown>();
    const keys = (prefix: string) => [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
    return {
      getOne: async (k) => structuredClone(data.get(k)),
      getMany: async (ks) => new Map(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))])),
      list: async (prefix, limit) => new Map(keys(prefix).slice(0, limit).map((k) => [k, structuredClone(data.get(k))])),
      putMany: async (entries) => {
        for (const [k, v] of Object.entries(entries)) data.set(k, structuredClone(v));
      },
      deleteMany: async (ks) => ks.filter((k) => data.delete(k)).length,
    };
  }

  async function call(store: FakeStore, method: FakeRoute["method"], path: string, body?: unknown): Promise<Response> {
    const url = new URL(`http://fake-google${path}`);
    const route = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
    const match = route?.pattern.exec(url.pathname);
    if (!route || !match) throw new Error(`no route for ${method} ${path}`);
    const init = body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    const req = new Request(url, { method, ...init });
    return route.handle({ req, url, path: url.pathname, match, store, email: "do@fake.test", scopes: [TASKS], now: () => NOW });
  }

  it("keeps lists and tasks in a DoStore, so a write is observed by a following read", async () => {
    const store = new DoStore(memoryBackend(), { chunkChars: 200 });
    const list = await json<{ id: string }>(call(store, "POST", LISTS, { title: "Durable" }));
    const task = await json<TaskView>(call(store, "POST", tasksPath(list.id), { title: "Persist me", notes: "n".repeat(500) }));
    await json(call(store, "PATCH", taskPath(list.id, task.id), { status: "completed" }));
    const page = await json<ListPage<TaskView>>(call(store, "GET", tasksPath(list.id)));
    expect(page.items.map((t) => [t.id, t.status, t.notes?.length])).toEqual([[task.id, "completed", 500]]);
  });
});

describe("fixtures", () => {
  it("are what the fake serves for a seeded account, replayed in order", async () => {
    const email = uniqueEmail("tasks-replay");
    const { token } = await account([TASKS], email);
    const steps: Array<[Fixture, unknown?]> = [
      [parseFixture(tasklistsList)],
      [parseFixture(tasksList)],
      [parseFixture(tasksGet)],
      [parseFixture(tasksInsert), { title: "Call the venue", due: "2026-11-14T00:00:00.000Z" }],
      [parseFixture(tasksPatch), { status: "completed" }],
      [parseFixture(tasklistsInsert), { title: "Errands" }],
    ];
    for (const [fx, body] of steps) {
      const query = new URLSearchParams(fx.request.query as Record<string, string> | undefined).toString();
      const res = await send(token, fx.request.method, `${fx.request.path}${query ? `?${query}` : ""}`, body);
      expect(res.status, fx.id).toBe(fx.response.status);
      const actual = JSON.parse((await res.text()).replaceAll(email, FIXTURE_EMAIL)) as Record<string, unknown>;
      const expected = { ...(fx.response.body as Record<string, unknown>) };
      if (fx.id === "tasks-tasks-insert" || fx.id === "tasks-tasklists-insert") {
        // A new resource has a fresh id, and its links carry it.
        for (const k of ["id", "selfLink", "webViewLink"]) {
          delete actual[k];
          delete expected[k];
        }
      }
      expect(actual, fx.id).toEqual(expected);
    }
  });
});
