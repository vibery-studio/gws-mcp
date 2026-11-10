import { z } from "zod";
import type { FnDef } from "../../contracts";
import { GwsError } from "../../errors";
import { paginate } from "../../google/paginate";

const Ref = z.string().min(1).max(320);

const InputSchema = z.strictObject({
  account: Ref.optional(),
  calendarId: z.string().min(1).max(320).default("primary"),
  timeZone: z.string().min(1).max(64).optional(),
});
type Input = z.output<typeof InputSchema>;

const AgendaEvent = z.strictObject({
  id: z.string(),
  summary: z.string(),
  start: z.string(),
  end: z.string(),
  location: z.string().optional(),
  attendeeCount: z.number().int().nonnegative(),
});
type AgendaEvent = z.output<typeof AgendaEvent>;

const OutputSchema = z.strictObject({
  /** The local date the agenda is for, YYYY-MM-DD. */
  date: z.string(),
  timeZone: z.string(),
  timeMin: z.string(),
  timeMax: z.string(),
  events: z.array(AgendaEvent),
  /** True when more than the 250 event limit exist for the day. */
  truncated: z.boolean(),
});
type Output = z.output<typeof OutputSchema>;

const PAGE_SIZE = 50;
const MAX_EVENTS = 250;
const MAX_PAGES = 10;

function invalidZone(timeZone: string): GwsError {
  return new GwsError("GWS_INVALID_INPUT", "invalid timeZone: use an IANA name like Asia/Saigon", { details: { field: "timeZone", value: timeZone.slice(0, 64) } });
}

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
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(utc / 1000) * 1000;
}

/** The instant of local midnight at the start of the given calendar day in `timeZone`. */
function startOfDay(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  return guess - offsetMs(guess - offsetMs(guess, timeZone), timeZone);
}

/**
 * The local day containing `now` in `timeZone`, as UTC instants: from local midnight up to the next local
 * midnight, so a daylight-saving day is 23 or 25 hours long. Throws GWS_INVALID_INPUT for an unknown zone.
 */
export function dayWindow(now: number, timeZone: string): { date: string; timeMin: string; timeMax: string } {
  let offset: number;
  try {
    offset = offsetMs(now, timeZone);
  } catch {
    throw invalidZone(timeZone);
  }
  const local = new Date(now + offset); // UTC fields of this date are the local fields
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth() + 1;
  const d = local.getUTCDate();
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const startMs = startOfDay(y, m, d, timeZone);
  const endMs = startOfDay(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone);
  const date = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { date, timeMin: new Date(startMs).toISOString(), timeMax: new Date(endMs).toISOString() };
}

const EventTime = z.looseObject({ dateTime: z.string().optional(), date: z.string().optional() });
const GoogleEvent = z.looseObject({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
  start: EventTime.optional(),
  end: EventTime.optional(),
  attendees: z.array(z.unknown()).optional(),
});
const EventsPage = z.looseObject({ items: z.array(GoogleEvent).optional(), nextPageToken: z.string().optional() });
const CalendarEntry = z.looseObject({ timeZone: z.string().optional() });

function toAgendaEvent(e: z.output<typeof GoogleEvent>): AgendaEvent {
  return {
    id: e.id,
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    ...(e.location === undefined ? {} : { location: e.location }),
    attendeeCount: e.attendees?.length ?? 0,
  };
}

const def: FnDef<Input, Output> = {
  kind: "host",
  name: "helpers.todayAgenda",
  service: "helpers",
  effect: "read",
  description:
    "Lists today's calendar events in time order: the local day in the calendar's time zone (or the given IANA timeZone), including all-day events and events that run across midnight. Returns id, summary, start, end, location and attendee count, up to 250 events.",
  signature:
    "helpers.todayAgenda({ calendarId?: string, timeZone?: string, account?: string }): Promise<{ date: string, timeZone: string, timeMin: string, timeMax: string, events: { id: string, summary: string, start: string, end: string, location?: string, attendeeCount: number }[], truncated: boolean }>",
  tsDecl: [
    'type Input = { calendarId?: string; /* default "primary" */ timeZone?: string; /* IANA, default: the calendar\'s */ account?: string };',
    "type Output = {",
    "  date: string; // local date, YYYY-MM-DD",
    "  timeZone: string;",
    "  timeMin: string; // start of the local day (UTC instant)",
    "  timeMax: string; // end of the local day (UTC instant)",
    "  events: { id: string; summary: string; start: string; end: string; location?: string; attendeeCount: number }[];",
    "  truncated: boolean; // more than 250 events that day",
    "};",
  ].join("\n"),
  example: "await sdk.helpers.todayAgenda({})",
  tags: ["helpers", "calendar", "agenda", "today", "events", "schedule", "meetings", "day", "read"],
  scopes: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"],
  input: InputSchema,
  output: OutputSchema,
  async run(input, ctx) {
    const { calendarId } = input;
    const account = input.account === undefined ? {} : { account: input.account };
    const now = Date.now();

    let timeZone = input.timeZone;
    let window = timeZone === undefined ? undefined : dayWindow(now, timeZone);
    if (timeZone === undefined || window === undefined) {
      // The calendar list entry carries the calendar's zone and needs only the calendar-list read scope.
      const entry = CalendarEntry.safeParse(await ctx.call("calendar.calendarList.get", { calendarId, ...account }));
      timeZone = entry.success && entry.data.timeZone !== undefined ? entry.data.timeZone : "UTC";
      window = dayWindow(now, timeZone);
    }
    const { date, timeMin, timeMax } = window;
    const zone = timeZone;

    const walked = await paginate<z.output<typeof GoogleEvent>>(
      async (pageToken) => {
        // One dispatcher call per page: each counts against the call budget and is audited.
        const raw = await ctx.call("calendar.events.list", {
          calendarId,
          singleEvents: true,
          orderBy: "startTime",
          timeMin,
          timeMax,
          timeZone: zone,
          maxResults: PAGE_SIZE,
          ...(pageToken === undefined ? {} : { pageToken }),
          ...account,
        });
        const page = EventsPage.safeParse(raw);
        if (!page.success) throw new GwsError("GWS_RESPONSE_SHAPE", "calendar.events.list returned an unexpected shape");
        return { items: page.data.items ?? [], ...(page.data.nextPageToken === undefined ? {} : { nextPageToken: page.data.nextPageToken }) };
      },
      { maxPages: MAX_PAGES, maxItems: MAX_EVENTS },
    );

    return {
      date,
      timeZone: zone,
      timeMin,
      timeMax,
      events: walked.items.filter((e) => e.status !== "cancelled").map(toAgendaEvent),
      truncated: walked.truncated,
    };
  },
};

// The registry holds FnDef<unknown>; this definition is typed with its own input and output.
export const todayAgenda = def as FnDef;
