import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import labelsList from "../../fake-google/fixtures/gmail/labels-list.json";
import messagesGetFull from "../../fake-google/fixtures/gmail/messages-get-full.json";
import messagesGetMetadata from "../../fake-google/fixtures/gmail/messages-get-metadata.json";
import messagesList from "../../fake-google/fixtures/gmail/messages-list.json";
import messagesSend from "../../fake-google/fixtures/gmail/messages-send.json";
import profile from "../../fake-google/fixtures/gmail/profile.json";
import { parseFixture, type Fixture } from "../../fake-google/src/fixtures";
import { routes } from "../../fake-google/src/routes/gmail";
import { loadConfig } from "../../src/config";
import { googleOAuth } from "../../src/google/oauth";
import { createTransport } from "../../src/google/transport";
import { generatedFns } from "../../src/sdk/generated/index";
import { authorizeAtFake } from "../helpers/accounts";
import { fake, fakeFetch, uniqueEmail } from "../helpers/fake";

const MAIL = "https://mail.google.com/";
const G = "https://www.googleapis.com/auth/";
const BASE = "/gmail.googleapis.com/gmail/v1/users/me";
const FIXTURE_EMAIL = "alice@fake.test";
const FIXTURE_SUB = "100000000000000000001";

const transport = createTransport(env, loadConfig(env));

/** Seeds a fresh account (preset "default") and returns a real fake access token holding `scopes`. */
async function account(scopes: string[], opts: { preset?: boolean; email?: string } = {}) {
  const email = opts.email ?? uniqueEmail("gmail");
  await fake.seed({ accounts: [{ email, sub: FIXTURE_SUB, ...(opts.preset === false ? {} : { preset: "default" }) }] });
  const tokens = await googleOAuth(env, transport).exchangeCode(await authorizeAtFake({ email, scopes }));
  return { email, token: tokens.accessToken };
}

function api(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fakeFetch(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
}

function post(token: string, path: string, body?: unknown): Promise<Response> {
  return api(token, path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function rfc822(headers: Record<string, string>, body: string): string {
  return [...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", body].join("\r\n");
}

interface Part {
  partId: string;
  mimeType: string;
  filename: string;
  headers: Array<{ name: string; value: string }>;
  body: { size: number; data?: string };
  parts?: Part[];
}

interface MessageView {
  snippet: string;
  payload?: Part;
  raw?: string;
}

async function message(res: Response): Promise<MessageView> {
  return (await res.json()) as MessageView;
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
  { fixture: parseFixture(messagesList), fn: "gmail.users.messages.list" },
  { fixture: parseFixture(messagesGetFull), fn: "gmail.users.messages.get" },
  { fixture: parseFixture(messagesGetMetadata), fn: "gmail.users.messages.get" },
  {
    fixture: parseFixture(messagesSend),
    fn: "gmail.users.messages.send",
    body: { raw: "VG86IGJvYkBmYWtlLnRlc3QNClN1YmplY3Q6IEhpDQoNCkhlbGxvIEJvYi4" },
  },
  { fixture: parseFixture(labelsList), fn: "gmail.users.labels.list" },
  { fixture: parseFixture(profile), fn: "gmail.users.getProfile" },
];

/** Every route with a sample path and its SDK method. */
const ROUTES = [
  { fn: "gmail.users.messages.list", method: "GET", path: `${BASE}/messages` },
  { fn: "gmail.users.messages.get", method: "GET", path: `${BASE}/messages/m-seed-welcome` },
  { fn: "gmail.users.messages.send", method: "POST", path: `${BASE}/messages/send` },
  { fn: "gmail.users.messages.delete", method: "DELETE", path: `${BASE}/messages/m-seed-welcome` },
  { fn: "gmail.users.messages.trash", method: "POST", path: `${BASE}/messages/m-seed-welcome/trash` },
  { fn: "gmail.users.labels.list", method: "GET", path: `${BASE}/labels` },
  { fn: "gmail.users.getProfile", method: "GET", path: `${BASE}/profile` },
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
    const { token } = await account([MAIL], { email });
    for (const { fixture, body } of FIXTURES) {
      const res = await api(token, fixtureUrl(fixture), {
        method: fixture.request.method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      });
      expect(res.status, fixture.id).toBe(fixture.response.status);
      const actual = JSON.parse((await res.text()).replaceAll(email, FIXTURE_EMAIL)) as Record<string, unknown>;
      if (fixture.request.method === "GET") {
        expect(actual, fixture.id).toEqual(fixture.response.body);
      } else {
        // Writes mint fresh ids; everything else must match.
        const expected = fixture.response.body as Record<string, unknown>;
        expect(Object.keys(actual).sort(), fixture.id).toEqual(Object.keys(expected).sort());
        expect(actual.labelIds, fixture.id).toEqual(expected.labelIds);
      }
    }
  });
});

describe("scopes", () => {
  it.each(ROUTES.map((r) => [r.fn, r] as const))("%s requires exactly the method's Discovery scopes", (fn, r) => {
    const route = routes.find((x) => x.method === r.method && x.pattern.test(r.path));
    expect(route, fn).toBeDefined();
    const meta = generatedFns.find((f) => f.name === fn)?.method;
    expect([...(route?.scopes ?? [])].sort()).toEqual([...(meta?.scopes ?? [])].sort());
  });

  it("refuses each route for a token without any of its scopes", async () => {
    const { token } = await account([`${G}calendar.events`]);
    for (const r of ROUTES) {
      const res = await api(token, r.path, { method: r.method });
      expect(res.status, r.fn).toBe(403);
      const body = (await res.json()) as { error: { details: Array<{ reason: string }> } };
      expect(body.error.details[0]?.reason, r.fn).toBe("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    }
  });

  it("lets gmail.readonly read but not delete", async () => {
    const { token } = await account([`${G}gmail.readonly`]);
    expect((await api(token, `${BASE}/messages`)).status).toBe(200);
    expect((await api(token, `${BASE}/messages/m-seed-welcome`, { method: "DELETE" })).status).toBe(403);
  });
});

describe("users.messages", () => {
  it("lists newest first with maxResults and pageToken", async () => {
    const { token } = await account([MAIL]);
    const first = (await (await api(token, `${BASE}/messages?maxResults=2`)).json()) as Record<string, unknown>;
    expect(first).toEqual({
      messages: [
        { id: "m-seed-report", threadId: "t-m-seed-report" },
        { id: "m-seed-invoice", threadId: "t-m-seed-invoice" },
      ],
      nextPageToken: "2",
      resultSizeEstimate: 3,
    });
    const second = (await (await api(token, `${BASE}/messages?maxResults=2&pageToken=2`)).json()) as Record<string, unknown>;
    expect(second).toEqual({ messages: [{ id: "m-seed-welcome", threadId: "t-m-seed-welcome" }], resultSizeEstimate: 3 });
    expect((await api(token, `${BASE}/messages?pageToken=abc`)).status).toBe(400);
    expect((await api(token, `${BASE}/messages?maxResults=0`)).status).toBe(400);
  });

  it("filters by q as a case-insensitive subject substring, and by labelIds", async () => {
    const { token } = await account([MAIL]);
    const ids = async (query: string) =>
      (((await (await api(token, `${BASE}/messages?${query}`)).json()) as { messages?: Array<{ id: string }> }).messages ?? []).map((m) => m.id);
    expect(await ids("q=invoice")).toEqual(["m-seed-invoice"]);
    expect(await ids(`q=${encodeURIComponent("subject:WEEKLY")}`)).toEqual(["m-seed-report"]);
    expect(await ids("q=no-such-subject")).toEqual([]);
    expect(await ids("labelIds=IMPORTANT")).toEqual(["m-seed-report"]);
    expect(await ids("labelIds=INBOX&labelIds=UNREAD")).toEqual(["m-seed-welcome"]);
  });

  it("returns an empty mailbox without a messages field", async () => {
    const { token } = await account([MAIL], { preset: false });
    expect(await (await api(token, `${BASE}/messages`)).json()).toEqual({ resultSizeEstimate: 0 });
  });

  it("gets a message as metadata, full, minimal and raw", async () => {
    const { token } = await account([MAIL]);
    const full = await message(await api(token, `${BASE}/messages/m-seed-welcome`));
    expect(full.payload?.mimeType).toBe("text/plain");
    expect(full.snippet).toBe("Hello! This mailbox is served by the fake Google.");
    const meta = await message(await api(token, `${BASE}/messages/m-seed-welcome?format=metadata&metadataHeaders=subject`));
    expect(meta.payload).toEqual({ mimeType: "text/plain", headers: [{ name: "Subject", value: "Welcome to the fake mailbox" }] });
    const minimal = await message(await api(token, `${BASE}/messages/m-seed-welcome?format=minimal`));
    expect(minimal.payload).toBeUndefined();
    const raw = await message(await api(token, `${BASE}/messages/m-seed-welcome?format=raw`));
    expect(typeof raw.raw).toBe("string");
    expect(outputSchema("gmail.users.messages.get").safeParse(full).success).toBe(true);
    expect((await api(token, `${BASE}/messages/m-seed-welcome?format=bogus`)).status).toBe(400);
    expect((await api(token, `${BASE}/messages/nope`)).status).toBe(404);
  });

  it("decodes multipart parts and their transfer encoding", async () => {
    const { token } = await account([MAIL]);
    const msg = await message(await api(token, `${BASE}/messages/m-seed-invoice`));
    const [text, pdf] = msg.payload?.parts ?? [];
    expect(text?.partId).toBe("0");
    expect(pdf).toMatchObject({ partId: "1", mimeType: "application/pdf", filename: "invoice.pdf" });
    const bytes = atob((pdf?.body.data ?? "").replace(/-/g, "+").replace(/_/g, "/"));
    expect(bytes.startsWith("%PDF-1.4")).toBe(true);
  });

  it("sends a message: stores it, records To/Subject, and lists it", async () => {
    const { email, token } = await account([MAIL]);
    const raw = b64url(rfc822({ To: "bob@fake.test", Subject: "Quarterly numbers", "Content-Type": "text/plain" }, "See attached."));
    const res = await post(token, `${BASE}/messages/send`, { raw });
    expect(res.status).toBe(200);
    const sent = (await res.json()) as { id: string; threadId: string; labelIds: string[] };
    expect(sent.labelIds).toEqual(["SENT"]);
    expect(sent.threadId).toBe(sent.id);
    expect(outputSchema("gmail.users.messages.send").safeParse(sent).success).toBe(true);

    const state = await fake.state(email);
    expect(state.resources[`gmail:message:${email}:${sent.id}`]).toMatchObject({ to: "bob@fake.test", subject: "Quarterly numbers" });
    const listed = (await (await api(token, `${BASE}/messages?q=quarterly`)).json()) as { messages: Array<{ id: string }> };
    expect(listed.messages.map((m) => m.id)).toEqual([sent.id]);
    const got = await message(await api(token, `${BASE}/messages/${sent.id}?format=metadata&metadataHeaders=To`));
    expect(got.payload?.headers).toEqual([{ name: "To", value: "bob@fake.test" }]);
  });

  it("rejects a send without raw, with bad base64 or without a recipient", async () => {
    const { token } = await account([MAIL]);
    expect((await post(token, `${BASE}/messages/send`, {})).status).toBe(400);
    expect((await post(token, `${BASE}/messages/send`, { raw: "!!!" })).status).toBe(400);
    expect((await post(token, `${BASE}/messages/send`, { raw: b64url(rfc822({ Subject: "x" }, "y")) })).status).toBe(400);
  });

  it("trashes a message out of the default list, and deletes permanently", async () => {
    const { token } = await account([MAIL]);
    const trashed = (await (await post(token, `${BASE}/messages/m-seed-report/trash`)).json()) as { labelIds: string[] };
    expect(trashed.labelIds).toEqual(["IMPORTANT", "TRASH"]);
    const ids = async (query = "") =>
      (((await (await api(token, `${BASE}/messages${query}`)).json()) as { messages?: Array<{ id: string }> }).messages ?? []).map((m) => m.id);
    expect(await ids()).not.toContain("m-seed-report");
    expect(await ids("?includeSpamTrash=true")).toContain("m-seed-report");

    const del = await api(token, `${BASE}/messages/m-seed-invoice`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    expect((await api(token, `${BASE}/messages/m-seed-invoice`)).status).toBe(404);
    expect((await api(token, `${BASE}/messages/m-seed-invoice`, { method: "DELETE" })).status).toBe(404);
  });

  it("refuses another user's mailbox", async () => {
    const { token } = await account([MAIL]);
    const res = await api(token, "/gmail.googleapis.com/gmail/v1/users/someone-else@fake.test/messages");
    expect(res.status).toBe(403);
  });

  it("accepts the token owner's email as userId", async () => {
    const { email, token } = await account([MAIL]);
    expect((await api(token, `/gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(email)}/profile`)).status).toBe(200);
  });
});

describe("labels and profile", () => {
  it("lists system labels and the seeded user label", async () => {
    const { token } = await account([MAIL]);
    const body = (await (await api(token, `${BASE}/labels`)).json()) as { labels: Array<{ id: string; type: string }> };
    expect(body.labels.find((l) => l.id === "INBOX")).toEqual({ id: "INBOX", name: "INBOX", type: "system" });
    expect(body.labels.find((l) => l.id === "Label_1")).toMatchObject({ name: "Projects", type: "user" });
  });

  it("reports the profile of the token owner", async () => {
    const { email, token } = await account([MAIL]);
    expect(await (await api(token, `${BASE}/profile`)).json()).toEqual({
      emailAddress: email,
      messagesTotal: 3,
      threadsTotal: 3,
      historyId: "1003",
    });
  });
});

describe("faults", () => {
  it("reach the client unchanged", async () => {
    const { email, token } = await account([MAIL]);
    const body = { error: { code: 429, message: "Too many", status: "RESOURCE_EXHAUSTED", errors: [{ reason: "rateLimitExceeded" }] } };
    await fake.fault({ email, method: "GET", pathRegex: "/messages$", times: 1, response: { status: 429, headers: { "retry-after": "7" }, body } });
    const res = await api(token, `${BASE}/messages`);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(await res.json()).toEqual(body);
    expect((await api(token, `${BASE}/messages`)).status).toBe(200);
  });
});
