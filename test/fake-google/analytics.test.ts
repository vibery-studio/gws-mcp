import { describe, expect, it } from "vitest";
import accountSummariesList from "../../fake-google/fixtures/analytics/account-summaries-list.json";
import accountsList from "../../fake-google/fixtures/analytics/accounts-list.json";
import datastreamsCreate from "../../fake-google/fixtures/analytics/datastreams-create.json";
import datastreamsList from "../../fake-google/fixtures/analytics/datastreams-list.json";
import propertiesList from "../../fake-google/fixtures/analytics/properties-list.json";
import reportRealtime from "../../fake-google/fixtures/analytics/report-realtime.json";
import reportRun from "../../fake-google/fixtures/analytics/report-run.json";
import reportsBatchRun from "../../fake-google/fixtures/analytics/reports-batch-run.json";
import { DoStore } from "../../fake-google/src/do-store";
import { parseFixture } from "../../fake-google/src/fixtures";
import { routes } from "../../fake-google/src/routes/analytics";
import { G, account, api, callRoute, expectRouteScopes, json, memoryBackend, outputSchema, replay, send, type GoogleErrorBody } from "./support";

const EDIT = `${G}analytics.edit`;
const RO = `${G}analytics.readonly`;
const FULL = `${G}analytics`;
const DATA = "/analyticsdata.googleapis.com/v1beta";
const ADMIN = "/analyticsadmin.googleapis.com/v1beta";
const P = "properties/2001";

interface Report {
  dimensionHeaders?: Array<{ name: string }>;
  metricHeaders?: Array<{ name: string; type: string }>;
  rows?: Array<{ dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> }>;
  rowCount?: number;
  kind?: string;
  metadata?: { currencyCode: string; timeZone: string };
  propertyQuota?: unknown;
}
const run = (token: string, body: unknown, property = P) => send(token, "POST", `${DATA}/${property}:runReport`, body);
const RANGE = [{ startDate: "2026-11-01", endDate: "2026-11-07" }];
const metricSum = (r: Report, i = 0) => (r.rows ?? []).reduce((n, row) => n + Number(row.metricValues[i]?.value), 0);

describe("scopes", () => {
  const CASES = [
    { fn: "analyticsdata.properties.runReport", method: "POST", path: `${DATA}/${P}:runReport` },
    { fn: "analyticsdata.properties.batchRunReports", method: "POST", path: `${DATA}/${P}:batchRunReports` },
    { fn: "analyticsdata.properties.runRealtimeReport", method: "POST", path: `${DATA}/${P}:runRealtimeReport` },
    { fn: "analyticsdata.properties.getMetadata", method: "GET", path: `${DATA}/${P}/metadata` },
    { fn: "analyticsadmin.accounts.list", method: "GET", path: `${ADMIN}/accounts` },
    { fn: "analyticsadmin.accountSummaries.list", method: "GET", path: `${ADMIN}/accountSummaries` },
    { fn: "analyticsadmin.properties.list", method: "GET", path: `${ADMIN}/properties` },
    { fn: "analyticsadmin.properties.dataStreams.list", method: "GET", path: `${ADMIN}/${P}/dataStreams` },
    { fn: "analyticsadmin.properties.dataStreams.create", method: "POST", path: `${ADMIN}/${P}/dataStreams` },
    { fn: "analyticsadmin.properties.dataStreams.delete", method: "DELETE", path: `${ADMIN}/${P}/dataStreams/3001` },
  ] as const;

  it("requires exactly the Discovery scopes of each method", () => {
    expectRouteScopes(routes, CASES);
  });

  it("refuses each route for a token without any of its scopes", async () => {
    const { token } = await account([`${G}calendar.events`]);
    for (const c of CASES) {
      const res = await api(token, c.path, { method: c.method });
      expect(res.status, `${c.method} ${c.path}`).toBe(403);
      expect(((await res.json()) as GoogleErrorBody).error.details?.[0]?.reason).toBe("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    }
  });

  it("lets a readonly token read but not change data streams", async () => {
    const { token } = await account([RO]);
    expect((await api(token, `${ADMIN}/${P}/dataStreams`)).status).toBe(200);
    expect((await run(token, { dateRanges: RANGE, metrics: [{ name: "sessions" }] })).status).toBe(200);
    expect((await send(token, "POST", `${ADMIN}/${P}/dataStreams`, {})).status).toBe(403);
    expect((await api(token, `${ADMIN}/${P}/dataStreams/3001`, { method: "DELETE" })).status).toBe(403);
  });
});

describe("runReport", () => {
  it("returns one row per dimension value with string metric values, ordered by the dimension", async () => {
    const { token } = await account([RO]);
    const r = await json<Report>(run(token, { dateRanges: RANGE, dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }, { name: "activeUsers" }] }));
    expect(r.kind).toBe("analyticsData#runReport");
    expect(r.dimensionHeaders).toEqual([{ name: "date" }]);
    expect(r.metricHeaders).toEqual([
      { name: "sessions", type: "TYPE_INTEGER" },
      { name: "activeUsers", type: "TYPE_INTEGER" },
    ]);
    expect(r.rows?.map((x) => x.dimensionValues[0]?.value)).toEqual(["20261101", "20261102", "20261103", "20261104", "20261105", "20261106", "20261107"]);
    expect(r.rowCount).toBe(7);
    expect(typeof r.rows?.[0]?.metricValues[0]?.value).toBe("string");
    expect(r.metadata).toMatchObject({ timeZone: "Asia/Saigon" });
    expect(outputSchema("analyticsdata.properties.runReport").safeParse(r).success).toBe(true);
  });

  it("sums to the same total however it is sliced", async () => {
    const { token } = await account([RO]);
    const body = (dimension?: string) => ({ dateRanges: RANGE, metrics: [{ name: "screenPageViews" }], ...(dimension ? { dimensions: [{ name: dimension }] } : {}) });
    const total = metricSum(await json<Report>(run(token, body())));
    expect(total).toBeGreaterThan(0);
    for (const d of ["pagePath", "country", "deviceCategory", "date"]) {
      expect(metricSum(await json<Report>(run(token, body(d)))), d).toBe(total);
    }
  });

  it("limits to the date range, understanding relative dates against the account clock", async () => {
    const { token } = await account([RO]);
    const one = await json<Report>(run(token, { dateRanges: [{ startDate: "2026-11-03", endDate: "2026-11-03" }], dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }] }));
    expect(one.rows?.map((x) => x.dimensionValues[0]?.value)).toEqual(["20261103"]);
    const rel = await json<Report>(run(token, { dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }], dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }] }));
    expect(rel.rows?.map((x) => x.dimensionValues[0]?.value)).toEqual(["20261103", "20261104", "20261105", "20261106", "20261107"]);
    const none = await json<Report>(run(token, { dateRanges: [{ startDate: "2025-01-01", endDate: "2025-01-02" }], dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }] }));
    expect(none.rows).toBeUndefined();
    expect(none.rowCount).toBe(0);
  });

  it("orders by a metric, descending, and pages with limit and offset", async () => {
    const { token } = await account([RO]);
    const base = { dateRanges: RANGE, dimensions: [{ name: "pagePath" }], metrics: [{ name: "sessions" }] };
    const sorted = await json<Report>(run(token, { ...base, orderBys: [{ metric: { metricName: "sessions" }, desc: true }] }));
    const values = (sorted.rows ?? []).map((r) => Number(r.metricValues[0]?.value));
    expect(values).toEqual([...values].sort((a, b) => b - a));
    const page = await json<Report>(run(token, { ...base, orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: "1", offset: "1" }));
    expect(page.rows).toEqual(sorted.rows?.slice(1, 2));
    expect(page.rowCount).toBe(sorted.rows?.length);
    const byDim = await json<Report>(run(token, { ...base, orderBys: [{ dimension: { dimensionName: "pagePath" }, desc: true }] }));
    const paths = (byDim.rows ?? []).map((r) => r.dimensionValues[0]?.value ?? "");
    expect(paths).toEqual([...paths].sort().reverse());
  });

  it("adds a dateRange dimension for several ranges and quota on request", async () => {
    const { token } = await account([RO]);
    const r = await json<Report>(
      run(token, {
        dateRanges: [
          { startDate: "2026-11-01", endDate: "2026-11-03" },
          { startDate: "2026-11-04", endDate: "2026-11-07" },
        ],
        metrics: [{ name: "sessions" }],
        returnPropertyQuota: true,
      }),
    );
    expect(r.dimensionHeaders).toEqual([{ name: "dateRange" }]);
    expect(r.rows?.map((x) => x.dimensionValues[0]?.value)).toEqual(["date_range_0", "date_range_1"]);
    expect(r.propertyQuota).toBeDefined();
    expect(outputSchema("analyticsdata.properties.runReport").safeParse(r).success).toBe(true);
  });

  it("refuses bad requests with a Google-shaped 400", async () => {
    const { token } = await account([RO]);
    const ok = { dateRanges: RANGE, metrics: [{ name: "sessions" }] };
    for (const body of [
      {},
      { ...ok, dateRanges: [] },
      { ...ok, dateRanges: [{ startDate: "soon", endDate: "2026-11-07" }] },
      { ...ok, metrics: [{ name: "nonsense" }] },
      { ...ok, metrics: [] },
      { ...ok, dimensions: [{ name: "nonsense" }] },
      { ...ok, limit: "-1" },
      { ...ok, orderBys: [{ metric: { metricName: "views" } }] },
      { ...ok, dimensionFilter: { filter: { fieldName: "country" } } },
      { ...ok, cohortSpec: {} },
    ]) {
      const res = await json<GoogleErrorBody>(run(token, body), 400);
      expect(res.error.status, JSON.stringify(body)).toBe("INVALID_ARGUMENT");
    }
    const bad = await json<GoogleErrorBody>(run(token, { ...ok, metrics: [{ name: "nonsense" }] }), 400);
    expect(bad.error.message).toContain("nonsense");
  });

  it("answers 403 for a property the account does not have", async () => {
    const { token } = await account([RO]);
    const res = await run(token, { dateRanges: RANGE, metrics: [{ name: "sessions" }] }, "properties/999");
    expect(res.status).toBe(403);
  });
});

describe("batchRunReports", () => {
  it("answers one report per request, in order", async () => {
    const { token } = await account([RO]);
    const res = await json<{ kind: string; reports: Report[] }>(
      send(token, "POST", `${DATA}/${P}:batchRunReports`, {
        requests: [
          { dateRanges: RANGE, dimensions: [{ name: "country" }], metrics: [{ name: "sessions" }] },
          { dateRanges: RANGE, dimensions: [{ name: "deviceCategory" }], metrics: [{ name: "sessions" }] },
        ],
      }),
    );
    expect(res.kind).toBe("analyticsData#batchRunReports");
    expect(res.reports.map((r) => r.dimensionHeaders?.[0]?.name)).toEqual(["country", "deviceCategory"]);
    expect(metricSum(res.reports[0] as Report)).toBe(metricSum(res.reports[1] as Report));
    expect(outputSchema("analyticsdata.properties.batchRunReports").safeParse(res).success).toBe(true);
  });

  it("refuses an empty list, more than five requests, and a request for another property", async () => {
    const { token } = await account([RO]);
    const one = { dateRanges: RANGE, metrics: [{ name: "sessions" }] };
    const batch = (requests: unknown[]) => send(token, "POST", `${DATA}/${P}:batchRunReports`, { requests });
    expect((await batch([])).status).toBe(400);
    expect((await batch(Array.from({ length: 6 }, () => one))).status).toBe(400);
    expect((await batch([{ ...one, property: "properties/2002" }])).status).toBe(400);
    expect((await batch([one, { ...one, metrics: [{ name: "nope" }] }])).status).toBe(400);
  });
});

describe("runRealtimeReport", () => {
  const realtime = (token: string, body: unknown) => send(token, "POST", `${DATA}/${P}:runRealtimeReport`, body);

  it("returns current users by dimension", async () => {
    const { token } = await account([RO]);
    const r = await json<Report>(realtime(token, { dimensions: [{ name: "country" }], metrics: [{ name: "activeUsers" }] }));
    expect(r.kind).toBe("analyticsData#runRealtimeReport");
    expect(r.rows?.length).toBeGreaterThan(0);
    const total = metricSum(await json<Report>(realtime(token, { metrics: [{ name: "activeUsers" }] })));
    expect(metricSum(r)).toBe(total);
    expect(outputSchema("analyticsdata.properties.runRealtimeReport").safeParse(r).success).toBe(true);
  });

  it("refuses a historical dimension and a missing metric", async () => {
    const { token } = await account([RO]);
    expect((await realtime(token, { dimensions: [{ name: "date" }], metrics: [{ name: "activeUsers" }] })).status).toBe(400);
    expect((await realtime(token, { dimensions: [{ name: "country" }] })).status).toBe(400);
  });
});

describe("getMetadata", () => {
  it("lists the dimensions and metrics the fake serves", async () => {
    const { token } = await account([RO]);
    const m = await json<{ name: string; dimensions: Array<{ apiName: string }>; metrics: Array<{ apiName: string; type: string }> }>(api(token, `${DATA}/${P}/metadata`));
    expect(m.name).toBe("properties/2001/metadata");
    expect(m.dimensions.map((d) => d.apiName)).toEqual(expect.arrayContaining(["date", "pagePath", "country", "deviceCategory"]));
    expect(m.metrics.map((x) => x.apiName)).toEqual(expect.arrayContaining(["sessions", "activeUsers", "screenPageViews", "eventCount"]));
    expect(outputSchema("analyticsdata.properties.getMetadata").safeParse(m).success).toBe(true);
  });

  it("serves the property-independent list for property 0 and 403 for an unknown property", async () => {
    const { token } = await account([RO]);
    expect((await json<{ name: string }>(api(token, `${DATA}/properties/0/metadata`))).name).toBe("properties/0/metadata");
    expect((await api(token, `${DATA}/properties/999/metadata`)).status).toBe(403);
  });
});

describe("admin: accounts and properties", () => {
  it("lists the seeded accounts", async () => {
    const { token } = await account([RO]);
    const list = await json<{ accounts: Array<{ name: string; displayName: string }> }>(api(token, `${ADMIN}/accounts`));
    expect(list.accounts.map((a) => a.name)).toEqual(["accounts/1001", "accounts/1002"]);
    expect(outputSchema("analyticsadmin.accounts.list").safeParse(list).success).toBe(true);
  });

  it("pages accounts with pageSize and pageToken", async () => {
    const { token } = await account([RO]);
    const first = await json<{ accounts: Array<{ name: string }>; nextPageToken?: string }>(api(token, `${ADMIN}/accounts?pageSize=1`));
    expect(first.accounts.map((a) => a.name)).toEqual(["accounts/1001"]);
    expect(first.nextPageToken).toBeDefined();
    const second = await json<{ accounts: Array<{ name: string }>; nextPageToken?: string }>(api(token, `${ADMIN}/accounts?pageSize=1&pageToken=${first.nextPageToken}`));
    expect(second.accounts.map((a) => a.name)).toEqual(["accounts/1002"]);
    expect(second.nextPageToken).toBeUndefined();
    expect((await api(token, `${ADMIN}/accounts?pageSize=x`)).status).toBe(400);
  });

  it("lists properties filtered by parent", async () => {
    const { token } = await account([RO]);
    const list = (parent: string) => json<{ properties?: Array<{ name: string; parent: string }> }>(api(token, `${ADMIN}/properties?filter=${encodeURIComponent(`parent:${parent}`)}`));
    expect((await list("accounts/1001")).properties?.map((p) => p.name)).toEqual(["properties/2001"]);
    expect((await list("accounts/1002")).properties?.map((p) => p.name)).toEqual(["properties/2002"]);
    expect(await list("accounts/404")).toEqual({});
    expect(outputSchema("analyticsadmin.properties.list").safeParse(await list("accounts/1001")).success).toBe(true);
  });

  it("requires a parent filter", async () => {
    const { token } = await account([RO]);
    for (const q of ["", "?filter=", `?filter=${encodeURIComponent("firebase_project:projects/x")}`]) {
      const res = await json<GoogleErrorBody>(api(token, `${ADMIN}/properties${q}`), 400);
      expect(res.error.status).toBe("INVALID_ARGUMENT");
    }
  });
});

describe("admin: data streams", () => {
  const streams = (token: string, property = P) => json<{ dataStreams?: Array<{ name: string; displayName: string; webStreamData?: { measurementId: string; defaultUri: string } }> }>(api(token, `${ADMIN}/${property}/dataStreams`));

  it("lists the seeded web stream", async () => {
    const { token } = await account([RO]);
    const list = await streams(token);
    expect(list.dataStreams?.map((s) => s.name)).toEqual(["properties/2001/dataStreams/3001"]);
    expect(list.dataStreams?.[0]?.webStreamData).toEqual({ measurementId: "G-FAKE000001", defaultUri: "https://example.test" });
    expect(outputSchema("analyticsadmin.properties.dataStreams.list").safeParse(list).success).toBe(true);
    expect(await streams(token, "properties/2002")).toEqual({});
  });

  it("creates a web stream, which the next list shows, and deletes it again", async () => {
    const { token } = await account([EDIT]);
    const created = await json<{ name: string; type: string; displayName: string; webStreamData: { measurementId: string; defaultUri: string } }>(
      send(token, "POST", `${ADMIN}/${P}/dataStreams`, { type: "WEB_DATA_STREAM", displayName: "Blog", webStreamData: { defaultUri: "https://blog.example.test" } }),
    );
    expect(created.name).toMatch(/^properties\/2001\/dataStreams\/\d+$/);
    expect(created).toMatchObject({ type: "WEB_DATA_STREAM", displayName: "Blog" });
    expect(created.webStreamData.measurementId).toMatch(/^G-[A-Z0-9]{10}$/);
    expect(outputSchema("analyticsadmin.properties.dataStreams.create").safeParse(created).success).toBe(true);
    expect((await streams(token)).dataStreams?.map((s) => s.displayName)).toEqual(["Example web", "Blog"]);

    expect(await json(api(token, `${ADMIN}/${created.name}`, { method: "DELETE" }))).toEqual({});
    expect((await streams(token)).dataStreams?.map((s) => s.displayName)).toEqual(["Example web"]);
    expect((await api(token, `${ADMIN}/${created.name}`, { method: "DELETE" })).status).toBe(404);
  });

  it("refuses a stream that is not a complete web stream, and an unknown property", async () => {
    const { token } = await account([EDIT]);
    for (const body of [
      {},
      { type: "WEB_DATA_STREAM" },
      { type: "WEB_DATA_STREAM", displayName: "x" },
      { type: "ANDROID_APP_DATA_STREAM", displayName: "x" },
      { type: "WEB_DATA_STREAM", displayName: "x", webStreamData: { defaultUri: "nope" } },
    ]) {
      expect((await send(token, "POST", `${ADMIN}/${P}/dataStreams`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await send(token, "POST", `${ADMIN}/properties/999/dataStreams`, { type: "WEB_DATA_STREAM", displayName: "x", webStreamData: { defaultUri: "https://a.example.test" } })).status).toBe(403);
    expect((await api(token, `${ADMIN}/properties/999/dataStreams`)).status).toBe(403);
  });

  it("is deleted from the property only, not from another", async () => {
    const { token } = await account([EDIT]);
    expect((await api(token, `${ADMIN}/properties/2002/dataStreams/3001`, { method: "DELETE" })).status).toBe(404);
    expect((await streams(token)).dataStreams).toHaveLength(1);
  });
});

describe("durable store", () => {
  it("keeps a created stream so that a following read sees it, with small chunks", async () => {
    const store = new DoStore(memoryBackend(), { chunkChars: 64 });
    await store.put("analyticsadmin:property:do@fake.test:2001", { name: "properties/2001", parent: "accounts/1001", displayName: "x" });
    const created = await json<{ name: string }>(
      callRoute(routes, store, "POST", `${ADMIN}/${P}/dataStreams`, { type: "WEB_DATA_STREAM", displayName: "d".repeat(200), webStreamData: { defaultUri: "https://do.example.test" } }),
    );
    const list = await json<{ dataStreams: Array<{ name: string }> }>(callRoute(routes, store, "GET", `${ADMIN}/${P}/dataStreams`));
    expect(list.dataStreams.map((s) => s.name)).toEqual([created.name]);
  });
});

describe("accountSummaries", () => {
  it("lists each account with its properties, and pages", async () => {
    const { token } = await account([RO]);
    interface Summaries {
      accountSummaries?: Array<{ name: string; account: string; propertySummaries?: Array<{ property: string; parent: string }> }>;
      nextPageToken?: string;
    }
    const all = await json<Summaries>(api(token, `${ADMIN}/accountSummaries`));
    expect(all.accountSummaries?.map((a) => [a.account, a.propertySummaries?.map((p) => p.property)])).toEqual([
      ["accounts/1001", ["properties/2001"]],
      ["accounts/1002", ["properties/2002"]],
    ]);
    expect(outputSchema("analyticsadmin.accountSummaries.list").safeParse(all).success).toBe(true);
    const first = await json<Summaries>(api(token, `${ADMIN}/accountSummaries?pageSize=1`));
    expect(first.accountSummaries).toHaveLength(1);
    expect(first.nextPageToken).toBeDefined();
  });
});

describe("fixtures", () => {
  it("are what the fake serves for a seeded account, replayed in order", async () => {
    const { email, token } = await account([EDIT, FULL]);
    const report = { dateRanges: RANGE, dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }, { name: "activeUsers" }] };
    const steps: Array<[ReturnType<typeof parseFixture>, unknown?]> = [
      [parseFixture(accountsList)],
      [parseFixture(accountSummariesList)],
      [parseFixture(propertiesList)],
      [parseFixture(datastreamsList)],
      [parseFixture(reportRun), report],
      [parseFixture(reportsBatchRun), { requests: [report, { dateRanges: RANGE, dimensions: [{ name: "country" }], metrics: [{ name: "screenPageViews" }] }] }],
      [parseFixture(reportRealtime), { dimensions: [{ name: "country" }], metrics: [{ name: "activeUsers" }] }],
      [parseFixture(datastreamsCreate), { type: "WEB_DATA_STREAM", displayName: "Blog", webStreamData: { defaultUri: "https://blog.example.test" } }],
    ];
    for (const [fx, body] of steps) {
      const actual = (await replay(token, email, fx, body)) as Record<string, unknown>;
      const expected = { ...(fx.response.body as Record<string, unknown>) };
      if (fx.id === "analytics-datastreams-create") {
        // A new stream has a fresh id and measurement id.
        for (const o of [actual, expected]) {
          delete o.name;
          delete o.webStreamData;
          delete o.createTime;
          delete o.updateTime;
        }
      }
      expect(actual, fx.id).toEqual(expected);
    }
  });
});
