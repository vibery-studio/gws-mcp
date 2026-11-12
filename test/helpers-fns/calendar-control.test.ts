import { describe, expect, it } from "vitest";
import { SEED_NOW } from "../../fake-google/src/routes/calendar";
import { fake } from "../helpers/fake";
import { auditRows, connect, connectMore, errorCodeOf, G, session, valueOf } from "./harness";

const ACLS = `${G}calendar.acls`;
const EVENTS = `${G}calendar.events`;
const FREEBUSY = `${G}calendar.freebusy`;

function eventRecord(email: string, id: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) {
  return {
    key: `calendar:event:${email}:${id}`,
    value: {
      kind: "calendar#event",
      id,
      status: "confirmed",
      summary,
      created: "2026-11-01T09:00:00.000Z",
      updated: "2026-11-01T09:00:00.000Z",
      start: { dateTime: start },
      end: { dateTime: end },
      ...extra,
    },
  };
}

const aclRulesOf = async (email: string) => Object.keys((await fake.state(email)).resources).filter((k) => k.startsWith(`calendar:acl:${email}:`));
const requestsTo = async (email: string, method: string, suffix: string) => (await fake.requests(email)).filter((q) => q.method === method && q.path.endsWith(suffix));

describe("calendar.share", () => {
  it("plans an access rule in a dry-run and sends nothing", async () => {
    const { auth, email } = await connect("h-share", [ACLS]);
    const { s } = session(auth, false);

    const out = valueOf(await s.dispatch("calendar.share", { email: "colleague@fake.test", role: "reader" }));

    expect(out).toMatchObject({ applied: false });
    expect(s.plan).toHaveLength(1);
    expect(s.plan[0]).toMatchObject({
      fn: "calendar.acl.insert",
      effect: "write",
      destructive: false,
      request: { method: "POST", body: { role: "reader", scope: { type: "user", value: "colleague@fake.test" } } },
    });
    expect(s.destructive).toBe(false);
    expect(await requestsTo(email, "POST", "/acl")).toEqual([]);
    expect(await aclRulesOf(email)).toEqual([`calendar:acl:${email}:user:${email}`]);
  });

  it("adds the rule under apply and audits it", async () => {
    const { auth, email } = await connect("h-share", [ACLS]);
    const { s, executeId } = session(auth, true);

    const out = valueOf(await s.dispatch("calendar.share", { email: "colleague@fake.test", role: "writer" }));

    expect(out).toEqual({ applied: true, ruleId: "user:colleague@fake.test", role: "writer" });
    expect(await aclRulesOf(email)).toContain(`calendar:acl:${email}:user:colleague@fake.test`);
    await s.close();
    expect((await auditRows(executeId)).map((r) => [r.fn, r.applied, r.status])).toEqual([
      ["calendar.acl.insert", 1, "ok"],
      ["calendar.share", 1, "ok"],
    ]);
  });

  it("treats a public share as destructive", async () => {
    const { auth, email } = await connect("h-share", [ACLS]);
    const dry = session(auth, false).s;
    expect(valueOf(await dry.dispatch("calendar.share", { public: true, role: "reader" }))).toMatchObject({ applied: false });
    expect(dry.plan[0]).toMatchObject({ fn: "calendar.acl.insert", destructive: true, request: { body: { scope: { type: "default" } } } });
    expect(dry.destructive).toBe(true);

    const applied = session(auth, true).s;
    expect(valueOf(await applied.dispatch("calendar.share", { public: true, role: "reader" }))).toEqual({ applied: true, ruleId: "default", role: "reader" });
    expect(applied.appliedDestructive).toBe(true);
    expect(await aclRulesOf(email)).toContain(`calendar:acl:${email}:default`);
  });

  it("needs exactly one audience and refuses owner access", async () => {
    const { auth } = await connect("h-share", [ACLS]);
    const { s } = session(auth, false);
    for (const input of [
      { role: "reader" },
      { email: "a@fake.test", public: true, role: "reader" },
      { email: "a@fake.test", role: "owner" },
      { email: "a@fake.test" },
    ]) {
      expect(errorCodeOf(await s.dispatch("calendar.share", input))).toBe("GWS_INVALID_INPUT");
    }
    expect(s.calls.every((c) => c.fn === "calendar.share")).toBe(true);
  });

  it("names the missing scope", async () => {
    const { auth } = await connect("h-share", [EVENTS]);
    expect(errorCodeOf(await session(auth, false).s.dispatch("calendar.share", { email: "a@fake.test", role: "reader" }))).toBe("GWS_SCOPE_MISSING");
  });
});

describe("calendar.unshare", () => {
  it("is destructive: planned in a dry-run, removed under apply", async () => {
    const { auth, email } = await connect("h-unshare", [ACLS]);
    await session(auth, true).s.dispatch("calendar.share", { email: "colleague@fake.test", role: "reader" });

    const dry = session(auth, false).s;
    expect(valueOf(await dry.dispatch("calendar.unshare", { email: "colleague@fake.test" }))).toMatchObject({ applied: false });
    expect(dry.plan[0]).toMatchObject({ fn: "calendar.acl.delete", destructive: true, request: { method: "DELETE" } });
    expect(dry.destructive).toBe(true);
    expect(await aclRulesOf(email)).toContain(`calendar:acl:${email}:user:colleague@fake.test`);

    const applied = session(auth, true).s;
    expect(valueOf(await applied.dispatch("calendar.unshare", { email: "colleague@fake.test" }))).toEqual({ applied: true, ruleId: "user:colleague@fake.test" });
    expect(applied.appliedDestructive).toBe(true);
    expect(await aclRulesOf(email)).not.toContain(`calendar:acl:${email}:user:colleague@fake.test`);
  });

  it("removes a public rule and reports a rule that does not exist", async () => {
    const { auth, email } = await connect("h-unshare", [ACLS]);
    await session(auth, true).s.dispatch("calendar.share", { public: true, role: "reader" });
    expect(valueOf(await session(auth, true).s.dispatch("calendar.unshare", { public: true }))).toEqual({ applied: true, ruleId: "default" });
    expect(await aclRulesOf(email)).toEqual([`calendar:acl:${email}:user:${email}`]);
    expect(errorCodeOf(await session(auth, true).s.dispatch("calendar.unshare", { email: "nobody@fake.test" }))).toBe("GWS_UPSTREAM_ERROR");
  });
});

describe("calendar.respond", () => {
  async function invited() {
    const client = await connect("h-respond", [EVENTS], { now: SEED_NOW });
    await fake.seed({
      accounts: [],
      resources: [
        eventRecord(client.email, "invite01", "Planning", "2026-11-10T10:00:00+07:00", "2026-11-10T11:00:00+07:00", {
          organizer: { email: "boss@fake.test" },
          attendees: [
            { email: "boss@fake.test", organizer: true, responseStatus: "accepted" },
            { email: client.email.toUpperCase(), responseStatus: "needsAction" },
            { email: "carol@fake.test", responseStatus: "needsAction" },
          ],
        }),
      ],
    });
    return client;
  }

  const responsesOf = async (email: string) => {
    const event = (await fake.state(email)).resources[`calendar:event:${email}:invite01`] as { attendees: Array<{ email: string; responseStatus: string }> };
    return Object.fromEntries(event.attendees.map((a) => [a.email.toLowerCase(), a.responseStatus]));
  };

  it("reads the event in a dry-run and plans only the attendee change", async () => {
    const { auth, email } = await invited();
    const { s } = session(auth, false);
    const out = valueOf(await s.dispatch("calendar.respond", { eventId: "invite01", response: "accepted" }));
    expect(out).toMatchObject({ applied: false });
    expect(s.plan).toHaveLength(1);
    expect(s.plan[0]).toMatchObject({ fn: "calendar.events.patch", destructive: false, request: { method: "PATCH", query: { sendUpdates: "all" } } });
    expect(await requestsTo(email, "GET", "/events/invite01")).toHaveLength(1);
    expect(await requestsTo(email, "PATCH", "/events/invite01")).toEqual([]);
    expect((await responsesOf(email))[email]).toBe("needsAction");
  });

  it("changes only this account's response under apply", async () => {
    const { auth, email } = await invited();
    const { s, executeId } = session(auth, true);
    expect(valueOf(await s.dispatch("calendar.respond", { eventId: "invite01", response: "tentative" }))).toEqual({ applied: true, eventId: "invite01", response: "tentative" });
    expect(await responsesOf(email)).toEqual({ "boss@fake.test": "accepted", [email]: "tentative", "carol@fake.test": "needsAction" });
    await s.close();
    expect((await auditRows(executeId)).map((r) => [r.fn, r.applied])).toEqual([
      ["calendar.events.get", 0],
      ["calendar.events.patch", 1],
      ["calendar.respond", 1],
    ]);
  });

  it("refuses an event the account is not invited to, and an unknown event", async () => {
    const { auth } = await invited();
    const stranger = session(auth, true);
    expect(errorCodeOf(await stranger.s.dispatch("calendar.respond", { eventId: "seed-evt-today-standup", response: "accepted" }))).toBe("GWS_INVALID_INPUT");
    expect(stranger.s.calls.filter((c) => c.fn === "calendar.events.patch")).toEqual([]);
    expect(errorCodeOf(await session(auth, true).s.dispatch("calendar.respond", { eventId: "nothere", response: "accepted" }))).toBe("GWS_UPSTREAM_ERROR");
    expect(errorCodeOf(await session(auth, true).s.dispatch("calendar.respond", { eventId: "invite01", response: "maybe" }))).toBe("GWS_INVALID_INPUT");
  });
});

describe("calendar.move", () => {
  it("plans the move in a dry-run and performs it under apply", async () => {
    const { auth, email } = await connect("h-move", [EVENTS], { now: SEED_NOW });
    const dry = session(auth, false).s;
    expect(valueOf(await dry.dispatch("calendar.move", { eventId: "seed-evt-today-standup", toCalendarId: email }))).toMatchObject({ applied: false });
    expect(dry.plan[0]).toMatchObject({ fn: "calendar.events.move", destructive: false, request: { method: "POST", query: { destination: email } } });
    expect(await requestsTo(email, "POST", "/events/seed-evt-today-standup/move")).toEqual([]);

    const applied = session(auth, true).s;
    expect(valueOf(await applied.dispatch("calendar.move", { eventId: "seed-evt-today-standup", toCalendarId: email }))).toEqual({
      applied: true,
      eventId: "seed-evt-today-standup",
      calendarId: email,
    });
    expect(await requestsTo(email, "POST", "/events/seed-evt-today-standup/move")).toHaveLength(1);
  });

  it("reports a destination the account does not have", async () => {
    const { auth } = await connect("h-move", [EVENTS], { now: SEED_NOW });
    expect(errorCodeOf(await session(auth, true).s.dispatch("calendar.move", { eventId: "seed-evt-today-standup", toCalendarId: "other@group.calendar.google.com" }))).toBe("GWS_UPSTREAM_ERROR");
  });
});

describe("calendar.findFreeSlots", () => {
  /** Two accounts, Saigon time on 2026-11-10: the first is busy 13:00-14:00, the second 10:00-11:00. */
  async function pair() {
    const first = await connect("h-free-a", [FREEBUSY], { now: SEED_NOW });
    const secondEmail = await connectMore(first, "h-free-b", [FREEBUSY], { now: SEED_NOW });
    await fake.seed({
      accounts: [],
      resources: [
        eventRecord(first.email, "busy-a", "Lunch review", "2026-11-10T13:00:00+07:00", "2026-11-10T14:00:00+07:00"),
        eventRecord(secondEmail, "busy-b", "Interview", "2026-11-10T10:00:00+07:00", "2026-11-10T11:00:00+07:00"),
      ],
    });
    return { auth: first.auth, first: first.email, second: secondEmail };
  }

  const input = (a: string, b: string, extra: Record<string, unknown> = {}) => ({
    accounts: [a, b],
    from: "2026-11-10T00:00:00+07:00",
    to: "2026-11-11T00:00:00+07:00",
    durationMin: 60,
    workHours: { start: "09:00", end: "17:00", timeZone: "Asia/Saigon" },
    ...extra,
  });
  const slotsOf = (out: Record<string, unknown>) => (out.slots as Array<{ start: string; end: string; minutes: number }>).map((s) => [s.start, s.end, s.minutes]);

  it("intersects the free time of every account inside the work hours, one call each", async () => {
    const { auth, first, second } = await pair();
    const { s, executeId } = session(auth, false);

    const out = valueOf(await s.dispatch("calendar.findFreeSlots", input(first, second)));

    expect(out.accounts).toEqual([first, second]);
    expect(out.truncated).toBe(false);
    expect(slotsOf(out)).toEqual([
      ["2026-11-10T02:00:00.000Z", "2026-11-10T03:00:00.000Z", 60], // 09:00-10:00
      ["2026-11-10T04:00:00.000Z", "2026-11-10T06:00:00.000Z", 120], // 11:00-13:00
      ["2026-11-10T07:00:00.000Z", "2026-11-10T10:00:00.000Z", 180], // 14:00-17:00
    ]);
    expect(s.plan).toEqual([]);
    await s.close();
    expect((await auditRows(executeId)).map((r) => r.fn)).toEqual(["calendar.freebusy.query", "calendar.freebusy.query", "calendar.findFreeSlots"]);
    expect(await requestsTo(first, "POST", "/freeBusy")).toHaveLength(1);
    expect(await requestsTo(second, "POST", "/freeBusy")).toHaveLength(1);
  });

  it("drops gaps shorter than durationMin", async () => {
    const { auth, first, second } = await pair();
    const ninety = valueOf(await session(auth, false).s.dispatch("calendar.findFreeSlots", input(first, second, { durationMin: 90 })));
    expect(slotsOf(ninety).map((x) => x[2])).toEqual([120, 180]);
    const long = valueOf(await session(auth, false).s.dispatch("calendar.findFreeSlots", input(first, second, { durationMin: 150 })));
    expect(slotsOf(long).map((x) => x[2])).toEqual([180]);
    const none = valueOf(await session(auth, false).s.dispatch("calendar.findFreeSlots", input(first, second, { durationMin: 200 })));
    expect(none.slots).toEqual([]);
  });

  it("searches the whole range without workHours, and counts a busy span that starts before it", async () => {
    const { auth, first, second } = await pair();
    const out = valueOf(
      await session(auth, false).s.dispatch(
        "calendar.findFreeSlots",
        input(first, second, { from: "2026-11-10T09:30:00+07:00", to: "2026-11-10T12:00:00+07:00", workHours: undefined, durationMin: 30 }),
      ),
    );
    // The second account is busy 10:00-11:00, so only 09:30-10:00 and 11:00-12:00 are free for both.
    expect(slotsOf(out)).toEqual([
      ["2026-11-10T02:30:00.000Z", "2026-11-10T03:00:00.000Z", 30],
      ["2026-11-10T04:00:00.000Z", "2026-11-10T05:00:00.000Z", 60],
    ]);
  });

  it("skips an account listed twice and works for a single account", async () => {
    const { auth, first } = await pair();
    const { s } = session(auth, false);
    const out = valueOf(await s.dispatch("calendar.findFreeSlots", input(first, first.toUpperCase())));
    expect(out.accounts).toEqual([first]);
    expect(s.calls.filter((c) => c.fn === "calendar.freebusy.query")).toHaveLength(1);
    expect(slotsOf(out).map((x) => x[2])).toEqual([240, 180]);
  });

  it.each([
    ["spring forward (23 hour day)", "2026-03-08T00:00:00-05:00", "2026-03-09T00:00:00-04:00", "2026-03-08T13:00:00.000Z", "2026-03-08T21:00:00.000Z"],
    ["fall back (25 hour day)", "2026-11-01T00:00:00-04:00", "2026-11-02T00:00:00-05:00", "2026-11-01T14:00:00.000Z", "2026-11-01T22:00:00.000Z"],
  ])("keeps 09:00-17:00 local on a daylight-saving change: %s", async (_name, from, to, start, end) => {
    const { auth, first } = await pair();
    const out = valueOf(
      await session(auth, false).s.dispatch("calendar.findFreeSlots", {
        accounts: [first],
        from,
        to,
        durationMin: 60,
        workHours: { start: "09:00", end: "17:00", timeZone: "America/New_York" },
      }),
    );
    expect(slotsOf(out)).toEqual([[start, end, 480]]);
  });

  it("is not fooled by an all-day event: the account is busy that day", async () => {
    const { auth, first, second } = await pair();
    const out = valueOf(
      await session(auth, false).s.dispatch("calendar.findFreeSlots", input(first, second, { from: "2026-11-09T00:00:00+07:00", to: "2026-11-10T00:00:00+07:00" })),
    );
    expect(out.slots).toEqual([]); // "Focus day" is all day on the 9th
  });

  it("rejects a bad range, bad work hours and an unknown time zone before any Google call", async () => {
    const { auth, first, second } = await pair();
    const { s } = session(auth, false);
    for (const extra of [
      { to: "2026-11-09T00:00:00+07:00" },
      { to: "2026-12-20T00:00:00+07:00" },
      { durationMin: 1 },
      { from: "yesterday" },
      { workHours: { start: "17:00", end: "09:00" } },
      { workHours: { start: "9am", end: "5pm" } },
      { workHours: { start: "09:00", end: "17:00", timeZone: "Mars/Olympus" } },
      { accounts: [] },
    ]) {
      expect(errorCodeOf(await s.dispatch("calendar.findFreeSlots", input(first, second, extra))), JSON.stringify(extra)).toBe("GWS_INVALID_INPUT");
    }
    expect(s.calls.every((c) => c.fn === "calendar.findFreeSlots")).toBe(true);
  });

  it("refuses an account the client is not allowed to use before reading anything", async () => {
    const { auth, first } = await pair();
    const { s } = session(auth, false);
    expect(errorCodeOf(await s.dispatch("calendar.findFreeSlots", input(first, "stranger@fake.test")))).toBe("GWS_ACCOUNT_DENIED");
    expect(s.calls.filter((c) => c.fn === "calendar.freebusy.query")).toEqual([]);
  });
});
