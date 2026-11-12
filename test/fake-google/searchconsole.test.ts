import { describe, expect, it } from "vitest";
import inspect from "../../fake-google/fixtures/searchconsole/url-inspection-inspect.json";
import query from "../../fake-google/fixtures/searchconsole/searchanalytics-query-by-query.json";
import queryByPage from "../../fake-google/fixtures/searchconsole/searchanalytics-query-by-page.json";
import sitemapsGet from "../../fake-google/fixtures/searchconsole/sitemaps-get.json";
import sitemapsList from "../../fake-google/fixtures/searchconsole/sitemaps-list.json";
import sitesGet from "../../fake-google/fixtures/searchconsole/sites-get.json";
import sitesList from "../../fake-google/fixtures/searchconsole/sites-list.json";
import { DoStore } from "../../fake-google/src/do-store";
import { parseFixture } from "../../fake-google/src/fixtures";
import { routes } from "../../fake-google/src/routes/searchconsole";
import { MemoryStore } from "../../fake-google/src/store";
import { G, account, api, callRoute, expectRouteScopes, json, memoryBackend, outputSchema, replay, send, type GoogleErrorBody } from "./support";

const RW = `${G}webmasters`;
const RO = `${G}webmasters.readonly`;
const BASE = "/searchconsole.googleapis.com/webmasters/v3/sites";
const INSPECT = "/searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const SITE = encodeURIComponent("https://example.test/");
const DOMAIN = encodeURIComponent("sc-domain:example.test");
const SITEMAP = encodeURIComponent("https://example.test/sitemap.xml");

interface Row {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}
const rows = (res: { rows?: Row[] }) => res.rows ?? [];
const sum = (rs: Row[], k: "clicks" | "impressions") => rs.reduce((n, r) => n + r[k], 0);

const analytics = (token: string, site: string, body: unknown) => send(token, "POST", `${BASE}/${site}/searchAnalytics/query`, body);
const RANGE = { startDate: "2026-11-01", endDate: "2026-11-07" };

describe("scopes", () => {
  const CASES = [
    { fn: "webmasters.sites.list", method: "GET", path: BASE },
    { fn: "webmasters.sites.get", method: "GET", path: `${BASE}/${SITE}` },
    { fn: "webmasters.sitemaps.list", method: "GET", path: `${BASE}/${SITE}/sitemaps` },
    { fn: "webmasters.sitemaps.get", method: "GET", path: `${BASE}/${SITE}/sitemaps/${SITEMAP}` },
    { fn: "webmasters.sitemaps.submit", method: "PUT", path: `${BASE}/${SITE}/sitemaps/${SITEMAP}` },
    { fn: "webmasters.sitemaps.delete", method: "DELETE", path: `${BASE}/${SITE}/sitemaps/${SITEMAP}` },
    { fn: "webmasters.searchanalytics.query", method: "POST", path: `${BASE}/${SITE}/searchAnalytics/query` },
    { fn: "searchconsole.urlInspection.index.inspect", method: "POST", path: INSPECT },
  ] as const;

  it("requires exactly the Discovery scopes of each method", () => {
    expectRouteScopes(routes, CASES);
  });

  it("refuses each route for a token without any of its scopes", async () => {
    const { token } = await account([`${G}calendar.events`]);
    for (const c of CASES) {
      const res = await api(token, c.path, { method: c.method });
      expect(res.status, `${c.method} ${c.path}`).toBe(403);
      const body = (await res.json()) as GoogleErrorBody;
      expect(body.error.details?.[0]?.reason).toBe("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    }
  });

  it("lets a readonly token read but not change sitemaps", async () => {
    const { token } = await account([RO]);
    expect((await api(token, `${BASE}/${SITE}/sitemaps`)).status).toBe(200);
    expect((await analytics(token, SITE, RANGE)).status).toBe(200);
    expect((await send(token, "PUT", `${BASE}/${SITE}/sitemaps/${encodeURIComponent("https://example.test/new.xml")}`)).status).toBe(403);
    expect((await api(token, `${BASE}/${SITE}/sitemaps/${SITEMAP}`, { method: "DELETE" })).status).toBe(403);
  });
});

describe("sites", () => {
  it("lists the seeded properties with their permission level", async () => {
    const { token } = await account([RO]);
    const list = await json<{ siteEntry: Array<{ siteUrl: string; permissionLevel: string }> }>(api(token, BASE));
    expect(list.siteEntry).toEqual([
      { siteUrl: "https://example.test/", permissionLevel: "SITE_OWNER" },
      { siteUrl: "sc-domain:example.test", permissionLevel: "SITE_OWNER" },
    ]);
    expect(outputSchema("webmasters.sites.list").safeParse(list).success).toBe(true);
  });

  it("gets one property by its encoded URL, including a domain property", async () => {
    const { token } = await account([RO]);
    expect(await json(api(token, `${BASE}/${SITE}`))).toEqual({ siteUrl: "https://example.test/", permissionLevel: "SITE_OWNER" });
    expect(await json(api(token, `${BASE}/${DOMAIN}`))).toEqual({ siteUrl: "sc-domain:example.test", permissionLevel: "SITE_OWNER" });
  });

  it("answers 403 for a property the account does not have, as Google does", async () => {
    const { token } = await account([RO]);
    const res = await json<GoogleErrorBody>(api(token, `${BASE}/${encodeURIComponent("https://other.test/")}`), 403);
    expect(res.error.message).toContain("User does not have sufficient permission for site");
    expect(res.error.errors?.[0]?.reason).toBe("forbidden");
  });

  it("lists nothing for an account without the seed", async () => {
    const { token } = await account([RO], { preset: "templates" });
    expect(await json(api(token, BASE))).toEqual({});
  });
});

describe("sitemaps", () => {
  const list = (token: string, site = SITE) => json<{ sitemap?: Array<{ path: string; isPending?: boolean; lastSubmitted?: string }> }>(api(token, `${BASE}/${site}/sitemaps`));

  it("lists and gets the seeded sitemap", async () => {
    const { token } = await account([RO]);
    const all = await list(token);
    expect(all.sitemap?.map((s) => s.path)).toEqual(["https://example.test/sitemap.xml"]);
    expect(outputSchema("webmasters.sitemaps.list").safeParse(all).success).toBe(true);
    const one = await json<{ path: string; type: string; contents: unknown[] }>(api(token, `${BASE}/${SITE}/sitemaps/${SITEMAP}`));
    expect(one.path).toBe("https://example.test/sitemap.xml");
    expect(one.type).toBe("SITEMAP");
    expect(one.contents.length).toBeGreaterThan(0);
    expect(outputSchema("webmasters.sitemaps.get").safeParse(one).success).toBe(true);
  });

  it("submits a sitemap, which the next list and get show as pending, and resubmitting refreshes it", async () => {
    const { token } = await account([RW]);
    const feed = encodeURIComponent("https://example.test/news.xml");
    const res = await send(token, "PUT", `${BASE}/${SITE}/sitemaps/${feed}`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect((await list(token)).sitemap?.map((s) => s.path)).toEqual(["https://example.test/news.xml", "https://example.test/sitemap.xml"]);
    const got = await json<{ path: string; isPending: boolean; lastSubmitted: string; errors: string; warnings: string }>(api(token, `${BASE}/${SITE}/sitemaps/${feed}`));
    expect(got).toMatchObject({ path: "https://example.test/news.xml", isPending: true, errors: "0", warnings: "0" });
    expect(got.lastSubmitted).toBe("2026-11-10T03:00:00.000Z");
    expect((await send(token, "PUT", `${BASE}/${SITE}/sitemaps/${feed}`)).status).toBe(204);
    expect((await list(token)).sitemap).toHaveLength(2);
  });

  it("keeps sitemaps of different properties apart", async () => {
    const { token } = await account([RW]);
    const feed = encodeURIComponent("https://example.test/only-domain.xml");
    await send(token, "PUT", `${BASE}/${DOMAIN}/sitemaps/${feed}`);
    expect((await list(token, DOMAIN)).sitemap?.map((s) => s.path)).toEqual(["https://example.test/only-domain.xml"]);
    expect((await list(token)).sitemap?.map((s) => s.path)).toEqual(["https://example.test/sitemap.xml"]);
  });

  it("deletes a sitemap, and the next get and list no longer show it", async () => {
    const { token } = await account([RW]);
    const res = await api(token, `${BASE}/${SITE}/sitemaps/${SITEMAP}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await list(token)).toEqual({});
    const gone = await json<GoogleErrorBody>(api(token, `${BASE}/${SITE}/sitemaps/${SITEMAP}`), 404);
    expect(gone.error.status).toBe("NOT_FOUND");
    expect((await api(token, `${BASE}/${SITE}/sitemaps/${SITEMAP}`, { method: "DELETE" })).status).toBe(404);
  });

  it("refuses writes to an unknown property and a sitemap that is not an http(s) URL", async () => {
    const { token } = await account([RW]);
    const other = encodeURIComponent("https://other.test/");
    expect((await send(token, "PUT", `${BASE}/${other}/sitemaps/${SITEMAP}`)).status).toBe(403);
    const bad = await json<GoogleErrorBody>(send(token, "PUT", `${BASE}/${SITE}/sitemaps/${encodeURIComponent("not a url")}`), 400);
    expect(bad.error.status).toBe("INVALID_ARGUMENT");
  });

  it("refuses the sitemapIndex option, which it does not model", async () => {
    const { token } = await account([RO]);
    expect((await api(token, `${BASE}/${SITE}/sitemaps?sitemapIndex=${SITEMAP}`)).status).toBe(400);
  });
});

describe("search analytics", () => {
  it("returns rows by query, most clicks first, with ctr and position derived from the sums", async () => {
    const { token } = await account([RO]);
    const res = await json<{ rows?: Row[] }>(analytics(token, SITE, { ...RANGE, dimensions: ["query"] }));
    const r = rows(res);
    expect(r.map((x) => x.keys?.length)).toEqual([1, 1, 1, 1]);
    expect(r.map((x) => x.clicks)).toEqual([...r.map((x) => x.clicks)].sort((a, b) => b - a));
    for (const row of r) {
      expect(row.ctr).toBeCloseTo(row.clicks / row.impressions, 10);
      expect(row.position).toBeGreaterThan(0);
    }
    expect(outputSchema("webmasters.searchanalytics.query").safeParse(res).success).toBe(true);
  });

  it("returns rows by page whose totals match the by-query totals", async () => {
    const { token } = await account([RO]);
    const byQuery = rows(await json(analytics(token, SITE, { ...RANGE, dimensions: ["query"] })));
    const byPage = rows(await json(analytics(token, SITE, { ...RANGE, dimensions: ["page"] })));
    expect(byPage.map((x) => x.keys?.[0]).sort()).toEqual(["https://example.test/", "https://example.test/blog/launch", "https://example.test/pricing"]);
    expect(sum(byPage, "clicks")).toBe(sum(byQuery, "clicks"));
    expect(sum(byPage, "impressions")).toBe(sum(byQuery, "impressions"));
    const total = rows(await json(analytics(token, SITE, RANGE)));
    expect(total).toHaveLength(1);
    expect(total[0]?.keys).toBeUndefined();
    expect(total[0]?.clicks).toBe(sum(byPage, "clicks"));
  });

  it("combines dimensions in the order asked and serves a domain property the same data", async () => {
    const { token } = await account([RO]);
    const both = rows(await json(analytics(token, SITE, { ...RANGE, dimensions: ["page", "query"] })));
    expect(both[0]?.keys).toHaveLength(2);
    expect(both[0]?.keys?.[0]).toMatch(/^https:\/\/example\.test/);
    const domain = rows(await json(analytics(token, DOMAIN, { ...RANGE, dimensions: ["page", "query"] })));
    expect(domain).toEqual(both);
  });

  it("limits to the date range, with one row per date when asked", async () => {
    const { token } = await account([RO]);
    const days = rows(await json(analytics(token, SITE, { ...RANGE, dimensions: ["date"] })));
    expect(days.map((d) => d.keys?.[0]).sort()).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"]);
    const one = rows(await json(analytics(token, SITE, { startDate: "2026-11-03", endDate: "2026-11-03", dimensions: ["date"] })));
    expect(one.map((d) => d.keys?.[0])).toEqual(["2026-11-03"]);
    expect(sum(days, "clicks")).toBeGreaterThan(sum(one, "clicks"));
    expect(await json(analytics(token, SITE, { startDate: "2025-01-01", endDate: "2025-01-02", dimensions: ["query"] }))).toEqual({});
  });

  it("applies rowLimit and startRow", async () => {
    const { token } = await account([RO]);
    const all = rows(await json(analytics(token, SITE, { ...RANGE, dimensions: ["query"] })));
    const limited = rows(await json(analytics(token, SITE, { ...RANGE, dimensions: ["query"], rowLimit: 2 })));
    expect(limited).toEqual(all.slice(0, 2));
    const paged = rows(await json(analytics(token, SITE, { ...RANGE, dimensions: ["query"], rowLimit: 2, startRow: 2 })));
    expect(paged).toEqual(all.slice(2, 4));
  });

  it("filters by dimension", async () => {
    const { token } = await account([RO]);
    const filtered = rows(
      await json(
        analytics(token, SITE, {
          ...RANGE,
          dimensions: ["query"],
          dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "query", operator: "contains", expression: "widget" }] }],
        }),
      ),
    );
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((r) => r.keys?.[0]?.includes("widget"))).toBe(true);
    const page = rows(
      await json(analytics(token, SITE, { ...RANGE, dimensions: ["page"], dimensionFilterGroups: [{ filters: [{ dimension: "page", expression: "https://example.test/pricing" }] }] })),
    );
    expect(page.map((r) => r.keys?.[0])).toEqual(["https://example.test/pricing"]);
  });

  it("refuses bad requests with a Google-shaped 400, and an unknown property with 403", async () => {
    const { token } = await account([RO]);
    for (const body of [
      {},
      { startDate: "11/01/2026", endDate: "2026-11-07" },
      { startDate: "2026-11-08", endDate: "2026-11-07" },
      { ...RANGE, dimensions: ["country"] },
      { ...RANGE, rowLimit: 0 },
      { ...RANGE, rowLimit: 25001 },
      { ...RANGE, startRow: -1 },
      { ...RANGE, searchType: "IMAGE" },
    ]) {
      const res = await json<GoogleErrorBody>(analytics(token, SITE, body), 400);
      expect(res.error.status, JSON.stringify(body)).toBe("INVALID_ARGUMENT");
    }
    expect((await analytics(token, encodeURIComponent("https://other.test/"), RANGE)).status).toBe(403);
  });
});

describe("url inspection", () => {
  const inspectUrl = (token: string, body: unknown) => send(token, "POST", INSPECT, body);

  it("reports an indexed page of an owned property, with the sitemap that lists it", async () => {
    const { token } = await account([RO]);
    const res = await json<{ inspectionResult: { indexStatusResult: Record<string, unknown>; inspectionResultLink: string } }>(
      inspectUrl(token, { inspectionUrl: "https://example.test/pricing", siteUrl: "https://example.test/" }),
    );
    expect(res.inspectionResult.indexStatusResult).toMatchObject({
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      robotsTxtState: "ALLOWED",
      indexingState: "INDEXING_ALLOWED",
      pageFetchState: "SUCCESSFUL",
      googleCanonical: "https://example.test/pricing",
      sitemap: ["https://example.test/sitemap.xml"],
    });
    expect(outputSchema("searchconsole.urlInspection.index.inspect").safeParse(res).success).toBe(true);
  });

  it("accepts a domain property and reports a draft page as not indexed", async () => {
    const { token } = await account([RO]);
    const res = await json<{ inspectionResult: { indexStatusResult: { verdict: string; coverageState: string } } }>(
      inspectUrl(token, { inspectionUrl: "https://example.test/draft/new", siteUrl: "sc-domain:example.test" }),
    );
    expect(res.inspectionResult.indexStatusResult).toMatchObject({ verdict: "NEUTRAL", coverageState: "Discovered - currently not indexed" });
  });

  it("refuses a URL outside the property or a property the account lacks with 403, and bad input with 400", async () => {
    const { token } = await account([RO]);
    const outside = await json<GoogleErrorBody>(inspectUrl(token, { inspectionUrl: "https://other.test/x", siteUrl: "https://example.test/" }), 403);
    expect(outside.error.message).toContain("not part of this property");
    expect((await inspectUrl(token, { inspectionUrl: "https://example.test/x", siteUrl: "https://other.test/" })).status).toBe(403);
    for (const body of [{}, { inspectionUrl: "https://example.test/x" }, { inspectionUrl: "nope", siteUrl: "https://example.test/" }]) {
      expect((await inspectUrl(token, body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("durable store", () => {
  it("keeps a submitted sitemap so that a following read sees it, with small chunks", async () => {
    const store = new DoStore(memoryBackend(), { chunkChars: 64 });
    const site = "/searchconsole.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.test%2F";
    await store.put("searchconsole:site:do@fake.test:https://example.test/", { siteUrl: "https://example.test/", permissionLevel: "SITE_OWNER" });
    const feed = encodeURIComponent("https://example.test/" + "long/".repeat(40) + "map.xml");
    expect((await callRoute(routes, store, "PUT", `${site}/sitemaps/${feed}`)).status).toBe(204);
    const list = await json<{ sitemap: Array<{ path: string }> }>(callRoute(routes, store, "GET", `${site}/sitemaps`));
    expect(list.sitemap.map((s) => s.path)).toEqual([decodeURIComponent(feed)]);
  });

  it("works on the in-memory store too", async () => {
    const store = new MemoryStore();
    await store.put("searchconsole:site:do@fake.test:https://example.test/", { siteUrl: "https://example.test/", permissionLevel: "SITE_OWNER" });
    expect(await json(callRoute(routes, store, "GET", `/searchconsole.googleapis.com/webmasters/v3/sites`))).toEqual({
      siteEntry: [{ siteUrl: "https://example.test/", permissionLevel: "SITE_OWNER" }],
    });
  });
});

describe("fixtures", () => {
  it("are what the fake serves for a seeded account", async () => {
    const { email, token } = await account([RW]);
    const steps = [
      [parseFixture(sitesList)],
      [parseFixture(sitesGet)],
      [parseFixture(sitemapsList)],
      [parseFixture(sitemapsGet)],
      [parseFixture(query), { ...RANGE, dimensions: ["query"], rowLimit: 10 }],
      [parseFixture(queryByPage), { ...RANGE, dimensions: ["page"], rowLimit: 10 }],
      [parseFixture(inspect), { inspectionUrl: "https://example.test/pricing", siteUrl: "https://example.test/" }],
    ] as const;
    for (const [fx, body] of steps) {
      expect(await replay(token, email, fx, body), fx.id).toEqual(fx.response.body);
    }
  });
});
