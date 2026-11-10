import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import formsBatchUpdate from "../../fake-google/fixtures/forms/forms-batch-update.json";
import formsCreate from "../../fake-google/fixtures/forms/forms-create.json";
import formsGet from "../../fake-google/fixtures/forms/forms-get.json";
import responsesList from "../../fake-google/fixtures/forms/responses-list.json";
import { DoStore, type KvBackend } from "../../fake-google/src/do-store";
import { parseFixture, type Fixture } from "../../fake-google/src/fixtures";
import { routes } from "../../fake-google/src/routes/forms";
import type { FakeRoute } from "../../fake-google/src/routes/index";
import type { FakeStore } from "../../fake-google/src/store";
import { loadConfig } from "../../src/config";
import { googleOAuth } from "../../src/google/oauth";
import { createTransport } from "../../src/google/transport";
import { generatedFns } from "../../src/sdk/generated/index";
import { authorizeAtFake } from "../helpers/accounts";
import { fake, fakeFetch, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const BODY = `${G}forms.body`;
const BODY_RO = `${G}forms.body.readonly`;
const RESPONSES_RO = `${G}forms.responses.readonly`;
const BASE = "/forms.googleapis.com/v1/forms";
const SEED = "seed-form-feedback";
const FIXTURE_EMAIL = "alice@fake.test";
const NOW = Date.parse("2026-11-10T03:00:00.000Z");

const transport = createTransport(env, loadConfig(env));

async function account(scopes: string[], email = uniqueEmail("forms")) {
  await fake.seed({ accounts: [{ email, sub: "100000000000000000001", preset: "default" }], now: NOW });
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

interface FormView {
  formId: string;
  info: { title: string; documentTitle: string; description?: string };
  items?: Array<{ itemId: string; title: string }>;
  revisionId: string;
  responderUri: string;
  publishSettings?: { publishState: { isPublished: boolean; isAcceptingResponses: boolean } };
}

interface ResponsesPage {
  responses?: Array<{ responseId: string; formId: string; lastSubmittedTime: string; answers: Record<string, { textAnswers: { answers: Array<{ value: string }> } }> }>;
  nextPageToken?: string;
}

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status).toBe(status);
  return (await r.json()) as T;
}

const getForm = (token: string, id: string) => json<FormView>(api(token, `${BASE}/${id}`));
const batch = (token: string, id: string, body: unknown) => post(token, `${BASE}/${id}:batchUpdate`, body);

function outputSchema(fn: string) {
  const def = generatedFns.find((f) => f.name === fn);
  if (!def) throw new Error(`no generated fn ${fn}`);
  return def.output;
}

describe("scopes", () => {
  const ROUTES = [
    { fn: "forms.forms.create", method: "POST", path: BASE },
    { fn: "forms.forms.get", method: "GET", path: `${BASE}/${SEED}` },
    { fn: "forms.forms.batchUpdate", method: "POST", path: `${BASE}/${SEED}:batchUpdate` },
    { fn: "forms.forms.responses.list", method: "GET", path: `${BASE}/${SEED}/responses` },
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

  it("separates the form body from its responses", async () => {
    const { token: body } = await account([BODY_RO]);
    expect((await api(body, `${BASE}/${SEED}`)).status).toBe(200);
    expect((await api(body, `${BASE}/${SEED}/responses`)).status).toBe(403);
    expect((await batch(body, SEED, { requests: [{ updateFormInfo: { info: { title: "x" }, updateMask: "title" } }] })).status).toBe(403);

    const { token: responses } = await account([RESPONSES_RO]);
    expect((await api(responses, `${BASE}/${SEED}/responses`)).status).toBe(200);
    expect((await api(responses, `${BASE}/${SEED}`)).status).toBe(403);
  });
});

describe("forms", () => {
  it("reads the seeded form with its questions", async () => {
    const { token } = await account([BODY]);
    const form = await getForm(token, SEED);
    expect(form.info).toEqual({ title: "Workshop feedback", documentTitle: "Workshop feedback", description: "Two questions, two minutes." });
    expect(form.items?.map((i) => i.title)).toEqual(["Your name", "How useful was it?"]);
    expect(outputSchema("forms.forms.get").safeParse(form).success).toBe(true);
  });

  it("creates a form from a title only; a get returns the same form", async () => {
    const { token } = await account([BODY]);
    const created = await json<FormView>(post(token, BASE, { info: { title: "Signup" } }));
    expect(created.info).toEqual({ title: "Signup", documentTitle: "Signup" });
    expect(created.items).toBeUndefined();
    expect(created.publishSettings?.publishState).toEqual({ isPublished: true, isAcceptingResponses: true });
    expect(outputSchema("forms.forms.create").safeParse(created).success).toBe(true);
    expect(await getForm(token, created.formId)).toEqual(created);

    const named = await json<FormView>(post(token, `${BASE}?unpublished=true`, { info: { title: "Draft", documentTitle: "Draft (internal)" } }));
    expect(named.info).toEqual({ title: "Draft", documentTitle: "Draft (internal)" });
    expect(named.publishSettings?.publishState).toEqual({ isPublished: false, isAcceptingResponses: false });
  });

  it("refuses anything but a title on create, as Google does", async () => {
    const { token } = await account([BODY]);
    const bad = [
      {},
      { info: {} },
      { info: { title: 5 } },
      { info: { title: "x", description: "not allowed on create" } },
      { info: { title: "x" }, items: [{ title: "q" }] },
      { info: { title: "x" }, settings: {} },
    ];
    for (const body of bad) expect((await post(token, BASE, body)).status, JSON.stringify(body)).toBe(400);
    expect((await post(token, `${BASE}?unpublished=maybe`, { info: { title: "x" } })).status).toBe(400);
    expect((await api(token, `${BASE}/nope`)).status).toBe(404);
  });
});

describe("batchUpdate", () => {
  it("updateFormInfo changes the named fields, and a following get observes it", async () => {
    const { token } = await account([BODY]);
    const before = await getForm(token, SEED);
    const reply = await json<{ replies: unknown[]; writeControl: { requiredRevisionId: string }; form?: unknown }>(
      batch(token, SEED, { requests: [{ updateFormInfo: { info: { description: "Now with prizes." }, updateMask: "description" } }] }),
    );
    expect(reply.replies).toEqual([{}]);
    expect(reply.form).toBeUndefined();
    expect(outputSchema("forms.forms.batchUpdate").safeParse(reply).success).toBe(true);
    const after = await getForm(token, SEED);
    expect(after.info).toEqual({ ...before.info, description: "Now with prizes." });
    expect(after.revisionId).toBe(reply.writeControl.requiredRevisionId);
    expect(after.revisionId).not.toBe(before.revisionId);

    const all = await json<{ form: FormView }>(
      batch(token, SEED, { includeFormInResponse: true, requests: [{ updateFormInfo: { info: { title: "Feedback" }, updateMask: "*" } }] }),
    );
    // "*" sets every field from `info`: the description is cleared.
    expect(all.form.info).toEqual({ title: "Feedback", documentTitle: "Workshop feedback" });
    expect(await getForm(token, SEED)).toEqual(all.form);
  });

  it("deleteItem removes the item at an index", async () => {
    const { token } = await account([BODY]);
    await json(batch(token, SEED, { requests: [{ deleteItem: { location: { index: 0 } } }] }));
    expect((await getForm(token, SEED)).items?.map((i) => i.title)).toEqual(["How useful was it?"]);
  });

  it("changes nothing when any request is invalid or of a kind the fake does not support", async () => {
    const { token } = await account([BODY]);
    const before = await getForm(token, SEED);
    const ok = { updateFormInfo: { info: { title: "Changed" }, updateMask: "title" } };
    const bad: unknown[] = [
      { requests: [ok, { createItem: { item: { title: "Q" }, location: { index: 0 } } }] },
      { requests: [{ moveItem: { originalLocation: { index: 0 }, newLocation: { index: 1 } } }] },
      { requests: [{ somethingElse: {} }] },
      { requests: [{ updateFormInfo: { info: { title: "x" } } }] },
      { requests: [{ updateFormInfo: { info: { title: "x" }, updateMask: "documentTitle" } }] },
      { requests: [{ updateFormInfo: { info: { title: 3 }, updateMask: "title" } }] },
      { requests: [{ deleteItem: { location: { index: 2 } } }] },
      { requests: [{ deleteItem: {} }] },
      { requests: [ok], writeControl: { requiredRevisionId: "stale" } },
      { requests: [] },
      {},
    ];
    for (const body of bad) {
      const res = await batch(token, SEED, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: { status: string } }).error.status).toBe("INVALID_ARGUMENT");
    }
    expect(await getForm(token, SEED)).toEqual(before);
    expect((await batch(token, "nope", { requests: [ok] })).status).toBe(404);
  });

  it("accepts the current revision in writeControl", async () => {
    const { token } = await account([BODY]);
    const { revisionId } = await getForm(token, SEED);
    const body = { requests: [{ updateFormInfo: { info: { title: "T" }, updateMask: "title" } }], writeControl: { requiredRevisionId: revisionId } };
    expect((await batch(token, SEED, body)).status).toBe(200);
  });
});

describe("responses", () => {
  it("lists the two seeded responses, in pages of pageSize", async () => {
    const { token } = await account([RESPONSES_RO]);
    const all = await json<ResponsesPage>(api(token, `${BASE}/${SEED}/responses`));
    expect(all.responses?.map((r) => r.responseId)).toEqual(["seed-response-1", "seed-response-2"]);
    expect(all.nextPageToken).toBeUndefined();
    expect(all.responses?.[0]?.answers["q-name"]?.textAnswers.answers[0]?.value).toBe("Dana");
    expect(outputSchema("forms.forms.responses.list").safeParse(all).success).toBe(true);

    const first = await json<ResponsesPage>(api(token, `${BASE}/${SEED}/responses?pageSize=1`));
    expect(first.responses?.map((r) => r.responseId)).toEqual(["seed-response-1"]);
    expect(first.nextPageToken).toBeDefined();
    const second = await json<ResponsesPage>(api(token, `${BASE}/${SEED}/responses?pageSize=1&pageToken=${first.nextPageToken}`));
    expect(second.responses?.map((r) => r.responseId)).toEqual(["seed-response-2"]);
    expect(second.nextPageToken).toBeUndefined();
  });

  it("filters on the submit timestamp", async () => {
    const { token } = await account([RESPONSES_RO]);
    const after = (f: string) => json<ResponsesPage>(api(token, `${BASE}/${SEED}/responses?filter=${encodeURIComponent(f)}`));
    expect((await after("timestamp >= 2026-11-06T09:30:00Z")).responses?.map((r) => r.responseId)).toEqual(["seed-response-2"]);
    expect((await after("timestamp > 2026-11-06T09:30:00Z")).responses).toBeUndefined();
  });

  it("returns an empty object for a form without responses, 404 for an unknown form and 400 for bad paging", async () => {
    const { token } = await account([BODY, RESPONSES_RO]);
    const { formId } = await json<FormView>(post(token, BASE, { info: { title: "Empty" } }));
    expect(await json(api(token, `${BASE}/${formId}/responses`))).toEqual({});
    expect((await api(token, `${BASE}/nope/responses`)).status).toBe(404);
    for (const q of ["pageSize=-1", "pageSize=x", "pageToken=abc", `filter=${encodeURIComponent("respondent = a")}`]) {
      expect((await api(token, `${BASE}/${SEED}/responses?${q}`)).status, q).toBe(400);
    }
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
    return route.handle({ req, url, path: url.pathname, match, store, email: "do@fake.test", scopes: [BODY], now: () => NOW });
  }

  it("keeps forms in a DoStore, so a write is observed by a following read", async () => {
    const store = new DoStore(memoryBackend(), { chunkChars: 200 });
    const { formId } = await json<FormView>(call(store, "POST", BASE, { info: { title: "Durable" } }));
    const description = "d".repeat(500);
    await json(call(store, "POST", `${BASE}/${formId}:batchUpdate`, { requests: [{ updateFormInfo: { info: { description }, updateMask: "description" } }] }));
    expect((await json<FormView>(call(store, "GET", `${BASE}/${formId}`))).info.description).toBe(description);
  });
});

describe("fixtures", () => {
  it("are what the fake serves for a seeded account, replayed in order", async () => {
    const email = uniqueEmail("forms-replay");
    const { token } = await account([BODY, RESPONSES_RO], email);
    const steps: Array<[Fixture, unknown?]> = [
      [parseFixture(formsGet)],
      [parseFixture(responsesList)],
      [parseFixture(formsBatchUpdate), { requests: [{ updateFormInfo: { info: { description: "Now with prizes." }, updateMask: "description" } }] }],
      [parseFixture(formsCreate), { info: { title: "Signup" } }],
    ];
    for (const [fx, body] of steps) {
      const query = new URLSearchParams(fx.request.query as Record<string, string> | undefined).toString();
      const res = await api(token, `${fx.request.path}${query ? `?${query}` : ""}`, {
        method: fx.request.method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      expect(res.status, fx.id).toBe(fx.response.status);
      const actual = JSON.parse((await res.text()).replaceAll(email, FIXTURE_EMAIL)) as Record<string, unknown>;
      const expected = { ...(fx.response.body as Record<string, unknown>) };
      if (fx.id === "forms-forms-create") {
        // A new form has a fresh id, and its responder link carries it.
        for (const k of ["formId", "responderUri"]) {
          delete actual[k];
          delete expected[k];
        }
      }
      expect(actual, fx.id).toEqual(expected);
    }
  });
});
