import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import documentsCreate from "../../fake-google/fixtures/docs/documents-create.json";
import documentsGet from "../../fake-google/fixtures/docs/documents-get.json";
import documentsBatchUpdate from "../../fake-google/fixtures/docs/documents-batch-update.json";
import { parseFixture, type Fixture } from "../../fake-google/src/fixtures";
import { routes } from "../../fake-google/src/routes/docs";
import { loadConfig } from "../../src/config";
import { googleOAuth } from "../../src/google/oauth";
import { createTransport } from "../../src/google/transport";
import { generatedFns } from "../../src/sdk/generated/index";
import { authorizeAtFake } from "../helpers/accounts";
import { fake, fakeFetch, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const DOCS = `${G}documents`;
const DRIVE_FILE = `${G}drive.file`;
const BASE = "/docs.googleapis.com/v1/documents";
const SEED = "seed-doc-notes";
const FIXTURE_EMAIL = "alice@fake.test";
const DOC_MIME = "application/vnd.google-apps.document";

const transport = createTransport(env, loadConfig(env));

async function account(scopes: string[], email = uniqueEmail("docs")) {
  await fake.seed({ accounts: [{ email, sub: "100000000000000000001", preset: "default" }] });
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

interface DocView {
  documentId: string;
  title: string;
  revisionId?: string;
  body: { content: Array<{ startIndex?: number; endIndex: number; paragraph?: { elements: Array<{ textRun?: { content: string } }> } }> };
}

/** The document's text, from its paragraphs. */
function textOf(doc: DocView): string {
  return doc.body.content.flatMap((c) => c.paragraph?.elements.map((e) => e.textRun?.content ?? "") ?? []).join("");
}

async function getDoc(token: string, id: string): Promise<DocView> {
  const res = await api(token, `${BASE}/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as DocView;
}

function batch(token: string, id: string, requests: unknown[]): Promise<Response> {
  return post(token, `${BASE}/${id}:batchUpdate`, { requests });
}

function outputSchema(fn: string) {
  const def = generatedFns.find((f) => f.name === fn);
  if (!def) throw new Error(`no generated fn ${fn}`);
  return def.output;
}

describe("scopes", () => {
  const ROUTES = [
    { fn: "docs.documents.create", method: "POST", path: BASE },
    { fn: "docs.documents.get", method: "GET", path: `${BASE}/${SEED}` },
    { fn: "docs.documents.batchUpdate", method: "POST", path: `${BASE}/${SEED}:batchUpdate` },
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

  it("lets documents.readonly read but not write", async () => {
    const { token } = await account([`${DOCS}.readonly`]);
    expect((await api(token, `${BASE}/${SEED}`)).status).toBe(200);
    expect((await batch(token, SEED, [{ insertText: { text: "x", location: { index: 1 } } }])).status).toBe(403);
  });
});

describe("documents", () => {
  it("creates an empty document that gets back the same, and registers it as a Drive file", async () => {
    const { email, token } = await account([DOCS]);
    const res = await post(token, BASE, { title: "Notes" });
    expect(res.status).toBe(200);
    const created = (await res.json()) as DocView;
    expect(created.title).toBe("Notes");
    expect(textOf(created)).toBe("\n");
    expect(outputSchema("docs.documents.create").safeParse(created).success).toBe(true);
    expect(await getDoc(token, created.documentId)).toEqual(created);

    const file = (await fake.state(email)).resources[`drive:file:${email}:${created.documentId}`];
    expect(file).toMatchObject({ id: created.documentId, name: "Notes", mimeType: DOC_MIME, parents: ["root"], trashed: false });
  });

  it("can be exported to PDF through the Drive route", async () => {
    const { token } = await account([DOCS, DRIVE_FILE]);
    const created = (await (await post(token, BASE, { title: "Export me" })).json()) as DocView;
    const res = await api(token, `/www.googleapis.com/drive/v3/files/${created.documentId}/export?mimeType=application%2Fpdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 4))).toBe("%PDF");
  });

  it("returns 404 for an unknown document and 400 for a bad title", async () => {
    const { token } = await account([DOCS]);
    expect((await api(token, `${BASE}/nope`)).status).toBe(404);
    expect((await post(token, BASE, { title: 5 })).status).toBe(400);
  });

  it("reads the seeded document", async () => {
    const { token } = await account([DOCS]);
    const doc = await getDoc(token, SEED);
    expect(doc.title).toBe("Meeting notes");
    expect(textOf(doc)).toBe("Agenda\nShip the helpers\n");
  });
});

describe("batchUpdate insertText", () => {
  it("inserts at an index and at the end of the segment", async () => {
    const { token } = await account([DOCS]);
    const { documentId } = (await (await post(token, BASE, { title: "T" })).json()) as DocView;
    const first = await batch(token, documentId, [{ insertText: { text: "Hello", location: { index: 1 } } }]);
    expect(first.status).toBe(200);
    const reply = (await first.json()) as { documentId: string; replies: unknown[]; writeControl: { requiredRevisionId: string } };
    expect(reply.documentId).toBe(documentId);
    expect(reply.replies).toEqual([{}]);
    expect(outputSchema("docs.documents.batchUpdate").safeParse(reply).success).toBe(true);

    await batch(token, documentId, [
      { insertText: { text: " world", endOfSegmentLocation: {} } },
      { insertText: { text: ">> ", location: { index: 1 } } },
    ]);
    const doc = await getDoc(token, documentId);
    expect(textOf(doc)).toBe(">> Hello world\n");
    expect(reply.writeControl.requiredRevisionId).toBe("rev-2");
    expect(doc.revisionId).toBe("rev-3");
  });

  it("renders paragraphs with indexes that match the text", async () => {
    const { token } = await account([DOCS]);
    const { documentId } = (await (await post(token, BASE, { title: "T" })).json()) as DocView;
    await batch(token, documentId, [{ insertText: { text: "one\ntwo", location: { index: 1 } } }]);
    const doc = await getDoc(token, documentId);
    expect(doc.body.content.map((c) => [c.startIndex, c.endIndex])).toEqual([[undefined, 1], [1, 5], [5, 9]]);
    expect(textOf(doc)).toBe("one\ntwo\n");
  });

  it("changes nothing when any request of the batch is invalid", async () => {
    const { token } = await account([DOCS]);
    const before = await getDoc(token, SEED);
    const bad = [
      [{ insertText: { text: "ok", location: { index: 1 } } }, { insertText: { text: "x", location: { index: 999 } } }],
      [{ insertText: { text: "x", location: { index: 0 } } }],
      [{ insertText: { text: "", location: { index: 1 } } }],
      [{ insertText: { text: "x" } }],
      [{ deleteContentRange: { range: { startIndex: 1, endIndex: 2 } } }],
      [],
    ];
    for (const requests of bad) expect((await batch(token, SEED, requests)).status, JSON.stringify(requests)).toBe(400);
    expect(await getDoc(token, SEED)).toEqual(before);
    expect((await batch(token, "nope", [{ insertText: { text: "x", location: { index: 1 } } }])).status).toBe(404);
  });
});

describe("fixtures", () => {
  const byId = (f: unknown): Fixture => parseFixture(f);

  it("are what the fake serves for a seeded account, replayed in order", async () => {
    const email = uniqueEmail("docs-replay");
    const { token } = await account([DOCS], email);
    const steps: Array<[Fixture, unknown?]> = [
      [byId(documentsGet)],
      [byId(documentsBatchUpdate), { requests: [{ insertText: { text: "Hello\n", location: { index: 1 } } }] }],
      [byId(documentsCreate), { title: "Notes" }],
    ];
    for (const [fx, body] of steps) {
      const res = await api(token, fx.request.path, {
        method: fx.request.method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      expect(res.status, fx.id).toBe(fx.response.status);
      const actual = JSON.parse((await res.text()).replaceAll(email, FIXTURE_EMAIL)) as Record<string, unknown>;
      const expected = fx.response.body as Record<string, unknown>;
      if (fx.id === "docs-documents-create") {
        // A new document has a fresh id.
        delete actual.documentId;
        delete expected.documentId;
      }
      expect(actual, fx.id).toEqual(expected);
    }
  });
});
