import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import presentationsBatchUpdate from "../../fake-google/fixtures/slides/presentations-batch-update.json";
import presentationsCreate from "../../fake-google/fixtures/slides/presentations-create.json";
import presentationsGet from "../../fake-google/fixtures/slides/presentations-get.json";
import { DoStore, type KvBackend } from "../../fake-google/src/do-store";
import { parseFixture, type Fixture } from "../../fake-google/src/fixtures";
import type { FakeRoute } from "../../fake-google/src/routes/index";
import { routes } from "../../fake-google/src/routes/slides";
import type { FakeStore } from "../../fake-google/src/store";
import { loadConfig } from "../../src/config";
import { googleOAuth } from "../../src/google/oauth";
import { createTransport } from "../../src/google/transport";
import { generatedFns } from "../../src/sdk/generated/index";
import { authorizeAtFake } from "../helpers/accounts";
import { fake, fakeFetch, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const PRESENTATIONS = `${G}presentations`;
const DRIVE_FILE = `${G}drive.file`;
const BASE = "/slides.googleapis.com/v1/presentations";
const DRIVE_FILES = "/www.googleapis.com/drive/v3/files";
const SEED = "seed-slides-template";
const PRESENTATION_MIME = "application/vnd.google-apps.presentation";
const FIXTURE_EMAIL = "alice@fake.test";

const transport = createTransport(env, loadConfig(env));

async function account(scopes: string[], opts: { email?: string; presets?: string[] } = {}) {
  const email = opts.email ?? uniqueEmail("slides");
  for (const preset of opts.presets ?? ["default"]) await fake.seed({ accounts: [{ email, sub: "100000000000000000001", preset }] });
  const tokens = await googleOAuth(env, transport).exchangeCode(await authorizeAtFake({ email, scopes }));
  return { email, token: tokens.accessToken };
}

function api(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fakeFetch(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
}

function post(token: string, path: string, body?: unknown): Promise<Response> {
  return api(token, path, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

interface PageView {
  objectId: string;
  pageType: string;
  pageElements?: Array<{ objectId: string; shape?: { text?: { textElements: Array<{ textRun?: { content: string } }> } } }>;
}

interface PresentationView {
  presentationId: string;
  title: string;
  revisionId: string;
  slides: PageView[];
}

interface BatchReply {
  presentationId: string;
  replies: Array<{ replaceAllText?: { occurrencesChanged?: number }; createSlide?: { objectId: string } }>;
  writeControl: { requiredRevisionId: string };
}

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status).toBe(status);
  return (await r.json()) as T;
}

const getPresentation = (token: string, id: string) => json<PresentationView>(api(token, `${BASE}/${id}`));
const batch = (token: string, id: string, requests: unknown[], extra: Record<string, unknown> = {}) =>
  post(token, `${BASE}/${id}:batchUpdate`, { requests, ...extra });

/** Each slide's text, one string per shape. */
function texts(p: PresentationView): string[][] {
  return p.slides.map((s) => (s.pageElements ?? []).map((e) => (e.shape?.text?.textElements ?? []).map((t) => t.textRun?.content ?? "").join("")));
}

const replace = (find: string, by: string, extra: Record<string, unknown> = {}) => ({
  replaceAllText: { containsText: { text: find, matchCase: true }, replaceText: by, ...extra },
});

function outputSchema(fn: string) {
  const def = generatedFns.find((f) => f.name === fn);
  if (!def) throw new Error(`no generated fn ${fn}`);
  return def.output;
}

describe("scopes", () => {
  const ROUTES = [
    { fn: "slides.presentations.create", method: "POST", path: BASE },
    { fn: "slides.presentations.get", method: "GET", path: `${BASE}/${SEED}` },
    { fn: "slides.presentations.batchUpdate", method: "POST", path: `${BASE}/${SEED}:batchUpdate` },
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

  it("lets presentations.readonly read but not write", async () => {
    const { token } = await account([`${PRESENTATIONS}.readonly`]);
    expect((await api(token, `${BASE}/${SEED}`)).status).toBe(200);
    expect((await batch(token, SEED, [replace("{{name}}", "x")])).status).toBe(403);
  });
});

describe("presentations", () => {
  it("reads the seeded template with its {{name}} placeholders", async () => {
    const { token } = await account([PRESENTATIONS]);
    const p = await getPresentation(token, SEED);
    expect(p.title).toBe("Certificate template");
    expect(texts(p)).toEqual([["Certificate for {{name}}\n", "Awarded to {{name}} on {{date}}\n"], ["Thank you, {{name}}!\n"]]);
    expect(outputSchema("slides.presentations.get").safeParse(p).success).toBe(true);
  });

  it("creates a presentation with one blank slide, registered as a Drive file", async () => {
    const { email, token } = await account([PRESENTATIONS]);
    const created = await json<PresentationView>(post(token, BASE, { title: "Pitch" }));
    expect(created.title).toBe("Pitch");
    expect(created.slides.map((s) => [s.objectId, s.pageType, s.pageElements])).toEqual([["p", "SLIDE", undefined]]);
    expect(outputSchema("slides.presentations.create").safeParse(created).success).toBe(true);
    expect(await getPresentation(token, created.presentationId)).toEqual(created);
    const file = (await fake.state(email)).resources[`drive:file:${email}:${created.presentationId}`];
    expect(file).toMatchObject({ id: created.presentationId, name: "Pitch", mimeType: PRESENTATION_MIME, trashed: false });

    const untitled = await json<PresentationView>(post(token, BASE, {}));
    expect(untitled.title).toBe("Untitled presentation");
  });

  it("uses a given presentationId once, and rejects a bad body", async () => {
    const { token } = await account([PRESENTATIONS]);
    const id = `chosen-${crypto.randomUUID().slice(0, 8)}`;
    expect((await json<PresentationView>(post(token, BASE, { presentationId: id, title: "Mine" }))).presentationId).toBe(id);
    expect((await post(token, BASE, { presentationId: id })).status).toBe(409);
    expect((await post(token, BASE, { presentationId: "bad id!" })).status).toBe(400);
    expect((await post(token, BASE, { title: 5 })).status).toBe(400);
    expect((await api(token, `${BASE}/nope`)).status).toBe(404);
  });
});

describe("batchUpdate", () => {
  it("replaceAllText reports occurrencesChanged, and a following get shows the new text", async () => {
    const { token } = await account([PRESENTATIONS]);
    const before = await getPresentation(token, SEED);
    const reply = await json<BatchReply>(batch(token, SEED, [replace("{{name}}", "Dana"), replace("{{date}}", "10 Nov")]));
    expect(reply.presentationId).toBe(SEED);
    expect(reply.replies).toEqual([{ replaceAllText: { occurrencesChanged: 3 } }, { replaceAllText: { occurrencesChanged: 1 } }]);
    expect(outputSchema("slides.presentations.batchUpdate").safeParse(reply).success).toBe(true);
    const after = await getPresentation(token, SEED);
    expect(texts(after)).toEqual([["Certificate for Dana\n", "Awarded to Dana on 10 Nov\n"], ["Thank you, Dana!\n"]]);
    expect(after.revisionId).toBe(reply.writeControl.requiredRevisionId);
    expect(after.revisionId).not.toBe(before.revisionId);

    // No match: the reply carries no count, as Google omits zero.
    expect((await json<BatchReply>(batch(token, SEED, [replace("{{name}}", "x")]))).replies).toEqual([{ replaceAllText: {} }]);
  });

  it("matches case-insensitively unless matchCase, inserts replacement text literally, and honours pageObjectIds", async () => {
    const { token } = await account([PRESENTATIONS]);
    const loose = { replaceAllText: { containsText: { text: "{{NAME}}" }, replaceText: "$& $1" } };
    expect((await json<BatchReply>(batch(token, SEED, [replace("{{NAME}}", "x")]))).replies).toEqual([{ replaceAllText: {} }]);
    expect((await json<BatchReply>(batch(token, SEED, [{ ...loose, replaceAllText: { ...loose.replaceAllText, pageObjectIds: ["seed-slide-2"] } }]))).replies).toEqual([
      { replaceAllText: { occurrencesChanged: 1 } },
    ]);
    expect(texts(await getPresentation(token, SEED))[1]).toEqual(["Thank you, $& $1!\n"]);
  });

  it("createSlide inserts at an index with a given or generated id; deleteObject removes a slide or an element", async () => {
    const { token } = await account([PRESENTATIONS]);
    const reply = await json<BatchReply>(
      batch(token, SEED, [{ createSlide: { objectId: "intro_slide", insertionIndex: 0, slideLayoutReference: { predefinedLayout: "BLANK" } } }, { createSlide: {} }]),
    );
    const generated = reply.replies[1]?.createSlide?.objectId ?? "";
    expect(reply.replies[0]).toEqual({ createSlide: { objectId: "intro_slide" } });
    expect(generated).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9_\-:]{4,49}$/);
    expect((await getPresentation(token, SEED)).slides.map((s) => s.objectId)).toEqual(["intro_slide", "seed-slide-1", "seed-slide-2", generated]);

    expect((await json<BatchReply>(batch(token, SEED, [{ deleteObject: { objectId: "seed-slide-2" } }, { deleteObject: { objectId: "seed-body" } }]))).replies).toEqual([{}, {}]);
    const after = await getPresentation(token, SEED);
    expect(after.slides.map((s) => s.objectId)).toEqual(["intro_slide", "seed-slide-1", generated]);
    expect(after.slides[1]?.pageElements?.map((e) => e.objectId)).toEqual(["seed-title"]);
  });

  it("changes nothing when any request is invalid or of a kind the fake does not support", async () => {
    const { token } = await account([PRESENTATIONS]);
    const before = await getPresentation(token, SEED);
    const ok = replace("{{name}}", "Dana");
    const bad: Array<[unknown[], Record<string, unknown>?]> = [
      [[ok, { insertText: { objectId: "seed-title", text: "x" } }]],
      [[{ somethingElse: {} }]],
      [[{ replaceAllText: { containsText: { text: "" }, replaceText: "x" } }]],
      [[{ replaceAllText: { containsText: { text: "a", searchByRegex: true }, replaceText: "x" } }]],
      [[{ replaceAllText: { containsText: { text: "a" }, replaceText: "x", pageObjectIds: ["nope"] } }]],
      [[{ createSlide: { objectId: "seed-slide-1" } }]],
      [[{ createSlide: { objectId: "bad" } }]],
      [[{ createSlide: { insertionIndex: 9 } }]],
      [[{ createSlide: { slideLayoutReference: { layoutId: "nope" } } }]],
      [[{ deleteObject: { objectId: "nope" } }]],
      [[ok], { writeControl: { requiredRevisionId: "stale" } }],
      [[]],
    ];
    for (const [requests, extra] of bad) {
      const res = await batch(token, SEED, requests, extra);
      expect(res.status, JSON.stringify(requests)).toBe(400);
      expect(((await res.json()) as { error: { status: string } }).error.status).toBe("INVALID_ARGUMENT");
    }
    expect(await getPresentation(token, SEED)).toEqual(before);
    expect((await batch(token, "nope", [ok])).status).toBe(404);
  });

  it("accepts the current revision in writeControl", async () => {
    const { token } = await account([PRESENTATIONS]);
    const { revisionId } = await getPresentation(token, SEED);
    expect((await batch(token, SEED, [replace("{{date}}", "today")], { writeControl: { requiredRevisionId: revisionId } })).status).toBe(200);
  });
});

describe("Drive", () => {
  it("keeps the default preset's template out of Drive; the templates preset registers it", async () => {
    const { token } = await account([PRESENTATIONS, DRIVE_FILE]);
    expect((await api(token, `${DRIVE_FILES}/${SEED}`)).status).toBe(404);

    const { token: withTemplate } = await account([PRESENTATIONS, DRIVE_FILE], { presets: ["templates"] });
    const file = await json<{ id: string; name: string; mimeType: string }>(api(withTemplate, `${DRIVE_FILES}/${SEED}`));
    expect(file).toMatchObject({ id: SEED, name: "Certificate template", mimeType: PRESENTATION_MIME });
    expect((await getPresentation(withTemplate, SEED)).title).toBe("Certificate template");
  });

  it("drive.files.copy copies the slides; edits to the copy leave the template unchanged", async () => {
    const { token } = await account([PRESENTATIONS, DRIVE_FILE], { presets: ["default", "templates"] });
    const copy = await json<{ id: string }>(post(token, `${DRIVE_FILES}/${SEED}/copy`, { name: "Certificate for Dana" }));
    const copied = await getPresentation(token, copy.id);
    expect(copied.presentationId).toBe(copy.id);
    expect(copied.title).toBe("Certificate for Dana");
    expect(texts(copied)).toEqual(texts(await getPresentation(token, SEED)));

    expect((await json<BatchReply>(batch(token, copy.id, [replace("{{name}}", "Dana")]))).replies).toEqual([{ replaceAllText: { occurrencesChanged: 3 } }]);
    expect(texts(await getPresentation(token, copy.id))[1]).toEqual(["Thank you, Dana!\n"]);
    expect(texts(await getPresentation(token, SEED))[1]).toEqual(["Thank you, {{name}}!\n"]);

    expect((await api(token, `${DRIVE_FILES}/${copy.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await api(token, `${BASE}/${copy.id}`)).status).toBe(404);
  });

  it("does not serve a Drive file of another type as a presentation", async () => {
    const { token } = await account([PRESENTATIONS]);
    expect((await api(token, `${BASE}/seed-doc-notes`)).status).toBe(404);
    expect((await api(token, `${BASE}/seed-file-readme`)).status).toBe(404);
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
    return route.handle({ req, url, path: url.pathname, match, store, email: "do@fake.test", scopes: [PRESENTATIONS], now: () => Date.now() });
  }

  it("keeps presentations in a DoStore, so a write is observed by a following read", async () => {
    const store = new DoStore(memoryBackend(), { chunkChars: 200 });
    const { presentationId } = await json<PresentationView>(call(store, "POST", BASE, { title: "Durable" }));
    const requests = Array.from({ length: 20 }, (_, i) => ({ createSlide: { objectId: `durable_slide_${i}` } }));
    await json(call(store, "POST", `${BASE}/${presentationId}:batchUpdate`, { requests }));
    const p = await json<PresentationView>(call(store, "GET", `${BASE}/${presentationId}`));
    expect(p.slides).toHaveLength(21);
    expect(p.slides.at(-1)?.objectId).toBe("durable_slide_19");
  });
});

describe("fixtures", () => {
  it("are what the fake serves for a seeded account, replayed in order", async () => {
    const email = uniqueEmail("slides-replay");
    const { token } = await account([PRESENTATIONS], { email });
    const steps: Array<[Fixture, unknown?]> = [
      [parseFixture(presentationsGet)],
      [parseFixture(presentationsBatchUpdate), { requests: [replace("{{name}}", "Dana")] }],
      [parseFixture(presentationsCreate), { title: "Pitch" }],
    ];
    for (const [fx, body] of steps) {
      const res = await api(token, fx.request.path, {
        method: fx.request.method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      expect(res.status, fx.id).toBe(fx.response.status);
      const actual = JSON.parse((await res.text()).replaceAll(email, FIXTURE_EMAIL)) as Record<string, unknown>;
      const expected = { ...(fx.response.body as Record<string, unknown>) };
      if (fx.id === "slides-presentations-create") {
        // A new presentation has a fresh id.
        delete actual.presentationId;
        delete expected.presentationId;
      }
      expect(actual, fx.id).toEqual(expected);
    }
  });
});
