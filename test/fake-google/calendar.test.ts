import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import calendarGet from "../../fake-google/fixtures/calendar/calendars-get.json";
import calendarListList from "../../fake-google/fixtures/calendar/calendar-list-list.json";
import eventsInsert from "../../fake-google/fixtures/calendar/events-insert.json";
import eventsList from "../../fake-google/fixtures/calendar/events-list.json";
import { parseFixture, type Fixture } from "../../fake-google/src/fixtures";
import { SEED_NOW, routes } from "../../fake-google/src/routes/calendar";
import { loadConfig } from "../../src/config";
import { googleOAuth } from "../../src/google/oauth";
import { createTransport } from "../../src/google/transport";
import { generatedFns } from "../../src/sdk/generated/index";
import { authorizeAtFake } from "../helpers/accounts";
import { fake, fakeFetch, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const EVENTS_SCOPE = `${G}calendar.events`;
const LIST_SCOPE = `${G}calendar.calendarlist.readonly`;
const BASE = "/www.googleapis.com/calendar/v3";
const FIXTURE_EMAIL = "alice@fake.test";

const transport = createTransport(env, loadConfig(env));

interface EventView {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  [key: string]: unknown;
}
interface EventsView {
  kind: string;
  timeZone?: string;
  items: EventView[];
  nextPageToken?: string;
}

async function account(scopes: string[], email = uniqueEmail("cal")) {
  await fake.seed({ accounts: [{ email, sub: "100000000000000000001", preset: "default" }], now: SEED_NOW });
  const tokens = await googleOAuth(env, transport).exchangeCode(await authorizeAtFake({ email, scopes }));
  return { email, token: tokens.accessToken };
}

function api(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fakeFetch(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
}

async function listEvents(token: string, query: Record<string, string> = {}): Promise<EventsView> {
  const qs = new URLSearchParams(query).toString();
  const res = await api(token, `${BASE}/calendars/primary/events${qs ? `?${qs}` : ""}`);
  expect(res.status).toBe(200);
  return (await res.json()) as EventsView;
}

function outputSchema(fn: string) {
  const def = generatedFns.find((f) => f.name === fn);
  if (!def) throw new Error(`no generated fn ${fn}`);
  return def.output;
}

const SAIGON_TODAY = { timeMin: "2026-11-08T17:00:00.000Z", timeMax: "2026-11-09T17:00:00.000Z" };

describe("scopes", () => {
  const ROUTES = [
    { fn: "calendar.calendars.get", method: "GET", path: `${BASE}/calendars/primary` },
    { fn: "calendar.calendarList.list", method: "GET", path: `${BASE}/users/me/calendarList` },
    { fn: "calendar.calendarList.get", method: "GET", path: `${BASE}/users/me/calendarList/primary` },
    { fn: "calendar.events.list", method: "GET", path: `${BASE}/calendars/primary/events` },
    { fn: "calendar.events.insert", method: "POST", path: `${BASE}/calendars/primary/events` },
    { fn: "calendar.events.delete", method: "DELETE", path: `${BASE}/calendars/primary/events/e1` },
  ] as const;

  it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))("%s requires exactly the method's Discovery scopes", (_name, r) => {
    const route = routes.find((x) => x.method === r.method && x.pattern.test(r.path));
    expect(route, r.fn).toBeDefined();
    const meta = generatedFns.find((f) => f.name === r.fn)?.method;
    expect([...(route?.scopes ?? [])].sort()).toEqual([...(meta?.scopes ?? [])].sort());
  });

  it("refuses each route for a token without any of its scopes", async () => {
    const { token } = await account([`${G}drive.file`]);
    for (const r of ROUTES) {
      const res = await api(token, r.path, { method: r.method });
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      const body = (await res.json()) as { error: { details: Array<{ reason: string }> } };
      expect(body.error.details[0]?.reason).toBe("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    }
  });

  it("lets calendar.events list events but not read the calendar itself", async () => {
    const { token } = await account([EVENTS_SCOPE]);
    expect((await api(token, `${BASE}/calendars/primary/events`)).status).toBe(200);
    expect((await api(token, `${BASE}/calendars/primary`)).status).toBe(403);
  });
});

describe("calendars", () => {
  it("returns the primary calendar with its time zone", async () => {
    const { email, token } = await account([LIST_SCOPE, `${G}calendar.calendars.readonly`]);
    const res = await api(token, `${BASE}/calendars/primary`);
    const cal = (await res.json()) as { id: string; timeZone: string };
    expect(cal).toMatchObject({ kind: "calendar#calendar", id: email, timeZone: "Asia/Saigon" });
    expect(outputSchema("calendar.calendars.get").safeParse(cal).success).toBe(true);
    expect((await api(token, `${BASE}/calendars/${encodeURIComponent(email)}`)).status).toBe(200);
    expect((await api(token, `${BASE}/calendars/someone-else@fake.test`)).status).toBe(404);
  });

  it("lists and gets the calendar list entry with its time zone", async () => {
    const { email, token } = await account([LIST_SCOPE]);
    const list = (await (await api(token, `${BASE}/users/me/calendarList`)).json()) as { items: Array<{ id: string; timeZone: string }> };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: email, timeZone: "Asia/Saigon" });
    expect(outputSchema("calendar.calendarList.list").safeParse(list).success).toBe(true);
    const entry = (await (await api(token, `${BASE}/users/me/calendarList/primary`)).json()) as { timeZone: string };
    expect(entry.timeZone).toBe("Asia/Saigon");
    expect(outputSchema("calendar.calendarList.get").safeParse(entry).success).toBe(true);
  });

  it("falls back to UTC for an account without a calendar record", async () => {
    const email = uniqueEmail("cal-bare");
    await fake.seed({ accounts: [{ email, sub: "100000000000000000009" }] });
    const tokens = await googleOAuth(env, transport).exchangeCode(await authorizeAtFake({ email, scopes: [LIST_SCOPE] }));
    const entry = (await (await api(tokens.accessToken, `${BASE}/users/me/calendarList/primary`)).json()) as { timeZone: string };
    expect(entry.timeZone).toBe("UTC");
  });
});

describe("events.list", () => {
  it("returns the seeded events ordered by start", async () => {
    const { token } = await account([EVENTS_SCOPE]);
    const all = await listEvents(token, { singleEvents: "true", orderBy: "startTime" });
    expect(all.kind).toBe("calendar#events");
    expect(all.timeZone).toBe("Asia/Saigon");
    expect(all.items.map((e) => e.id)).toEqual([
      "seed-evt-yesterday-late",
      "seed-evt-overnight",
      "seed-evt-today-allday",
      "seed-evt-today-early",
      "seed-evt-today-standup",
      "seed-evt-today-late",
      "seed-evt-tomorrow-early",
    ]);
    expect(outputSchema("calendar.events.list").safeParse(all).success).toBe(true);
  });

  it("keeps events that overlap [timeMin, timeMax) and drops the others", async () => {
    const { token } = await account([EVENTS_SCOPE]);
    const day = await listEvents(token, { singleEvents: "true", orderBy: "startTime", ...SAIGON_TODAY });
    expect(day.items.map((e) => e.id)).toEqual([
      "seed-evt-overnight",
      "seed-evt-today-allday",
      "seed-evt-today-early",
      "seed-evt-today-standup",
      "seed-evt-today-late",
    ]);
    // An event that ends exactly at timeMin is outside, and so is one that starts exactly at timeMax.
    const edge = await listEvents(token, { timeMin: "2026-11-08T16:30:00Z", timeMax: "2026-11-08T17:30:00Z" });
    expect(edge.items.map((e) => e.id)).toEqual(["seed-evt-overnight", "seed-evt-today-allday"]);
  });

  it("refuses orderBy=startTime without singleEvents, as Google does", async () => {
    const { token } = await account([EVENTS_SCOPE]);
    const res = await api(token, `${BASE}/calendars/primary/events?orderBy=startTime`);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed timeMin or pageToken", async () => {
    const { token } = await account([EVENTS_SCOPE]);
    expect((await api(token, `${BASE}/calendars/primary/events?timeMin=yesterday`)).status).toBe(400);
    expect((await api(token, `${BASE}/calendars/primary/events?pageToken=abc`)).status).toBe(400);
    expect((await api(token, `${BASE}/calendars/primary/events?maxResults=0`)).status).toBe(400);
  });

  it("pages with maxResults and pageToken", async () => {
    const { token } = await account([EVENTS_SCOPE]);
    const first = await listEvents(token, { singleEvents: "true", orderBy: "startTime", maxResults: "3" });
    expect(first.items).toHaveLength(3);
    expect(first.nextPageToken).toBeDefined();
    const second = await listEvents(token, { singleEvents: "true", orderBy: "startTime", maxResults: "3", pageToken: first.nextPageToken ?? "" });
    expect(second.items).toHaveLength(3);
    const third = await listEvents(token, { singleEvents: "true", orderBy: "startTime", maxResults: "3", pageToken: second.nextPageToken ?? "" });
    expect(third.items).toHaveLength(1);
    expect(third.nextPageToken).toBeUndefined();
  });

  it("filters by q on summary and location", async () => {
    const { token } = await account([EVENTS_SCOPE]);
    expect((await listEvents(token, { q: "standup" })).items.map((e) => e.id)).toEqual(["seed-evt-today-standup"]);
    expect((await listEvents(token, { q: "room 1" })).items.map((e) => e.id)).toEqual(["seed-evt-today-standup"]);
  });
});

describe("events.insert and events.delete", () => {
  it("inserts an event that a later list sees, then deletes it", async () => {
    const { email, token } = await account([EVENTS_SCOPE]);
    const res = await api(token, `${BASE}/calendars/primary/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: "Dentist", start: { dateTime: "2026-11-09T14:00:00+07:00" }, end: { dateTime: "2026-11-09T15:00:00+07:00" } }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as EventView;
    expect(created).toMatchObject({ kind: "calendar#event", summary: "Dentist", status: "confirmed" });
    expect(outputSchema("calendar.events.insert").safeParse(created).success).toBe(true);
    expect((await listEvents(token, SAIGON_TODAY)).items.map((e) => e.id)).toContain(created.id);
    expect((await fake.state(email)).resources[`calendar:event:${email}:${created.id}`]).toMatchObject({ summary: "Dentist" });

    expect((await api(token, `${BASE}/calendars/primary/events/${created.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await listEvents(token, SAIGON_TODAY)).items.map((e) => e.id)).not.toContain(created.id);
    expect((await api(token, `${BASE}/calendars/primary/events/${created.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("rejects an event without a start, with an empty range, or with both date and dateTime", async () => {
    const { token } = await account([EVENTS_SCOPE]);
    const post = (body: unknown) =>
      api(token, `${BASE}/calendars/primary/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ summary: "x" })).status).toBe(400);
    expect((await post({ start: { dateTime: "2026-11-09T14:00:00Z" }, end: { dateTime: "2026-11-09T14:00:00Z" } })).status).toBe(400);
    expect((await post({ start: { date: "2026-11-09", dateTime: "2026-11-09T14:00:00Z" }, end: { date: "2026-11-10" } })).status).toBe(400);
  });
});

describe("fixtures", () => {
  const fixtures: Fixture[] = [parseFixture(calendarGet), parseFixture(calendarListList), parseFixture(eventsList), parseFixture(eventsInsert)];

  function url(fx: Fixture): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(fx.request.query ?? {})) for (const x of [v].flat()) qs.append(k, x);
    return `${fx.request.path}${qs.size > 0 ? `?${qs}` : ""}`;
  }

  it("are what the fake serves for a seeded account", async () => {
    const email = uniqueEmail("cal-replay");
    const { token } = await account([EVENTS_SCOPE, LIST_SCOPE, `${G}calendar.calendars.readonly`], email);
    for (const fx of fixtures) {
      const body = fx.id === "calendar-events-insert" ? { summary: "Dentist", start: { dateTime: "2026-11-09T14:00:00+07:00" }, end: { dateTime: "2026-11-09T15:00:00+07:00" } } : undefined;
      const res = await api(token, url(fx), {
        method: fx.request.method,
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      expect(res.status, fx.id).toBe(fx.response.status);
      const actual = JSON.parse((await res.text()).replaceAll(email, FIXTURE_EMAIL)) as Record<string, unknown>;
      const expected = fx.response.body as Record<string, unknown>;
      if (fx.id === "calendar-events-insert") {
        // A new event has a fresh id, etag and link; the rest is stable.
        const volatile = ["id", "etag", "htmlLink", "iCalUID"];
        for (const k of volatile) {
          delete actual[k];
          delete expected[k];
        }
      }
      expect(actual, fx.id).toEqual(expected);
    }
  });
});
