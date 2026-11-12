import { z } from "zod";
import type { FnDef } from "../../contracts";
import { GwsError } from "../../errors";
import { dayWindow } from "./today-agenda";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_SPAN_DAYS = 31;
const MAX_SLOTS = 100;
const MAX_ACCOUNTS = 10;

const Ref = z.string().min(1).max(320);
const CalendarId = z.string().min(1).max(320).default("primary");
const Id = z.string().min(1).max(1024);

const isPending = (v: unknown): v is { __gwsPending: string } => typeof v === "object" && v !== null && "__gwsPending" in v;
const accountOf = (account: string | undefined) => (account === undefined ? {} : { account });

const Planned = z.strictObject({ applied: z.literal(false), step: z.string() });

// ---------- share and unshare ----------

/** Who a rule is for: one person by email, or everyone (a public calendar). */
const Audience = { email: z.string().min(3).max(320).optional(), public: z.boolean().optional() };

function exactlyOneAudience(v: { email?: string | undefined; public?: boolean | undefined }, issues: z.RefinementCtx): void {
  if ((v.email === undefined) === (v.public !== true)) {
    issues.addIssue({ code: "custom", path: ["email"], message: "give exactly one of email or public:true" });
  }
}

const scopeOf = (v: { email?: string | undefined }) => (v.email === undefined ? { type: "default" } : { type: "user", value: v.email });

const ShareInput = z
  .strictObject({
    account: Ref.optional(),
    calendarId: CalendarId,
    ...Audience,
    role: z.enum(["freeBusyReader", "reader", "writer"]),
  })
  .superRefine(exactlyOneAudience);
type ShareInput = z.output<typeof ShareInput>;

const Shared = z.strictObject({ applied: z.literal(true), ruleId: z.string(), role: z.string() });
const ShareOutput = z.union([Planned, Shared]);
type ShareOutput = z.output<typeof ShareOutput>;

const AclRule = z.looseObject({ id: z.string().optional(), role: z.string().optional() });

const shareDef: FnDef<ShareInput, ShareOutput> = {
  kind: "host",
  name: "calendar.share",
  service: "helpers",
  effect: "write",
  description:
    "Shares a calendar: gives one person (email) free/busy, read or edit access, or with public:true opens it to everyone, which is destructive (public share). A dry-run plans the access rule; apply:true adds it and Google emails the person. Owner access is not granted here.",
  signature:
    'calendar.share({ email?: string, public?: boolean, role: "freeBusyReader" | "reader" | "writer", calendarId?: string, account?: string }): Promise<{ applied: false, step: string } | { applied: true, ruleId: string, role: string }>',
  tsDecl: [
    "type Input = {",
    "  email?: string; // the person to share with; exactly one of email and public",
    "  public?: boolean; // true shares with everyone (destructive)",
    '  role: "freeBusyReader" | "reader" | "writer";',
    '  calendarId?: string; // default "primary"',
    "  account?: string;",
    "};",
    "type Output = { applied: false; step: string } // dry-run: re-run with apply:true",
    "  | { applied: true; ruleId: string; role: string };",
  ].join("\n"),
  example: 'await sdk.calendar.share({ email: "colleague@example.com", role: "reader" })',
  tags: ["helpers", "calendar", "share", "sharing", "access", "permission", "acl", "invite", "free", "busy", "write"],
  scopes: ["https://www.googleapis.com/auth/calendar.acls"],
  input: ShareInput,
  output: ShareOutput,
  async run(input, ctx) {
    const { calendarId, role } = input;
    const res = await ctx.call("calendar.acl.insert", { calendarId, requestBody: { role, scope: scopeOf(input) }, ...accountOf(input.account) });
    if (isPending(res)) return { applied: false, step: res.__gwsPending };
    const rule = AclRule.safeParse(res);
    if (!rule.success) throw new GwsError("GWS_RESPONSE_SHAPE", "calendar.acl.insert returned an unexpected shape");
    return { applied: true, ruleId: rule.data.id ?? (input.email === undefined ? "default" : `user:${input.email}`), role: rule.data.role ?? role };
  },
};

const UnshareInput = z.strictObject({ account: Ref.optional(), calendarId: CalendarId, ...Audience }).superRefine(exactlyOneAudience);
type UnshareInput = z.output<typeof UnshareInput>;

const Unshared = z.strictObject({ applied: z.literal(true), ruleId: z.string() });
const UnshareOutput = z.union([Planned, Unshared]);
type UnshareOutput = z.output<typeof UnshareOutput>;

const unshareDef: FnDef<UnshareInput, UnshareOutput> = {
  kind: "host",
  name: "calendar.unshare",
  service: "helpers",
  effect: "write",
  description:
    "Stops sharing a calendar with one person (email) or with everyone (public:true) by deleting that access rule. Destructive: a dry-run plans it, apply:true removes the access.",
  signature:
    "calendar.unshare({ email?: string, public?: boolean, calendarId?: string, account?: string }): Promise<{ applied: false, step: string } | { applied: true, ruleId: string }>",
  tsDecl: [
    "type Input = {",
    "  email?: string; // exactly one of email and public",
    "  public?: boolean; // true removes the public (everyone) rule",
    '  calendarId?: string; // default "primary"',
    "  account?: string;",
    "};",
    "type Output = { applied: false; step: string } // dry-run: re-run with apply:true",
    "  | { applied: true; ruleId: string };",
  ].join("\n"),
  example: 'await sdk.calendar.unshare({ email: "colleague@example.com" })',
  tags: ["helpers", "calendar", "unshare", "stop", "sharing", "revoke", "remove", "access", "permission", "acl", "delete", "write"],
  scopes: ["https://www.googleapis.com/auth/calendar.acls"],
  input: UnshareInput,
  output: UnshareOutput,
  async run(input, ctx) {
    const ruleId = input.email === undefined ? "default" : `user:${input.email}`;
    const res = await ctx.call("calendar.acl.delete", { calendarId: input.calendarId, ruleId, ...accountOf(input.account) });
    return isPending(res) ? { applied: false, step: res.__gwsPending } : { applied: true, ruleId };
  },
};

// ---------- respond and move ----------

const RespondInput = z.strictObject({
  account: Ref.optional(),
  calendarId: CalendarId,
  eventId: Id,
  response: z.enum(["accepted", "declined", "tentative"]),
});
type RespondInput = z.output<typeof RespondInput>;

const Responded = z.strictObject({ applied: z.literal(true), eventId: z.string(), response: z.string() });
const RespondOutput = z.union([Planned, Responded]);
type RespondOutput = z.output<typeof RespondOutput>;

const Attendee = z.looseObject({ email: z.string().optional(), self: z.boolean().optional(), responseStatus: z.string().optional() });
const EventWithAttendees = z.looseObject({ attendees: z.array(Attendee).optional() });

const respondDef: FnDef<RespondInput, RespondOutput> = {
  kind: "host",
  name: "calendar.respond",
  service: "helpers",
  effect: "write",
  description:
    "Answers a calendar invitation (accept, decline or tentative) for the signed-in account: reads the event, sets that account's attendee response and tells the organizer. A dry-run plans the change; apply:true sends it. Fails when the account is not an attendee of the event.",
  signature:
    'calendar.respond({ eventId: string, response: "accepted" | "declined" | "tentative", calendarId?: string, account?: string }): Promise<{ applied: false, step: string } | { applied: true, eventId: string, response: string }>',
  tsDecl: [
    "type Input = {",
    "  eventId: string;",
    '  response: "accepted" | "declined" | "tentative";',
    '  calendarId?: string; // default "primary"',
    "  account?: string;",
    "};",
    "type Output = { applied: false; step: string } // dry-run: re-run with apply:true",
    "  | { applied: true; eventId: string; response: string };",
  ].join("\n"),
  example: 'await sdk.calendar.respond({ eventId: "<eventId>", response: "accepted" })',
  tags: ["helpers", "calendar", "respond", "rsvp", "accept", "decline", "tentative", "invitation", "invite", "event", "write"],
  scopes: ["https://www.googleapis.com/auth/calendar.events"],
  input: RespondInput,
  output: RespondOutput,
  async run(input, ctx) {
    const { calendarId, eventId, response } = input;
    const me = (await ctx.resolveAllowed(input.account)).email.toLowerCase();
    const event = EventWithAttendees.safeParse(await ctx.call("calendar.events.get", { calendarId, eventId, ...accountOf(input.account) }));
    if (!event.success) throw new GwsError("GWS_RESPONSE_SHAPE", "calendar.events.get returned an unexpected shape");
    const attendees = event.data.attendees ?? [];
    if (!attendees.some((a) => a.self === true || a.email?.toLowerCase() === me)) {
      throw new GwsError("GWS_INVALID_INPUT", "this account is not an attendee of the event, so it has no response to give", { details: { field: "eventId" } });
    }
    const patched = await ctx.call("calendar.events.patch", {
      calendarId,
      eventId,
      sendUpdates: "all",
      requestBody: { attendees: attendees.map((a) => (a.self === true || a.email?.toLowerCase() === me ? { ...a, responseStatus: response } : a)) },
      ...accountOf(input.account),
    });
    return isPending(patched) ? { applied: false, step: patched.__gwsPending } : { applied: true, eventId, response };
  },
};

const MoveInput = z.strictObject({ account: Ref.optional(), calendarId: CalendarId, eventId: Id, toCalendarId: z.string().min(1).max(320) });
type MoveInput = z.output<typeof MoveInput>;

const Moved = z.strictObject({ applied: z.literal(true), eventId: z.string(), calendarId: z.string() });
const MoveOutput = z.union([Planned, Moved]);
type MoveOutput = z.output<typeof MoveOutput>;

const moveDef: FnDef<MoveInput, MoveOutput> = {
  kind: "host",
  name: "calendar.move",
  service: "helpers",
  effect: "write",
  description:
    "Moves an event to another calendar the account can write to, changing the event's organizer calendar. A dry-run plans the move; apply:true performs it. Only default events can be moved.",
  signature:
    "calendar.move({ eventId: string, toCalendarId: string, calendarId?: string, account?: string }): Promise<{ applied: false, step: string } | { applied: true, eventId: string, calendarId: string }>",
  tsDecl: [
    "type Input = {",
    "  eventId: string;",
    "  toCalendarId: string; // the destination calendar id",
    '  calendarId?: string; // the current calendar, default "primary"',
    "  account?: string;",
    "};",
    "type Output = { applied: false; step: string } // dry-run: re-run with apply:true",
    "  | { applied: true; eventId: string; calendarId: string }; // calendarId is the destination",
  ].join("\n"),
  example: 'await sdk.calendar.move({ eventId: "<eventId>", toCalendarId: "<calendarId>" })',
  tags: ["helpers", "calendar", "move", "transfer", "event", "another", "write"],
  scopes: ["https://www.googleapis.com/auth/calendar.events"],
  input: MoveInput,
  output: MoveOutput,
  async run(input, ctx) {
    const { calendarId, eventId, toCalendarId } = input;
    const res = await ctx.call("calendar.events.move", { calendarId, eventId, destination: toCalendarId, ...accountOf(input.account) });
    return isPending(res) ? { applied: false, step: res.__gwsPending } : { applied: true, eventId, calendarId: toCalendarId };
  },
};

// ---------- free slots ----------

const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24 hours");
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

const FreeSlotsInput = z.strictObject({
  accounts: z.array(Ref).min(1).max(MAX_ACCOUNTS),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  durationMin: z.number().int().min(5).max(24 * 60),
  workHours: z.strictObject({ start: Clock, end: Clock, timeZone: z.string().min(1).max(64).default("UTC") }).optional(),
});
type FreeSlotsInput = z.output<typeof FreeSlotsInput>;

const FreeSlotsOutput = z.strictObject({
  accounts: z.array(z.string()),
  slots: z.array(z.strictObject({ start: z.string(), end: z.string(), minutes: z.number().int() })),
  /** True when more than 100 slots exist. */
  truncated: z.boolean(),
});
type FreeSlotsOutput = z.output<typeof FreeSlotsOutput>;

const FreeBusy = z.looseObject({
  calendars: z
    .record(z.string(), z.looseObject({ busy: z.array(z.looseObject({ start: z.string(), end: z.string() })).optional(), errors: z.array(z.unknown()).optional() }))
    .optional(),
});

type Span = [number, number];

/** Sorts spans and merges those that overlap or touch. */
function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Offset of `timeZone` from UTC at the instant `utc`, in ms. */
function zoneOffsetMs(utc: number, timeZone: string): number {
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
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(utc / 1000) * 1000;
}

/** The instant at which the wall clock of `timeZone` reads `date` (YYYY-MM-DD) at `minutes` past midnight, whatever the day's length. */
function wallClockInstant(date: string, minutes: number, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  return guess - zoneOffsetMs(guess - zoneOffsetMs(guess, timeZone), timeZone);
}

/** The time to search: the whole range, or each local day's work hours inside it. */
function searchWindows(from: number, to: number, hours: FreeSlotsInput["workHours"]): Span[] {
  if (hours === undefined) return [[from, to]];
  const startMin = minutesOf(hours.start);
  const endMin = minutesOf(hours.end);
  if (endMin <= startMin) throw new GwsError("GWS_INVALID_INPUT", "workHours.end must be after workHours.start", { details: { field: "workHours" } });
  const out: Span[] = [];
  let cursor = from;
  while (cursor < to) {
    const day = dayWindow(cursor, hours.timeZone);
    // Each edge is read off the local clock, so a 23 or 25 hour day keeps its work hours.
    const a = Math.max(from, wallClockInstant(day.date, startMin, hours.timeZone));
    const b = Math.min(to, wallClockInstant(day.date, endMin, hours.timeZone));
    if (b > a) out.push([a, b]);
    cursor = Date.parse(day.timeMax);
  }
  return out;
}

/** `windows` minus `busy` (both sorted and merged). */
function subtract(windows: Span[], busy: Span[]): Span[] {
  const out: Span[] = [];
  for (const [ws, we] of windows) {
    let at = ws;
    for (const [bs, be] of busy) {
      if (be <= at) continue;
      if (bs >= we) break;
      if (bs > at) out.push([at, bs]);
      at = Math.max(at, be);
    }
    if (at < we) out.push([at, we]);
  }
  return out;
}

const freeSlotsDef: FnDef<FreeSlotsInput, FreeSlotsOutput> = {
  kind: "host",
  name: "calendar.findFreeSlots",
  service: "helpers",
  effect: "read",
  description:
    "Finds when several connected Google accounts are all free (availability, a time everyone can meet): one free/busy lookup per account, then the time none of them is busy, optionally limited to work hours (in a time zone, default UTC) and to gaps of at least durationMin minutes. Returns up to 100 slots, each a maximal free gap.",
  signature:
    "calendar.findFreeSlots({ accounts: string[], from: string, to: string, durationMin: number, workHours?: { start: string, end: string, timeZone?: string } }): Promise<{ accounts: string[], slots: { start: string, end: string, minutes: number }[], truncated: boolean }>",
  tsDecl: [
    "type Input = {",
    "  accounts: string[]; // connected accounts (email or alias), 1-10; one free/busy call each",
    "  from: string; // RFC 3339 with offset, e.g. 2026-11-10T00:00:00+07:00",
    "  to: string; // at most 31 days after from",
    "  durationMin: number; // 5-1440: shorter gaps are dropped",
    '  workHours?: { start: string; end: string; timeZone?: string }; // "09:00"-"17:00" each local day; timeZone is IANA, default UTC',
    "};",
    "type Output = {",
    "  accounts: string[]; // the accounts' emails",
    "  slots: { start: string; end: string; minutes: number }[]; // UTC instants, in time order",
    "  truncated: boolean; // more than 100 slots",
    "};",
  ].join("\n"),
  example:
    'await sdk.calendar.findFreeSlots({ accounts: ["me@example.com", "you@example.com"], from: "2026-11-10T00:00:00+07:00", to: "2026-11-14T00:00:00+07:00", durationMin: 30, workHours: { start: "09:00", end: "17:00", timeZone: "Asia/Saigon" } })',
  tags: ["helpers", "calendar", "free", "availability", "freebusy", "busy", "slots", "meeting", "schedule", "find", "time", "read"],
  scopes: ["https://www.googleapis.com/auth/calendar.freebusy"],
  input: FreeSlotsInput,
  output: FreeSlotsOutput,
  async run(input, ctx) {
    const from = Date.parse(input.from);
    const to = Date.parse(input.to);
    if (to <= from) throw new GwsError("GWS_INVALID_INPUT", "to must be after from", { details: { field: "to" } });
    if (to - from > MAX_SPAN_DAYS * DAY_MS) throw new GwsError("GWS_INVALID_INPUT", `the range may span at most ${MAX_SPAN_DAYS} days`, { details: { field: "to" } });
    const windows = searchWindows(from, to, input.workHours);

    // Every account is resolved first, so one the client may not use stops the search before any lookup.
    const emails: string[] = [];
    for (const ref of input.accounts) {
      const email = (await ctx.resolveAllowed(ref)).email;
      if (!emails.includes(email)) emails.push(email);
    }

    const busy: Span[] = [];
    for (const email of emails) {
      const raw = await ctx.call("calendar.freebusy.query", {
        requestBody: { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: [{ id: "primary" }] },
        account: email,
      });
      const parsed = FreeBusy.safeParse(raw);
      const entry = parsed.success ? Object.values(parsed.data.calendars ?? {})[0] : undefined;
      if (entry === undefined) throw new GwsError("GWS_RESPONSE_SHAPE", "calendar.freebusy.query returned an unexpected shape");
      if (entry.errors !== undefined && entry.errors.length > 0) {
        throw new GwsError("GWS_UPSTREAM_ERROR", "Google could not read this account's free/busy time", { details: { account: email } });
      }
      for (const b of entry.busy ?? []) busy.push([Date.parse(b.start), Date.parse(b.end)]);
    }

    const free = subtract(windows, merge(busy)).filter(([a, b]) => b - a >= input.durationMin * MINUTE_MS);
    return {
      accounts: emails,
      slots: free.slice(0, MAX_SLOTS).map(([a, b]) => ({ start: new Date(a).toISOString(), end: new Date(b).toISOString(), minutes: Math.floor((b - a) / MINUTE_MS) })),
      truncated: free.length > MAX_SLOTS,
    };
  },
};

// The registry holds FnDef<unknown>; these definitions are typed with their own input and output.
export const calendarShare = shareDef as FnDef;
export const calendarUnshare = unshareDef as FnDef;
export const calendarRespond = respondDef as FnDef;
export const calendarMove = moveDef as FnDef;
export const calendarFindFreeSlots = freeSlotsDef as FnDef;
