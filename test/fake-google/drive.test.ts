import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import filesCreate from "../../fake-google/fixtures/drive/files-create.json";
import filesGet from "../../fake-google/fixtures/drive/files-get.json";
import filesListInFolder from "../../fake-google/fixtures/drive/files-list-in-folder.json";
import filesList from "../../fake-google/fixtures/drive/files-list.json";
import permissionsCreate from "../../fake-google/fixtures/drive/permissions-create.json";
import permissionsList from "../../fake-google/fixtures/drive/permissions-list.json";
import { parseFixture, type Fixture } from "../../fake-google/src/fixtures";
import { routes } from "../../fake-google/src/routes/drive";
import { loadConfig } from "../../src/config";
import { googleOAuth } from "../../src/google/oauth";
import { createTransport } from "../../src/google/transport";
import { generatedFns } from "../../src/sdk/generated/index";
import { authorizeAtFake } from "../helpers/accounts";
import { fake, fakeFetch, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const DRIVE = `${G}drive`;
const DRIVE_FILE = `${G}drive.file`;
const FILES = "/www.googleapis.com/drive/v3/files";
const UPLOAD = "/www.googleapis.com/upload/drive/v3/files";
const FIXTURE_EMAIL = "alice@fake.test";
const FIXTURE_SUB = "100000000000000000001";

const transport = createTransport(env, loadConfig(env));

interface FileView {
  kind?: string;
  id: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  trashed?: boolean;
  size?: string;
  version?: string;
}

interface FileListView {
  kind: string;
  incompleteSearch: boolean;
  nextPageToken?: string;
  files: FileView[];
}

/** Seeds a fresh account (preset "default") and returns a real fake access token holding `scopes`. */
async function account(scopes: string[], email = uniqueEmail("drive")) {
  await fake.seed({ accounts: [{ email, sub: FIXTURE_SUB, preset: "default" }] });
  const tokens = await googleOAuth(env, transport).exchangeCode(await authorizeAtFake({ email, scopes }));
  return { email, token: tokens.accessToken };
}

function api(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fakeFetch(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
}

function send(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return api(token, path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function list(token: string, query = ""): Promise<FileListView> {
  return json<FileListView>(await api(token, `${FILES}${query}`));
}

function multipart(boundary: string, metadata: unknown, mimeType: string, bytes: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  out.set(tail, head.length + bytes.length);
  return out;
}

function outputSchema(fn: string) {
  const def = generatedFns.find((f) => f.name === fn);
  if (!def) throw new Error(`no generated fn ${fn}`);
  return def.output;
}

function fixtureUrl(fx: Fixture): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(fx.request.query ?? {})) for (const x of [v].flat()) qs.append(k, x);
  return `${fx.request.path}${qs.size > 0 ? `?${qs}` : ""}`;
}

/** Fixture files, in the order they were recorded against one seeded account, with their SDK method. */
const FIXTURES: Array<{ fixture: Fixture; fn: string; body?: unknown }> = [
  { fixture: parseFixture(filesList), fn: "drive.files.list" },
  { fixture: parseFixture(filesListInFolder), fn: "drive.files.list" },
  { fixture: parseFixture(filesGet), fn: "drive.files.get" },
  {
    fixture: parseFixture(filesCreate),
    fn: "drive.files.create",
    body: { name: "Plan.txt", mimeType: "text/plain", parents: ["seed-folder-projects"] },
  },
  { fixture: parseFixture(permissionsCreate), fn: "drive.permissions.create", body: { type: "anyone", role: "reader" } },
  { fixture: parseFixture(permissionsList), fn: "drive.permissions.list" },
];

/** Every route with a sample path and its SDK method. */
const ROUTES = [
  { fn: "drive.files.list", method: "GET", path: FILES },
  { fn: "drive.files.create", method: "POST", path: FILES },
  { fn: "drive.files.create", method: "POST", path: UPLOAD },
  { fn: "drive.files.get", method: "GET", path: `${FILES}/seed-file-readme` },
  { fn: "drive.files.update", method: "PATCH", path: `${FILES}/seed-file-readme` },
  { fn: "drive.files.delete", method: "DELETE", path: `${FILES}/seed-file-readme` },
  { fn: "drive.files.copy", method: "POST", path: `${FILES}/seed-file-readme/copy` },
  { fn: "drive.files.emptyTrash", method: "DELETE", path: `${FILES}/trash` },
  { fn: "drive.files.export", method: "GET", path: `${FILES}/seed-doc-notes/export` },
  { fn: "drive.permissions.create", method: "POST", path: `${FILES}/seed-doc-notes/permissions` },
  { fn: "drive.permissions.list", method: "GET", path: `${FILES}/seed-doc-notes/permissions` },
] as const;

describe("fixtures", () => {
  it.each(FIXTURES.map((f) => [f.fixture.id, f] as const))("%s validates against the generated output schema", (_id, { fixture, fn }) => {
    expect(fixture.source).toBe("synthesized");
    expect(fixture.response.status).toBe(200);
    const parsed = outputSchema(fn).safeParse(fixture.response.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
  });

  it("are what the fake serves for a seeded account", async () => {
    const email = uniqueEmail("replay");
    const { token } = await account([DRIVE], email);
    const localPart = email.split("@")[0] ?? email;
    for (const { fixture, body } of FIXTURES) {
      const res = await send(token, fixture.request.method, fixtureUrl(fixture), body);
      expect(res.status, fixture.id).toBe(fixture.response.status);
      const text = (await res.text()).replaceAll(email, FIXTURE_EMAIL).replaceAll(`"${localPart}"`, '"alice"');
      const actual = JSON.parse(text) as Record<string, unknown>;
      const expected = fixture.response.body as Record<string, unknown>;
      if (fixture.id === "drive-files-create") {
        // A create mints a fresh id; everything else must match.
        expect({ ...actual, id: "x" }, fixture.id).toEqual({ ...expected, id: "x" });
      } else {
        expect(actual, fixture.id).toEqual(expected);
      }
    }
  });
});

describe("scopes", () => {
  it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))("%s requires exactly the method's Discovery scopes", (_name, r) => {
    const route = routes.find((x) => x.method === r.method && x.pattern.test(r.path));
    expect(route, r.fn).toBeDefined();
    const meta = generatedFns.find((f) => f.name === r.fn)?.method;
    expect([...(route?.scopes ?? [])].sort()).toEqual([...(meta?.scopes ?? [])].sort());
  });

  it("routes DELETE files/trash to emptyTrash, not to files.delete", () => {
    const route = routes.find((x) => x.method === "DELETE" && x.pattern.test(`${FILES}/trash`));
    expect(route?.scopes).toEqual([DRIVE]);
  });

  it("refuses each route for a token without any of its scopes", async () => {
    const { token } = await account([`${G}calendar.events`]);
    for (const r of ROUTES) {
      const res = await api(token, r.path, { method: r.method });
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      const body = await json<{ error: { details: Array<{ reason: string }> } }>(res);
      expect(body.error.details[0]?.reason).toBe("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    }
  });

  it("refuses emptyTrash to drive.file, which only the full drive scope may call", async () => {
    const { token } = await account([DRIVE_FILE]);
    expect((await api(token, `${FILES}/trash`, { method: "DELETE" })).status).toBe(403);
    expect((await api(token, FILES)).status).toBe(200);
  });
});

describe("files", () => {
  it("creates a metadata-only file that a later list sees", async () => {
    const { email, token } = await account([DRIVE_FILE]);
    const res = await send(token, "POST", FILES, { name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" });
    expect(res.status).toBe(200);
    const created = await json<FileView>(res);
    expect(created).toEqual({ kind: "drive#file", id: created.id, name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" });
    expect(outputSchema("drive.files.create").safeParse(created).success).toBe(true);
    expect((await list(token)).files.map((f) => f.id)).toContain(created.id);
    const state = await fake.state(email);
    expect(state.resources[`drive:file:${email}:${created.id}`]).toMatchObject({ parents: ["root"], trashed: false });
  });

  it("stores the bytes of a multipart upload", async () => {
    const { email, token } = await account([DRIVE_FILE]);
    const bytes = Uint8Array.from([0, 13, 10, 45, 45, 66, 255]);
    const res = await api(token, `${UPLOAD}?uploadType=multipart`, {
      method: "POST",
      headers: { "content-type": "multipart/related; boundary=xyz" },
      body: multipart("xyz", { name: "blob.bin", parents: ["seed-folder-projects"] }, "application/x-test", bytes),
    });
    expect(res.status).toBe(200);
    const created = await json<FileView>(res);
    expect(created).toMatchObject({ name: "blob.bin", mimeType: "application/x-test" });
    const media = await api(token, `${FILES}/${created.id}?alt=media`);
    expect(media.headers.get("content-type")).toBe("application/x-test");
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(bytes);
    const rec = (await fake.state(email)).resources[`drive:file:${email}:${created.id}`];
    expect(rec).toMatchObject({ size: "7", parents: ["seed-folder-projects"] });
  });

  it("stores a simple media upload as Untitled with the body's type", async () => {
    const { token } = await account([DRIVE_FILE]);
    const res = await api(token, `${UPLOAD}?uploadType=media`, { method: "POST", headers: { "content-type": "text/csv" }, body: "a,b\n" });
    const created = await json<FileView>(res);
    expect(created).toMatchObject({ name: "Untitled", mimeType: "text/csv" });
    expect(await (await api(token, `${FILES}/${created.id}?alt=media`)).text()).toBe("a,b\n");
  });

  it("rejects malformed uploads", async () => {
    const { token } = await account([DRIVE_FILE]);
    expect((await api(token, `${UPLOAD}?uploadType=resumable`, { method: "POST", body: "x" })).status).toBe(400);
    expect(
      (await api(token, `${UPLOAD}?uploadType=multipart`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status,
    ).toBe(400);
    const onePart = new TextEncoder().encode("--b\r\nContent-Type: application/json\r\n\r\n{}\r\n--b--");
    expect(
      (await api(token, `${UPLOAD}?uploadType=multipart`, { method: "POST", headers: { "content-type": "multipart/related; boundary=b" }, body: onePart }))
        .status,
    ).toBe(400);
  });

  it("filters list by name contains, trashed and parents, and pages", async () => {
    const { token } = await account([DRIVE]);
    const ids = async (q: string) => (await list(token, `?q=${encodeURIComponent(q)}`)).files.map((f) => f.id);
    expect((await list(token)).files.map((f) => f.id)).toEqual(["seed-doc-notes", "seed-file-readme", "seed-file-old-draft", "seed-folder-projects"]);
    expect(await ids("trashed = false")).toEqual(["seed-doc-notes", "seed-file-readme", "seed-folder-projects"]);
    expect(await ids("trashed=true")).toEqual(["seed-file-old-draft"]);
    expect(await ids("name contains 'readme'")).toEqual(["seed-file-readme"]);
    expect(await ids("'seed-folder-projects' in parents")).toEqual(["seed-file-readme"]);
    expect(await ids("'root' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'")).toEqual(["seed-doc-notes"]);
    expect(await ids("name = 'Meeting notes'")).toEqual(["seed-doc-notes"]);
    expect(await ids("name contains 'it\\'s'")).toEqual([]);

    const page1 = await list(token, "?pageSize=3");
    expect(page1.files).toHaveLength(3);
    expect(page1.nextPageToken).toBe("3");
    const page2 = await list(token, "?pageSize=3&pageToken=3");
    expect(page2.files.map((f) => f.id)).toEqual(["seed-folder-projects"]);
    expect(page2.nextPageToken).toBeUndefined();
  });

  it("rejects an unsupported q with Drive's invalid-value error", async () => {
    const { token } = await account([DRIVE]);
    const res = await api(token, `${FILES}?q=${encodeURIComponent("fullText contains 'x'")}`);
    expect(res.status).toBe(400);
    const body = await json<{ error: { errors: Array<{ reason: string; location: string }> } }>(res);
    expect(body.error.errors[0]).toMatchObject({ reason: "invalid", location: "q" });
  });

  it("returns Drive's default fields unless fields asks for more", async () => {
    const { token } = await account([DRIVE]);
    const plain = await json<Record<string, unknown>>(await api(token, `${FILES}/seed-file-readme`));
    expect(Object.keys(plain).sort()).toEqual(["id", "kind", "mimeType", "name"]);
    const some = await json<Record<string, unknown>>(await api(token, `${FILES}/seed-file-readme?fields=id,size,parents`));
    expect(some).toEqual({ id: "seed-file-readme", size: "27", parents: ["seed-folder-projects"] });
    const all = await json<Record<string, unknown>>(await api(token, `${FILES}/seed-file-readme?fields=*`));
    expect(all).toMatchObject({ webViewLink: "https://drive.google.com/file/d/seed-file-readme/view?usp=drivesdk", ownedByMe: true });
    expect(outputSchema("drive.files.get").safeParse(all).success).toBe(true);
    expect((await api(token, `${FILES}/seed-file-readme?fields=files(`)).status).toBe(400);
  });

  it("downloads binary content with alt=media and refuses it for Docs files", async () => {
    const { token } = await account([DRIVE]);
    const res = await api(token, `${FILES}/seed-file-readme?alt=media`);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("Hello from the fake Drive.\n");
    const doc = await api(token, `${FILES}/seed-doc-notes?alt=media`);
    expect(doc.status).toBe(403);
    expect((await json<{ error: { errors: Array<{ reason: string }> } }>(doc)).error.errors[0]?.reason).toBe("fileNotDownloadable");
    expect((await api(token, `${FILES}/missing`)).status).toBe(404);
  });

  it("exports a Docs file to fixed fake PDF bytes and refuses other exports", async () => {
    const { token } = await account([DRIVE]);
    const res = await api(token, `${FILES}/seed-doc-notes/export?mimeType=application%2Fpdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect((await res.text()).startsWith("%PDF-1.4")).toBe(true);
    expect((await api(token, `${FILES}/seed-doc-notes/export`)).status).toBe(400);
    expect((await api(token, `${FILES}/seed-doc-notes/export?mimeType=text%2Fhtml`)).status).toBe(400);
    expect((await api(token, `${FILES}/seed-file-readme/export?mimeType=application%2Fpdf`)).status).toBe(403);
  });

  it("copies a file with its content", async () => {
    const { token } = await account([DRIVE]);
    const copy = await json<FileView>(await send(token, "POST", `${FILES}/seed-file-readme/copy`, {}));
    expect(copy).toMatchObject({ name: "Copy of README.txt", mimeType: "text/plain" });
    expect(copy.id).not.toBe("seed-file-readme");
    expect(await (await api(token, `${FILES}/${copy.id}?alt=media`)).text()).toBe("Hello from the fake Drive.\n");
    const named = await json<FileView>(await send(token, "POST", `${FILES}/seed-file-readme/copy`, { name: "Mine.txt", parents: ["root"] }));
    expect(named.name).toBe("Mine.txt");
  });

  it("updates metadata, parents and trashed", async () => {
    const { token } = await account([DRIVE]);
    const res = await send(token, "PATCH", `${FILES}/seed-file-readme?addParents=root&removeParents=seed-folder-projects&fields=*`, {
      name: "README.md",
      trashed: true,
    });
    const updated = await json<FileView>(res);
    expect(updated).toMatchObject({ name: "README.md", parents: ["root"], trashed: true, version: "2" });
    expect((await send(token, "PATCH", `${FILES}/seed-file-readme`, { name: 7 })).status).toBe(400);
    expect((await send(token, "PATCH", `${FILES}/seed-file-readme?addParents=nope`, {})).status).toBe(404);
  });

  it("rejects a parent that is not an existing folder", async () => {
    const { token } = await account([DRIVE]);
    expect((await send(token, "POST", FILES, { name: "x", parents: ["seed-file-readme"] })).status).toBe(404);
    expect((await send(token, "POST", FILES, { name: "x", parents: "root" })).status).toBe(400);
  });

  it("deletes permanently and empties the trash", async () => {
    const { email, token } = await account([DRIVE]);
    const del = await api(token, `${FILES}/seed-file-readme`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect((await api(token, `${FILES}/seed-file-readme`)).status).toBe(404);
    expect((await fake.state(email)).resources[`drive:blob:${email}:seed-file-readme`]).toBeUndefined();

    expect((await api(token, `${FILES}/trash`, { method: "DELETE" })).status).toBe(204);
    expect((await list(token)).files.map((f) => f.id)).toEqual(["seed-doc-notes", "seed-folder-projects"]);
    expect((await api(token, `${FILES}/missing`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("permissions", () => {
  it("creates an anyone-with-link share and lists it after the owner", async () => {
    const { email, token } = await account([DRIVE_FILE]);
    const created = await json<Record<string, unknown>>(await send(token, "POST", `${FILES}/seed-doc-notes/permissions`, { type: "anyone", role: "reader" }));
    expect(created).toEqual({ kind: "drive#permission", id: "anyoneWithLink", type: "anyone", role: "reader" });
    const user = await json<Record<string, unknown>>(
      await send(token, "POST", `${FILES}/seed-doc-notes/permissions`, { type: "user", role: "writer", emailAddress: "bob@fake.test" }),
    );
    const listed = await json<{ permissions: Array<Record<string, unknown>> }>(await api(token, `${FILES}/seed-doc-notes/permissions`));
    expect(listed.permissions[0]).toEqual({ kind: "drive#permission", id: FIXTURE_SUB, type: "user", emailAddress: email, role: "owner" });
    expect(listed.permissions).toHaveLength(3);
    expect(listed.permissions.slice(1)).toEqual(
      expect.arrayContaining([
        { kind: "drive#permission", id: "anyoneWithLink", type: "anyone", role: "reader", allowFileDiscovery: false },
        { kind: "drive#permission", id: user.id, type: "user", emailAddress: "bob@fake.test", role: "writer" },
      ]),
    );
    expect(outputSchema("drive.permissions.list").safeParse(listed).success).toBe(true);
  });

  it("validates type, role and the grantee", async () => {
    const { token } = await account([DRIVE]);
    const path = `${FILES}/seed-doc-notes/permissions`;
    expect((await send(token, "POST", path, { role: "reader" })).status).toBe(400);
    expect((await send(token, "POST", path, { type: "anyone", role: "boss" })).status).toBe(400);
    expect((await send(token, "POST", path, { type: "user", role: "reader" })).status).toBe(400);
    expect((await send(token, "POST", path, { type: "domain", role: "reader" })).status).toBe(400);
    expect((await send(token, "POST", `${FILES}/missing/permissions`, { type: "anyone", role: "reader" })).status).toBe(404);
  });
});

describe("faults", () => {
  it("reach the client unchanged", async () => {
    const { email, token } = await account([DRIVE]);
    const body = { error: { code: 500, message: "Backend Error", errors: [{ reason: "backendError" }] } };
    await fake.fault({ email, method: "POST", pathRegex: "/upload/drive/v3/files$", times: 1, response: { status: 500, body } });
    const res = await api(token, `${UPLOAD}?uploadType=media`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(body);
    expect((await fake.requests(email)).filter((r) => r.path.endsWith("/upload/drive/v3/files"))).toHaveLength(1);
  });
});
