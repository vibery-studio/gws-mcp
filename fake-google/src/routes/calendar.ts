import { googleError } from "../oauth";
import { fakeKey, type JsonValue } from "../store";
import type { FakeContext, FakeRoute, SeedPresets } from "./index";

// ---------- model ----------

/**
 * The fixed clock the seeded events are written against: tests seed it as `now` for the account.
 * 2026-11-09 12:00 in Asia/Saigon (UTC+7), the time zone of the seeded calendar.
 */
export const SEED_NOW = Date.parse("2026-11-09T05:00:00Z");
const SEED_TIME_ZONE = "Asia/Saigon";
const DEFAULT_TIME_ZONE = "UTC";

/** Stored at `calendar:calendar:<email>:primary`. An account without one has an empty UTC calendar. */
interface CalendarRecord {
  [key: string]: JsonValue;
  id: string;
  summary: string;
  timeZone: string;
}

type EventTime = { date?: string; dateTime?: string; timeZone?: string };

/** Stored at `calendar:event:<email>:<id>`. The fake has one calendar per account, so the id alone is the key. */
interface EventRecord {
  [key: string]: JsonValue;
  kind: "calendar#event";
  id: string;
  status: string;
  start: EventTime;
  end: EventTime;
  created: string;
  updated: string;
}

const calendarKey = (email: string) => fakeKey("calendar", "calendar", email, "primary");
const eventKey = (email: string, id: string) => fakeKey("calendar", "event", email, id);

async function calendarOf(ctx: FakeContext): Promise<CalendarRecord> {
  return (await ctx.store.get<CalendarRecord>(calendarKey(ctx.email))) ?? { id: ctx.email, summary: ctx.email, timeZone: DEFAULT_TIME_ZONE };
}

/** The one calendar of an account is addressed as "primary" or by its email. */
const ownsCalendar = (ctx: FakeContext, id: string) => id === "primary" || id.toLowerCase() === ctx.email.toLowerCase();

// ---------- errors ----------

function notFound(message = "Not Found"): Response {
  return googleError(404, message, "NOT_FOUND", { errors: [{ message, domain: "global", reason: "notFound" }] });
}

function badRequest(message: string, reason = "badRequest"): Response {
  return googleError(400, message, "INVALID_ARGUMENT", { errors: [{ message, domain: "global", reason }] });
}

// ---------- time ----------

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Offset of `timeZone` from UTC at the instant `utc`, in ms. */
function offsetMs(utc: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(utc);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return local - Math.floor(utc / 1000) * 1000;
}

/** The instant of local midnight at the start of `date` (YYYY-MM-DD) in `timeZone`. */
function startOfDay(date: string, timeZone: string): number | undefined {
  const m = DATE_ONLY.exec(date);
  if (!m) return undefined;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(guess)) return undefined;
  return guess - offsetMs(guess - offsetMs(guess, timeZone), timeZone);
}

/** The instant of an event time; an all-day date starts at midnight of the calendar's time zone. */
function instant(t: EventTime, timeZone: string): number | undefined {
  if (typeof t.dateTime === "string") {
    if (!RFC3339.test(t.dateTime)) return undefined;
    const ms = Date.parse(t.dateTime);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return typeof t.date === "string" ? startOfDay(t.date, timeZone) : undefined;
}

/** Exactly one of `date` and `dateTime`, well formed. */
function validTime(t: unknown, timeZone: string): t is EventTime {
  if (typeof t !== "object" || t === null || Array.isArray(t)) return false;
  const { date, dateTime } = t as EventTime;
  if ((date === undefined) === (dateTime === undefined)) return false;
  return instant(t as EventTime, timeZone) !== undefined;
}

// ---------- handlers ----------

const calendarIdOf = (ctx: FakeContext) => decodeURIComponent(ctx.match[1] ?? "");
const DEFAULT_PAGE = 250;
const MAX_PAGE = 2500;

function listEntry(cal: CalendarRecord): Record<string, JsonValue> {
  return {
    kind: "calendar#calendarListEntry",
    etag: `"fake-${cal.id}"`,
    id: cal.id,
    summary: cal.summary,
    timeZone: cal.timeZone,
    accessRole: "owner",
    primary: true,
    selected: true,
  };
}

async function getCalendar(ctx: FakeContext): Promise<Response> {
  if (!ownsCalendar(ctx, calendarIdOf(ctx))) return notFound();
  const cal = await calendarOf(ctx);
  return Response.json({ kind: "calendar#calendar", etag: `"fake-${cal.id}"`, id: cal.id, summary: cal.summary, timeZone: cal.timeZone });
}

async function listCalendars(ctx: FakeContext): Promise<Response> {
  return Response.json({ kind: "calendar#calendarList", etag: '"fake-list"', items: [listEntry(await calendarOf(ctx))] });
}

async function getListEntry(ctx: FakeContext): Promise<Response> {
  if (!ownsCalendar(ctx, calendarIdOf(ctx))) return notFound();
  return Response.json(listEntry(await calendarOf(ctx)));
}

function matchesQuery(e: EventRecord, q: string): boolean {
  const attendees = Array.isArray(e.attendees) ? e.attendees.map((a) => (a as { email?: unknown } | null)?.email) : [];
  return [e.summary, e.description, e.location, ...attendees].some((v) => typeof v === "string" && v.toLowerCase().includes(q));
}

async function listEvents(ctx: FakeContext): Promise<Response> {
  if (!ownsCalendar(ctx, calendarIdOf(ctx))) return notFound();
  const cal = await calendarOf(ctx);
  const p = ctx.url.searchParams;

  const bound = (name: string): number | undefined | "bad" => {
    const v = p.get(name);
    if (v === null) return undefined;
    return RFC3339.test(v) && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : "bad";
  };
  const timeMin = bound("timeMin");
  const timeMax = bound("timeMax");
  if (timeMin === "bad" || timeMax === "bad") return badRequest("Bad Request");

  const orderBy = p.get("orderBy");
  if (orderBy !== null && orderBy !== "startTime" && orderBy !== "updated") return badRequest(`Invalid value for orderBy: ${orderBy}`, "invalidParameter");
  if (orderBy === "startTime" && p.get("singleEvents") !== "true") {
    return badRequest("The requested ordering is not available for the particular query.");
  }
  const sizeRaw = p.get("maxResults");
  const size = sizeRaw === null ? DEFAULT_PAGE : Number(sizeRaw);
  if (!Number.isInteger(size) || size < 1) return badRequest("Invalid maxResults", "invalidParameter");
  const tokenRaw = p.get("pageToken");
  if (tokenRaw !== null && !/^\d{1,9}$/.test(tokenRaw)) return badRequest("Invalid pageToken", "invalidParameter");
  const offset = tokenRaw === null ? 0 : Number(tokenRaw);
  const q = p.get("q")?.toLowerCase();

  const rows: Array<{ event: EventRecord; start: number; end: number }> = [];
  for (const [, event] of await ctx.store.list<EventRecord>(`calendar:event:${ctx.email}:`)) {
    const start = instant(event.start, cal.timeZone);
    const end = instant(event.end, cal.timeZone);
    if (start === undefined || end === undefined) continue;
    // Google: an event is returned when it ends after timeMin and starts before timeMax.
    if (timeMin !== undefined && end <= timeMin) continue;
    if (timeMax !== undefined && start >= timeMax) continue;
    if (q !== undefined && !matchesQuery(event, q)) continue;
    rows.push({ event, start, end });
  }
  rows.sort((a, b) =>
    orderBy === "updated"
      ? a.event.updated.localeCompare(b.event.updated) || a.event.id.localeCompare(b.event.id)
      : a.start - b.start || a.end - b.end || a.event.id.localeCompare(b.event.id),
  );
  const page = rows.slice(offset, offset + Math.min(size, MAX_PAGE));
  const body: Record<string, JsonValue> = {
    kind: "calendar#events",
    etag: '"fake-events"',
    summary: cal.summary,
    updated: new Date(ctx.now()).toISOString(),
    timeZone: cal.timeZone,
    accessRole: "owner",
    defaultReminders: [],
  };
  if (offset + page.length < rows.length) body.nextPageToken = String(offset + page.length);
  body.items = page.map((r) => r.event);
  return Response.json(body);
}

const EVENT_ID = /^[a-v0-9]{5,1024}$/;

function newEventId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => "0123456789abcdefghijklmnopqrstuv"[b % 32]).join("");
}

async function insertEvent(ctx: FakeContext): Promise<Response> {
  if (!ownsCalendar(ctx, calendarIdOf(ctx))) return notFound();
  const cal = await calendarOf(ctx);
  let body: unknown;
  try {
    body = JSON.parse((await ctx.req.text()) || "{}");
  } catch {
    return badRequest("Invalid JSON payload received.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return badRequest("Invalid JSON payload received.");
  const input = body as Record<string, unknown>;
  if (!validTime(input.start, cal.timeZone)) return badRequest("Missing or invalid start time.", "required");
  if (!validTime(input.end, cal.timeZone)) return badRequest("Missing or invalid end time.", "required");
  const start = instant(input.start, cal.timeZone) ?? 0;
  const end = instant(input.end, cal.timeZone) ?? 0;
  if (end <= start) return badRequest("The specified time range is empty.", "timeRangeEmpty");
  if (input.id !== undefined && (typeof input.id !== "string" || !EVENT_ID.test(input.id))) return badRequest("Invalid resource id value.", "invalid");
  const id = typeof input.id === "string" ? input.id : newEventId();
  if (await ctx.store.get(eventKey(ctx.email, id))) {
    return googleError(409, "The requested identifier already exists.", "ALREADY_EXISTS", {
      errors: [{ message: "The requested identifier already exists.", domain: "global", reason: "duplicate" }],
    });
  }
  const now = new Date(ctx.now()).toISOString();
  const record: EventRecord = {
    kind: "calendar#event",
    etag: `"fake-${id}"`,
    id,
    status: "confirmed",
    htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
    created: now,
    updated: now,
    creator: { email: ctx.email, self: true },
    organizer: { email: ctx.email, self: true },
    iCalUID: `${id}@google.com`,
    sequence: 0,
    reminders: { useDefault: true },
    eventType: "default",
    start: input.start,
    end: input.end,
  };
  for (const k of ["summary", "description", "location"] as const) {
    const v = input[k];
    if (v === undefined) continue;
    if (typeof v !== "string") return badRequest(`Invalid value for ${k}`, "invalid");
    record[k] = v;
  }
  if (input.attendees !== undefined) {
    const list = input.attendees;
    if (!Array.isArray(list) || !list.every((a) => typeof a === "object" && a !== null && typeof (a as { email?: unknown }).email === "string")) {
      return badRequest("Invalid value for attendees", "invalid");
    }
    record.attendees = (list as Array<Record<string, JsonValue>>).map((a) => ({ responseStatus: "needsAction", ...a }));
  }
  await ctx.store.put(eventKey(ctx.email, id), record);
  return Response.json(record);
}

async function deleteEvent(ctx: FakeContext): Promise<Response> {
  if (!ownsCalendar(ctx, calendarIdOf(ctx))) return notFound();
  const deleted = await ctx.store.delete(eventKey(ctx.email, decodeURIComponent(ctx.match[2] ?? "")));
  return deleted ? new Response(null, { status: 204 }) : notFound();
}

// ---------- routes ----------

const G = "https://www.googleapis.com/auth/";
const CAL = "^/www\\.googleapis\\.com/calendar/v3";
const CAL_ID = "([^/]+)";

/** Scopes per route: the Discovery `scopes` of the method (checked against the generated SDK in tests). */
const SCOPES = {
  calendarsGet: [`${G}calendar`, `${G}calendar.app.created`, `${G}calendar.calendars`, `${G}calendar.calendars.readonly`, `${G}calendar.readonly`],
  listList: [`${G}calendar`, `${G}calendar.calendarlist`, `${G}calendar.calendarlist.readonly`, `${G}calendar.readonly`],
  listGet: [`${G}calendar`, `${G}calendar.app.created`, `${G}calendar.calendarlist`, `${G}calendar.calendarlist.readonly`, `${G}calendar.readonly`],
  eventsList: [
    `${G}calendar`,
    `${G}calendar.app.created`,
    `${G}calendar.events`,
    `${G}calendar.events.freebusy`,
    `${G}calendar.events.owned`,
    `${G}calendar.events.owned.readonly`,
    `${G}calendar.events.public.readonly`,
    `${G}calendar.events.readonly`,
    `${G}calendar.readonly`,
  ],
  eventsWrite: [`${G}calendar`, `${G}calendar.app.created`, `${G}calendar.events`, `${G}calendar.events.owned`],
};

export const routes: FakeRoute[] = [
  { method: "GET", pattern: new RegExp(`${CAL}/users/me/calendarList$`), scopes: SCOPES.listList, handle: listCalendars },
  { method: "GET", pattern: new RegExp(`${CAL}/users/me/calendarList/${CAL_ID}$`), scopes: SCOPES.listGet, handle: getListEntry },
  { method: "GET", pattern: new RegExp(`${CAL}/calendars/${CAL_ID}$`), scopes: SCOPES.calendarsGet, handle: getCalendar },
  { method: "GET", pattern: new RegExp(`${CAL}/calendars/${CAL_ID}/events$`), scopes: SCOPES.eventsList, handle: listEvents },
  { method: "POST", pattern: new RegExp(`${CAL}/calendars/${CAL_ID}/events$`), scopes: SCOPES.eventsWrite, handle: insertEvent },
  { method: "DELETE", pattern: new RegExp(`${CAL}/calendars/${CAL_ID}/events/([^/]+)$`), scopes: SCOPES.eventsWrite, handle: deleteEvent },
];

// ---------- seed preset ----------

function seedEvent(id: string, summary: string, start: EventTime, end: EventTime, extra: Record<string, JsonValue> = {}) {
  const value: EventRecord = {
    kind: "calendar#event",
    etag: `"fake-${id}"`,
    id,
    status: "confirmed",
    htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
    summary,
    created: "2026-11-01T09:00:00.000Z",
    updated: "2026-11-01T09:00:00.000Z",
    creator: { email: "{email}", self: true },
    organizer: { email: "{email}", self: true },
    iCalUID: `${id}@google.com`,
    sequence: 0,
    reminders: { useDefault: true },
    eventType: "default",
    start,
    end,
    ...extra,
  };
  return { key: `calendar:event:{email}:${id}`, value };
}

const at = (dateTime: string): EventTime => ({ dateTime, timeZone: SEED_TIME_ZONE });

/**
 * Events around the fixed clock (2026-11-09 in Asia/Saigon): one that ends before today, one that runs across
 * midnight into today, an all-day one, three inside today (one just after midnight, one just before the next
 * midnight), and one just after today ends. A window computed in UTC instead of the calendar's zone gets
 * the edge ones wrong.
 */
export const presets: SeedPresets = {
  default: [
    { key: "calendar:calendar:{email}:primary", value: { id: "{email}", summary: "{email}", timeZone: SEED_TIME_ZONE } },
    seedEvent("seed-evt-yesterday-late", "Yesterday review", at("2026-11-08T22:00:00+07:00"), at("2026-11-08T23:30:00+07:00")),
    seedEvent("seed-evt-overnight", "Overnight maintenance", at("2026-11-08T23:00:00+07:00"), at("2026-11-09T01:30:00+07:00")),
    seedEvent("seed-evt-today-allday", "Focus day", { date: "2026-11-09" }, { date: "2026-11-10" }),
    seedEvent("seed-evt-today-early", "Early sync", at("2026-11-09T00:30:00+07:00"), at("2026-11-09T01:00:00+07:00")),
    seedEvent("seed-evt-today-standup", "Standup", at("2026-11-09T09:00:00+07:00"), at("2026-11-09T09:30:00+07:00"), {
      location: "Room 1",
      attendees: [
        { email: "bob@fake.test", responseStatus: "accepted" },
        { email: "carol@fake.test", responseStatus: "needsAction" },
      ],
    }),
    seedEvent("seed-evt-today-late", "Late call", at("2026-11-09T23:00:00+07:00"), at("2026-11-09T23:30:00+07:00")),
    seedEvent("seed-evt-tomorrow-early", "Tomorrow kickoff", at("2026-11-10T00:15:00+07:00"), at("2026-11-10T01:00:00+07:00")),
  ],
};
