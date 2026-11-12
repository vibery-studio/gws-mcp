import { afterEach, describe, expect, it, vi } from "vitest";
import { reportWindow } from "../../src/sdk/helpers/searchconsole";
import { fake } from "../helpers/fake";
import { auditRows, connect, errorCodeOf, G, session, valueOf } from "./harness";

const READ = `${G}webmasters.readonly`;
const SITE = "https://example.test/";

afterEach(() => {
  vi.useRealTimers();
});

/** Fixes `Date` only; the fake's data covers 2026-11-01 to 2026-11-07. */
function clockAt(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(iso));
}

interface Row {
  query?: string;
  page?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

describe("reportWindow", () => {
  it("ends three days ago and spans the given number of days inclusive", () => {
    expect(reportWindow(Date.parse("2026-11-10T12:00:00Z"), 7)).toEqual({ startDate: "2026-11-01", endDate: "2026-11-07" });
    expect(reportWindow(Date.parse("2026-11-10T12:00:00Z"), 1)).toEqual({ startDate: "2026-11-07", endDate: "2026-11-07" });
  });
});

describe("searchconsole.topQueries", () => {
  it.each([false, true])("returns the queries with most clicks first, in dry-run and apply alike (apply=%s)", async (apply) => {
    const { auth, email } = await connect("h-gsc", [READ]);
    clockAt("2026-11-10T12:00:00Z");
    const { s, executeId } = session(auth, apply);

    const out = valueOf(await s.dispatch("searchconsole.topQueries", { siteUrl: SITE, days: 7, limit: 3 }));

    expect(out).toMatchObject({ siteUrl: SITE, startDate: "2026-11-01", endDate: "2026-11-07" });
    const rows = out.rows as Row[];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.query).toBe("example widgets");
    expect(rows.map((r) => r.clicks)).toEqual([...rows.map((r) => r.clicks)].sort((a, b) => b - a));
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["clicks", "ctr", "impressions", "position", "query"]);
    expect(s.plan).toEqual([]);

    await s.close();
    expect((await auditRows(executeId)).map((r) => [r.fn, r.applied, r.status])).toEqual([
      ["webmasters.searchanalytics.query", 0, "ok"],
      ["searchconsole.topQueries", 0, "ok"],
    ]);
    const asked = (await fake.requests(email)).filter((q) => q.path.endsWith("/searchAnalytics/query"));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.path).toContain(encodeURIComponent(SITE));
  });

  it("limits the window to the requested days", async () => {
    const { auth } = await connect("h-gsc", [READ]);
    clockAt("2026-11-10T12:00:00Z");
    const wide = valueOf(await session(auth, false).s.dispatch("searchconsole.topQueries", { siteUrl: SITE, days: 7 }));
    const narrow = valueOf(await session(auth, false).s.dispatch("searchconsole.topQueries", { siteUrl: SITE, days: 1 }));
    const clicks = (out: Record<string, unknown>) => (out.rows as Row[]).reduce((n, r) => n + r.clicks, 0);
    expect(clicks(narrow)).toBeGreaterThan(0);
    expect(clicks(narrow)).toBeLessThan(clicks(wide));
  });

  it("rejects bad input before calling Google", async () => {
    const { auth } = await connect("h-gsc", [READ]);
    const { s } = session(auth, false);
    for (const input of [{ siteUrl: SITE, days: 0 }, { siteUrl: SITE, limit: 5000 }, { days: 7 }, { siteUrl: SITE, extra: 1 }]) {
      expect(errorCodeOf(await s.dispatch("searchconsole.topQueries", input))).toBe("GWS_INVALID_INPUT");
    }
    expect(s.calls.map((c) => c.fn).every((fn) => fn === "searchconsole.topQueries")).toBe(true);
  });

  it("reports a property the account does not own as a Google error", async () => {
    const { auth } = await connect("h-gsc", [READ]);
    const code = errorCodeOf(await session(auth, false).s.dispatch("searchconsole.topQueries", { siteUrl: "https://not-mine.test/" }));
    expect(code).toBe("GWS_UPSTREAM_ERROR");
  });

  it("names the missing scope when the account never granted Search Console", async () => {
    const { auth } = await connect("h-gsc", [`${G}drive.file`]);
    expect(errorCodeOf(await session(auth, false).s.dispatch("searchconsole.topQueries", { siteUrl: SITE }))).toBe("GWS_SCOPE_MISSING");
  });
});

describe("searchconsole.topPages", () => {
  it("returns pages with most clicks first", async () => {
    const { auth } = await connect("h-gsc", [READ]);
    clockAt("2026-11-10T12:00:00Z");
    const out = valueOf(await session(auth, false).s.dispatch("searchconsole.topPages", { siteUrl: SITE, days: 7, limit: 2 }));
    const rows = out.rows as Row[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.page?.startsWith("https://example.test/")).toBe(true);
    expect(rows[0]?.clicks).toBeGreaterThanOrEqual(rows[1]?.clicks ?? 0);
    expect(rows[0]).not.toHaveProperty("query");
  });
});

describe("searchconsole.inspect", () => {
  it("returns the index status of an indexed page", async () => {
    const { auth } = await connect("h-gsc", [READ]);
    const out = valueOf(await session(auth, false).s.dispatch("searchconsole.inspect", { siteUrl: SITE, url: "https://example.test/pricing" }));
    expect(out).toMatchObject({
      url: "https://example.test/pricing",
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      googleCanonical: "https://example.test/pricing",
    });
    expect(typeof out.link).toBe("string");
  });

  it("shows a page that is not indexed", async () => {
    const { auth } = await connect("h-gsc", [READ]);
    const out = valueOf(await session(auth, false).s.dispatch("searchconsole.inspect", { siteUrl: SITE, url: "https://example.test/draft/post" }));
    expect(out.verdict).not.toBe("PASS");
  });

  it("surfaces a URL outside the property as a Google error", async () => {
    const { auth } = await connect("h-gsc", [READ]);
    expect(errorCodeOf(await session(auth, false).s.dispatch("searchconsole.inspect", { siteUrl: SITE, url: "https://other.test/x" }))).toBe("GWS_UPSTREAM_ERROR");
  });
});
