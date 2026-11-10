import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEED_NOW } from "../../fake-google/src/routes/calendar";
import { loadConfig, type Config } from "../../src/config";
import type { AuthProps } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { dayWindow } from "../../src/sdk/helpers/today-agenda";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const AGENDA = "helpers.todayAgenda";
const store = openStore(env);
const baseConfig = loadConfig(env);

afterEach(() => {
  vi.useRealTimers();
});

/** Fixes `Date` only: timers and promises keep running. */
function clockAt(ms: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
}

async function client() {
  const email = uniqueEmail("h-cal");
  const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}calendar.events`, `${G}calendar.calendarlist.readonly`], isDefault: true });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }], now: SEED_NOW });
  const auth: AuthProps = { userId: seeded.userId, clientId: `client-${crypto.randomUUID()}` };
  await store.grants.add(auth.userId, auth.clientId, seeded.account.id);
  return { email, auth };
}

function session(auth: AuthProps, apply: boolean, config: Partial<Config> = {}) {
  const executeId = `x-${crypto.randomUUID()}`;
  return { s: createCallSession({ ports: workersPorts(env), auth, apply, executeId, config: { ...baseConfig, ...config } }), executeId };
}

function valueOf(r: DispatchResult): Record<string, unknown> {
  if (!("ok" in r)) throw new Error(`expected a value result, got ${JSON.stringify(r)}`);
  return r.value as Record<string, unknown>;
}

interface AgendaEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  attendeeCount: number;
}

const idsOf = (out: Record<string, unknown>) => (out.events as AgendaEvent[]).map((e) => e.id);

describe("dayWindow", () => {
  it("is the local day in the given zone, as UTC instants", () => {
    const w = dayWindow(SEED_NOW, "Asia/Saigon");
    expect(w).toEqual({ timeMin: "2026-11-08T17:00:00.000Z", timeMax: "2026-11-09T17:00:00.000Z", date: "2026-11-09" });
  });

  it("moves with the zone: the same instant is a different local day", () => {
    const instant = Date.parse("2026-11-09T17:30:00Z"); // 00:30 on the 10th in Saigon, 12:30 on the 9th in New York
    expect(dayWindow(instant, "Asia/Saigon").date).toBe("2026-11-10");
    expect(dayWindow(instant, "UTC").date).toBe("2026-11-09");
    expect(dayWindow(instant, "America/New_York")).toEqual({ timeMin: "2026-11-09T05:00:00.000Z", timeMax: "2026-11-10T05:00:00.000Z", date: "2026-11-09" });
  });

  it("is 23 or 25 hours long on a daylight-saving change", () => {
    const hours = (w: { timeMin: string; timeMax: string }) => (Date.parse(w.timeMax) - Date.parse(w.timeMin)) / 3_600_000;
    expect(hours(dayWindow(Date.parse("2026-03-08T18:00:00Z"), "America/New_York"))).toBe(23);
    expect(hours(dayWindow(Date.parse("2026-11-01T18:00:00Z"), "America/New_York"))).toBe(25);
  });

  it("rejects an unknown zone with GWS_INVALID_INPUT", () => {
    expect(() => dayWindow(SEED_NOW, "Mars/Olympus")).toThrowError(expect.objectContaining({ code: "GWS_INVALID_INPUT" }));
  });
});

describe("helpers.todayAgenda", () => {
  it.each([false, true])("returns only today's events in order, in the calendar's time zone (apply=%s)", async (apply) => {
    const { auth } = await client();
    clockAt(SEED_NOW);
    const { s, executeId } = session(auth, apply);

    const out = valueOf(await s.dispatch(AGENDA, {}));

    expect(out).toMatchObject({ timeZone: "Asia/Saigon", date: "2026-11-09", truncated: false });
    expect(idsOf(out)).toEqual(["seed-evt-overnight", "seed-evt-today-allday", "seed-evt-today-early", "seed-evt-today-standup", "seed-evt-today-late"]);
    const events = out.events as AgendaEvent[];
    expect(events.find((e) => e.id === "seed-evt-today-standup")).toEqual({
      id: "seed-evt-today-standup",
      summary: "Standup",
      start: "2026-11-09T09:00:00+07:00",
      end: "2026-11-09T09:30:00+07:00",
      location: "Room 1",
      attendeeCount: 2,
    });
    expect(events.find((e) => e.id === "seed-evt-today-allday")).toMatchObject({ start: "2026-11-09", end: "2026-11-10", attendeeCount: 0 });
    expect(s.plan).toEqual([]);

    await s.close();
    const { results } = await env.DB.prepare("SELECT fn, applied, status FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
    expect(results.map((r) => [r.fn, r.applied, r.status])).toEqual([
      ["calendar.calendarList.get", 0, "ok"],
      ["calendar.events.list", 0, "ok"],
      [AGENDA, 0, "ok"],
    ]);
  });

  it("uses a given timeZone without asking Google for the calendar's", async () => {
    const { auth } = await client();
    clockAt(SEED_NOW);
    const { s } = session(auth, false);
    const out = valueOf(await s.dispatch(AGENDA, { timeZone: "UTC" }));
    // The UTC day holds the all-day event, the standup, the late call and the early event of the next local day.
    expect(idsOf(out)).toEqual(["seed-evt-today-allday", "seed-evt-today-standup", "seed-evt-today-late", "seed-evt-tomorrow-early"]);
    expect(out.timeZone).toBe("UTC");
    expect(s.calls.map((c) => c.fn)).toEqual(["calendar.events.list", AGENDA]);
  });

  it("follows the local date: just after midnight in Saigon is already tomorrow", async () => {
    const { auth } = await client();
    clockAt(Date.parse("2026-11-09T17:30:00Z"));
    const out = valueOf(await session(auth, false).s.dispatch(AGENDA, {}));
    expect(out.date).toBe("2026-11-10");
    expect(idsOf(out)).toEqual(["seed-evt-tomorrow-early"]);
  });

  it("rejects an unknown time zone before calling Google", async () => {
    const { auth } = await client();
    const { s } = session(auth, false);
    const r = await s.dispatch(AGENDA, { timeZone: "Mars/Olympus" });
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_INVALID_INPUT");
    expect(s.calls.map((c) => c.fn)).toEqual([AGENDA]);
  });

  it("returns an empty agenda for a day without events", async () => {
    const { auth } = await client();
    clockAt(Date.parse("2027-01-15T05:00:00Z"));
    const out = valueOf(await session(auth, false).s.dispatch(AGENDA, {}));
    expect(out).toMatchObject({ events: [], truncated: false });
  });
});

describe("pagination", () => {
  async function bulk(email: string, count: number): Promise<void> {
    const resources = Array.from({ length: count }, (_, i) => {
      const minute = 10 * 60 + i; // from 10:00 local, one event a minute
      const at = (m: number) => `2026-11-09T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00+07:00`;
      const id = `bulk-${String(i).padStart(3, "0")}`;
      return {
        key: `calendar:event:${email}:${id}`,
        value: {
          kind: "calendar#event",
          id,
          status: "confirmed",
          summary: `Bulk ${i}`,
          created: "2026-11-01T09:00:00.000Z",
          updated: "2026-11-01T09:00:00.000Z",
          start: { dateTime: at(minute) },
          end: { dateTime: at(minute + 1) },
        },
      };
    });
    await fake.seed({ accounts: [], resources });
  }

  it("follows every page through the dispatcher: each page is a call record and an audit row", async () => {
    const { email, auth } = await client();
    await bulk(email, 120);
    clockAt(SEED_NOW);
    const { s, executeId } = session(auth, false);

    const out = valueOf(await s.dispatch(AGENDA, {}));

    expect((out.events as unknown[]).length).toBe(125);
    expect(out.truncated).toBe(false);
    const pages = s.calls.filter((c) => c.fn === "calendar.events.list");
    expect(pages).toHaveLength(3);
    await s.close();
    const { results } = await env.DB.prepare("SELECT fn FROM audit_log WHERE execute_id = ?").bind(executeId).all();
    expect(results.filter((r) => r.fn === "calendar.events.list")).toHaveLength(3);
    expect(results).toHaveLength(5);
    const listed = (await fake.requests(email)).filter((q) => q.path.endsWith("/calendars/primary/events"));
    expect(listed).toHaveLength(3);
  });

  it("stops at 250 events and says so", async () => {
    const { email, auth } = await client();
    await bulk(email, 300);
    clockAt(SEED_NOW);
    const out = valueOf(await session(auth, false).s.dispatch(AGENDA, {}));
    expect((out.events as unknown[]).length).toBe(250);
    expect(out.truncated).toBe(true);
  });

  it("counts every page against the calls-per-execute budget", async () => {
    const { email, auth } = await client();
    await bulk(email, 120);
    clockAt(SEED_NOW);
    // The helper itself, the zone lookup and three pages are five calls.
    const { s } = session(auth, false, { CALLS_PER_EXECUTE: 4 });
    const r = await s.dispatch(AGENDA, {});
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_CALL_BUDGET_EXCEEDED");
    const listed = (await fake.requests(email)).filter((q) => q.path.endsWith("/calendars/primary/events"));
    expect(listed).toHaveLength(2);
  });
});
