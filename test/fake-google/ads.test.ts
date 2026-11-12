import { describe, expect, it } from "vitest";
import campaignsMutate from "../../fake-google/fixtures/ads/campaigns-mutate.json";
import customersListAccessible from "../../fake-google/fixtures/ads/customers-list-accessible.json";
import searchAdGroups from "../../fake-google/fixtures/ads/search-ad-groups.json";
import searchCampaigns from "../../fake-google/fixtures/ads/search-campaigns.json";
import searchKeywords from "../../fake-google/fixtures/ads/search-keywords.json";
import { DoStore } from "../../fake-google/src/do-store";
import { parseFixture } from "../../fake-google/src/fixtures";
import { STREAM_BATCH_SIZE, routes } from "../../fake-google/src/routes/ads";
import { fake } from "../helpers/fake";
import { G, account, api, callRoute, expectRouteScopes, json, memoryBackend, outputSchema, replay, send, type GoogleErrorBody } from "./support";

const ADWORDS = `${G}adwords`;
const BASE = "/googleads.googleapis.com/v23/customers";
const STORE = "9876543210";
const MANAGER = "1234567890";
const HEADERS: Record<string, string> = { "developer-token": "dev-token-for-tests" };

interface Row {
  campaign?: { resourceName: string; id?: string; name?: string; status?: string; advertisingChannelType?: string };
  adGroup?: { resourceName: string; id?: string; name?: string; status?: string };
  metrics?: Record<string, string | number>;
  segments?: { date: string };
  customer?: { id?: string; descriptiveName?: string };
}
interface Search {
  results?: Row[];
  fieldMask?: string;
  nextPageToken?: string;
  totalResultsCount?: string;
}

const searchPath = (cid = STORE, method = "search") => `${BASE}/${cid}/googleAds:${method}`;
const gaql = (token: string, query: string, extra: Record<string, unknown> = {}, cid = STORE, headers = HEADERS) =>
  send(token, "POST", searchPath(cid), { query, ...extra }, headers);
const rowsOf = async (token: string, query: string) => (await json<Search>(gaql(token, query))).results ?? [];
const int = (v: string | number | undefined) => Number(v);

describe("scopes", () => {
  it("requires the adwords scope, exactly as the generated methods do", () => {
    expectRouteScopes(routes, [
      { fn: "googleads.customers.listAccessibleCustomers", method: "GET", path: `${BASE}:listAccessibleCustomers` },
      { fn: "googleads.customers.googleAds.search", method: "POST", path: searchPath() },
      { fn: "googleads.customers.googleAds.searchStream", method: "POST", path: searchPath(STORE, "searchStream") },
      { fn: "googleads.customers.campaigns.mutate", method: "POST", path: `${BASE}/${STORE}/campaigns:mutate` },
    ]);
  });

  it("refuses a token without it", async () => {
    const { token } = await account([`${G}calendar.events`]);
    for (const [method, path] of [["GET", `${BASE}:listAccessibleCustomers`], ["POST", searchPath()], ["POST", searchPath(STORE, "searchStream")], ["POST", `${BASE}/${STORE}/campaigns:mutate`]] as const) {
      const res = await send(token, method, path, undefined, HEADERS);
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as GoogleErrorBody).error.details?.[0]?.reason).toBe("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    }
  });
});

describe("developer token and login customer id", () => {
  it("answers Google's authentication error when the developer-token header is missing, for every route", async () => {
    const { token } = await account([ADWORDS]);
    for (const [method, path, body] of [
      ["GET", `${BASE}:listAccessibleCustomers`, undefined],
      ["POST", searchPath(), { query: "SELECT campaign.id FROM campaign" }],
      ["POST", searchPath(STORE, "searchStream"), { query: "SELECT campaign.id FROM campaign" }],
      ["POST", `${BASE}/${STORE}/campaigns:mutate`, { operations: [{ remove: `customers/${STORE}/campaigns/111111111` }] }],
    ] as const) {
      const res = await json<GoogleErrorBody>(send(token, method, path, body), 401);
      expect(res.error.status, path).toBe("UNAUTHENTICATED");
      const failure = res.error.details?.[0] as { "@type": string; errors: Array<{ errorCode: Record<string, string> }> };
      expect(failure["@type"]).toContain("GoogleAdsFailure");
      expect(failure.errors[0]?.errorCode).toEqual({ authenticationError: "DEVELOPER_TOKEN_PARAMETER_MISSING" });
    }
    // The refused mutate changed nothing.
    expect((await rowsOf(token, "SELECT campaign.status FROM campaign WHERE campaign.id = 111111111"))[0]?.campaign?.status).toBe("ENABLED");
  });

  it("records the login-customer-id that was sent, and null when it was not", async () => {
    const { email, token } = await account([ADWORDS]);
    await gaql(token, "SELECT campaign.id FROM campaign", {}, STORE, { ...HEADERS, "login-customer-id": MANAGER });
    await gaql(token, "SELECT campaign.id FROM campaign");
    await send(token, "GET", `${BASE}:listAccessibleCustomers`);
    const calls = Object.entries((await fake.state(email)).resources)
      .filter(([k]) => k.startsWith(`ads:call:${email}:`))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => v as { path: string; developerToken: boolean; loginCustomerId: string | null });
    expect(calls.map((c) => [c.developerToken, c.loginCustomerId])).toEqual([
      [true, MANAGER],
      [true, null],
      [false, null],
    ]);
    expect(JSON.stringify(calls)).not.toContain("dev-token-for-tests");
  });

  it("refuses a login-customer-id that is not ten digits", async () => {
    const { token } = await account([ADWORDS]);
    for (const bad of ["123-456-7890", "abc", "12345"]) {
      const res = await json<GoogleErrorBody>(gaql(token, "SELECT campaign.id FROM campaign", {}, STORE, { ...HEADERS, "login-customer-id": bad }), 400);
      expect((res.error.details?.[0] as { errors: Array<{ errorCode: unknown }> }).errors[0]?.errorCode).toEqual({ headerError: "INVALID_LOGIN_CUSTOMER_ID" });
    }
  });
});

describe("listAccessibleCustomers", () => {
  it("lists the customers of the account", async () => {
    const { token } = await account([ADWORDS]);
    const res = await json<{ resourceNames: string[] }>(send(token, "GET", `${BASE}:listAccessibleCustomers`, undefined, HEADERS));
    expect(res.resourceNames).toEqual([`customers/${MANAGER}`, `customers/${STORE}`]);
    expect(outputSchema("googleads.customers.listAccessibleCustomers").safeParse(res).success).toBe(true);
  });

  it("is empty for an account without customers", async () => {
    const { token } = await account([ADWORDS], { preset: "templates" });
    expect(await json(send(token, "GET", `${BASE}:listAccessibleCustomers`, undefined, HEADERS))).toEqual({});
  });
});

describe("googleAds:search", () => {
  it("selects campaign fields; ints are strings, the resource name is always there", async () => {
    const { token } = await account([ADWORDS]);
    const res = await json<Search>(gaql(token, "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign ORDER BY campaign.id"));
    expect(res.fieldMask).toBe("campaign.id,campaign.name,campaign.status,campaign.advertisingChannelType");
    expect(res.results).toEqual([
      { campaign: { resourceName: `customers/${STORE}/campaigns/111111111`, id: "111111111", name: "Brand search", status: "ENABLED", advertisingChannelType: "SEARCH" } },
      { campaign: { resourceName: `customers/${STORE}/campaigns/222222222`, id: "222222222", name: "Shopping feed", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX" } },
      { campaign: { resourceName: `customers/${STORE}/campaigns/333333333`, id: "333333333", name: "Winter promo", status: "PAUSED", advertisingChannelType: "DISPLAY" } },
    ]);
    expect(outputSchema("googleads.customers.googleAds.search").safeParse(res).success).toBe(true);
  });

  it("selects ad groups together with their campaign", async () => {
    const { token } = await account([ADWORDS]);
    const rows = await rowsOf(token, "SELECT ad_group.id, ad_group.name, campaign.name FROM ad_group WHERE campaign.status = ENABLED ORDER BY ad_group.id");
    expect(rows.map((r) => [r.adGroup?.name, r.campaign?.name])).toEqual([
      ["Brand exact", "Brand search"],
      ["Brand phrase", "Brand search"],
      ["Asset group", "Shopping feed"],
    ]);
    expect(rows[0]?.adGroup?.resourceName).toBe(`customers/${STORE}/adGroups/1001`);
  });

  it("selects keywords with their ad group and campaign, with the metrics of their own", async () => {
    const { token } = await account([ADWORDS]);
    const rows = await rowsOf(
      token,
      "SELECT campaign.name, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.clicks FROM keyword_view WHERE ad_group_criterion.status != REMOVED ORDER BY ad_group_criterion.criterion_id",
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      campaign: { name: "Brand search" },
      adGroup: { name: "Brand exact" },
      adGroupCriterion: { resourceName: `customers/${STORE}/adGroupCriteria/1001~5001`, criterionId: "5001", keyword: { text: "example store", matchType: "EXACT" } },
    });
    expect(rows.map((r) => (r as { adGroupCriterion?: { keyword?: { text?: string } } }).adGroupCriterion?.keyword?.text)).toEqual(["example store", "buy example", "example shipping", "winter sale"]);
    expect(typeof rows[0]?.metrics?.clicks).toBe("string");
    // Two keywords of one ad group do not share metrics.
    expect(rows[1]?.metrics?.clicks).not.toBe(rows[2]?.metrics?.clicks);
    const fewer = await rowsOf(token, "SELECT ad_group_criterion.keyword.text FROM keyword_view WHERE ad_group_criterion.keyword.match_type = PHRASE");
    expect(fewer).toHaveLength(2);
  });

  it("filters with WHERE: comparison, IN, NOT IN, LIKE", async () => {
    const { token } = await account([ADWORDS]);
    const names = async (where: string) => (await rowsOf(token, `SELECT campaign.name FROM campaign WHERE ${where} ORDER BY campaign.id`)).map((r) => r.campaign?.name);
    expect(await names("campaign.status = PAUSED")).toEqual(["Winter promo"]);
    expect(await names("campaign.status != PAUSED")).toEqual(["Brand search", "Shopping feed"]);
    expect(await names("campaign.id IN (111111111, 333333333)")).toEqual(["Brand search", "Winter promo"]);
    expect(await names("campaign.advertising_channel_type NOT IN (SEARCH, DISPLAY)")).toEqual(["Shopping feed"]);
    expect(await names("campaign.name LIKE '%promo'")).toEqual(["Winter promo"]);
    expect(await names("campaign.id > 111111111 AND campaign.status = ENABLED")).toEqual(["Shopping feed"]);
  });

  it("orders and limits, and metrics sum up from ad groups to campaigns", async () => {
    const { token } = await account([ADWORDS]);
    const byClicks = await rowsOf(token, "SELECT campaign.name, metrics.clicks FROM campaign ORDER BY metrics.clicks DESC LIMIT 2");
    expect(byClicks).toHaveLength(2);
    expect(int(byClicks[0]?.metrics?.clicks)).toBeGreaterThanOrEqual(int(byClicks[1]?.metrics?.clicks));
    expect(typeof byClicks[0]?.metrics?.clicks).toBe("string");

    const campaigns = await rowsOf(token, "SELECT campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.ctr, metrics.average_cpc FROM campaign WHERE campaign.id = 111111111");
    const groups = await rowsOf(token, "SELECT ad_group.id, metrics.impressions, metrics.clicks, metrics.cost_micros FROM ad_group WHERE campaign.id = 111111111");
    expect(groups).toHaveLength(2);
    for (const k of ["impressions", "clicks", "cost_micros"] as const) {
      const key = k === "cost_micros" ? "costMicros" : k;
      expect(int(campaigns[0]?.metrics?.[key]), key).toBe(groups.reduce((n, g) => n + int(g.metrics?.[key]), 0));
    }
    const m = campaigns[0]?.metrics as Record<string, string | number>;
    expect(typeof m.conversions).toBe("number");
    expect(m.ctr).toBeCloseTo(int(m.clicks) / int(m.impressions), 10);
    expect(m.averageCpc).toBeCloseTo(int(m.costMicros) / int(m.clicks), 6);
    expect(outputSchema("googleads.customers.googleAds.search").safeParse({ results: campaigns }).success).toBe(true);
  });

  it("segments by date, one row per day, and the days add up to the unsegmented total", async () => {
    const { token } = await account([ADWORDS]);
    const days = await rowsOf(token, "SELECT campaign.id, segments.date, metrics.clicks FROM campaign WHERE campaign.id = 111111111 ORDER BY segments.date");
    expect(days.map((d) => d.segments?.date)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"]);
    const total = await rowsOf(token, "SELECT metrics.clicks FROM campaign WHERE campaign.id = 111111111");
    expect(days.reduce((n, d) => n + int(d.metrics?.clicks), 0)).toBe(int(total[0]?.metrics?.clicks));
  });

  it("limits the dates with BETWEEN, a single date and DURING against the account clock", async () => {
    const { token } = await account([ADWORDS]);
    const dates = async (cond: string) => (await rowsOf(token, `SELECT campaign.id, segments.date, metrics.clicks FROM campaign WHERE campaign.id = 111111111 AND ${cond} ORDER BY segments.date`)).map((r) => r.segments?.date);
    expect(await dates("segments.date BETWEEN '2026-11-04' AND '2026-11-05'")).toEqual(["2026-11-04", "2026-11-05"]);
    expect(await dates("segments.date = '2026-11-09'")).toEqual(["2026-11-09"]);
    expect(await dates("segments.date DURING LAST_7_DAYS")).toEqual(["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"]);
    expect(await dates("segments.date DURING YESTERDAY")).toEqual(["2026-11-09"]);
    expect(await dates("segments.date DURING TODAY")).toEqual([]);
    const narrowed = await rowsOf(token, "SELECT metrics.clicks FROM campaign WHERE campaign.id = 111111111 AND segments.date = '2026-11-09'");
    const all = await rowsOf(token, "SELECT metrics.clicks FROM campaign WHERE campaign.id = 111111111");
    expect(int(narrowed[0]?.metrics?.clicks)).toBeLessThan(int(all[0]?.metrics?.clicks));
  });

  it("filters on metrics after summing", async () => {
    const { token } = await account([ADWORDS]);
    const all = await rowsOf(token, "SELECT campaign.id, metrics.clicks FROM campaign ORDER BY metrics.clicks");
    const cut = int(all[1]?.metrics?.clicks);
    const some = await rowsOf(token, `SELECT campaign.id, metrics.clicks FROM campaign WHERE metrics.clicks >= ${cut} ORDER BY metrics.clicks`);
    expect(some.map((r) => r.campaign?.id)).toEqual(all.slice(1).map((r) => r.campaign?.id));
  });

  it("selects the customer fields", async () => {
    const { token } = await account([ADWORDS]);
    const rows = await rowsOf(token, "SELECT customer.id, customer.descriptive_name FROM campaign LIMIT 1");
    expect(rows[0]?.customer).toEqual({ id: STORE, descriptiveName: "Example Store" });
  });

  it("pages with pageSize and pageToken, and counts on request", async () => {
    const { token } = await account([ADWORDS]);
    const q = "SELECT campaign.id FROM campaign ORDER BY campaign.id";
    const first = await json<Search>(gaql(token, q, { pageSize: 2, returnTotalResultsCount: true }));
    expect(first.results).toHaveLength(2);
    expect(first.totalResultsCount).toBe("3");
    expect(first.nextPageToken).toBeDefined();
    const second = await json<Search>(gaql(token, q, { pageSize: 2, pageToken: first.nextPageToken }));
    expect(second.results?.map((r) => r.campaign?.id)).toEqual(["333333333"]);
    expect(second.nextPageToken).toBeUndefined();
    expect(second.totalResultsCount).toBeUndefined();
  });

  it("returns no results for a customer without campaigns, and validates without running", async () => {
    const { token } = await account([ADWORDS]);
    const none = await json<Search>(gaql(token, "SELECT campaign.id FROM campaign", {}, MANAGER));
    expect(none.results).toBeUndefined();
    expect(none.fieldMask).toBe("campaign.id");
    expect(await json(gaql(token, "SELECT campaign.id FROM campaign", { validateOnly: true }))).toEqual({});
    expect((await gaql(token, "SELECT nope FROM campaign", { validateOnly: true })).status).toBe(400);
  });

  it("answers Google's query errors with the error family and a message", async () => {
    const { token } = await account([ADWORDS]);
    const cases: Array<[string, string]> = [
      ["SELECT campaign.id", "UNEXPECTED_END_OF_QUERY"],
      ["SELECT campaign.idd FROM campaign", "UNRECOGNIZED_FIELD"],
      ["SELECT ad_group.id FROM campaign", "PROHIBITED_FIELD_IN_SELECT_CLAUSE"],
      ["SELECT campaign.id FROM campaign WHERE ad_group.id = 1", "PROHIBITED_FIELD_IN_WHERE_CLAUSE"],
      ["SELECT campaign.id FROM customer", "PROHIBITED_RESOURCE_TYPE_IN_FROM_CLAUSE"],
      ["SELECT ad_group_criterion.keyword.text FROM ad_group", "PROHIBITED_FIELD_IN_SELECT_CLAUSE"],
      ["SELECT campaign.id FROM campaign WHERE segments.date = 'yesterday'", "INVALID_DATE"],
      ["SELECT campaign.id FROM campaign WHERE segments.date DURING LAST_QUARTER", "INVALID_DATE"],
    ];
    for (const [query, family] of cases) {
      const res = await json<GoogleErrorBody>(gaql(token, query), 400);
      const failure = res.error.details?.[0] as { errors: Array<{ errorCode: { queryError: string }; message: string }> };
      expect(res.error.status, query).toBe("INVALID_ARGUMENT");
      expect(failure.errors[0]?.errorCode.queryError, query).toBe(family);
      expect(failure.errors[0]?.message, query).toContain("Error in query");
    }
    expect((await send(token, "POST", searchPath(), {}, HEADERS)).status).toBe(400);
    expect((await gaql(token, "SELECT campaign.id FROM campaign", { pageSize: "x" })).status).toBe(400);
  });

  it("answers 403 for a customer the account cannot reach", async () => {
    const { token } = await account([ADWORDS]);
    const res = await json<GoogleErrorBody>(gaql(token, "SELECT campaign.id FROM campaign", {}, "5555555555"), 403);
    expect(res.error.status).toBe("PERMISSION_DENIED");
    expect((res.error.details?.[0] as { errors: Array<{ errorCode: unknown }> }).errors[0]?.errorCode).toEqual({ authorizationError: "USER_PERMISSION_DENIED" });
  });
});

describe("googleAds:searchStream", () => {
  const stream = (token: string, query: string, extra: Record<string, unknown> = {}) => send(token, "POST", searchPath(STORE, "searchStream"), { query, ...extra }, HEADERS);

  it("returns a JSON array of batches with the same rows as search", async () => {
    const { token } = await account([ADWORDS]);
    const q = "SELECT campaign.id, segments.date, metrics.clicks FROM campaign ORDER BY campaign.id, segments.date";
    const batches = await json<Search[]>(stream(token, q));
    expect(Array.isArray(batches)).toBe(true);
    const streamed = batches.flatMap((b) => b.results ?? []);
    expect(streamed).toEqual(await rowsOf(token, q));
    expect(streamed).toHaveLength(21);
    for (const b of batches) expect(b.fieldMask).toBe("campaign.id,segments.date,metrics.clicks");
    expect(outputSchema("googleads.customers.googleAds.searchStream").safeParse(batches[0]).success).toBe(true);
  });

  it("splits into batches of at most STREAM_BATCH_SIZE rows, in order", async () => {
    const { token } = await account([ADWORDS]);
    const batches = await json<Search[]>(stream(token, "SELECT campaign.id, segments.date FROM campaign ORDER BY campaign.id, segments.date"));
    expect(batches.map((b) => b.results?.length)).toEqual([STREAM_BATCH_SIZE, STREAM_BATCH_SIZE, 1]);
    const small = await json<Search[]>(stream(token, "SELECT campaign.id FROM campaign"));
    expect(small).toHaveLength(1);
  });

  it("returns one batch without results when nothing matches", async () => {
    const { token } = await account([ADWORDS]);
    const batches = await json<Search[]>(stream(token, "SELECT campaign.id FROM campaign WHERE campaign.name = 'none'"));
    expect(batches).toHaveLength(1);
    expect(batches[0]?.results).toBeUndefined();
    expect(batches[0]?.fieldMask).toBe("campaign.id");
  });

  it("refuses a bad query and a summary row", async () => {
    const { token } = await account([ADWORDS]);
    expect((await stream(token, "nonsense")).status).toBe(400);
    expect((await stream(token, "SELECT campaign.id FROM campaign", { summaryRowSetting: "SUMMARY_ROW_ONLY" })).status).toBe(400);
  });
});

describe("campaigns:mutate", () => {
  const mutate = (token: string, body: unknown, headers = HEADERS) => send(token, "POST", `${BASE}/${STORE}/campaigns:mutate`, body, headers);
  const status = async (token: string, id: string) => (await rowsOf(token, `SELECT campaign.status, campaign.name FROM campaign WHERE campaign.id = ${id}`))[0]?.campaign;

  it("updates a campaign, which the next search shows", async () => {
    const { token } = await account([ADWORDS]);
    const res = await json<{ results: Array<{ resourceName: string }> }>(
      mutate(token, { operations: [{ update: { resourceName: `customers/${STORE}/campaigns/333333333`, status: "ENABLED", name: "Ignored" }, updateMask: "status" }] }),
    );
    expect(res.results).toEqual([{ resourceName: `customers/${STORE}/campaigns/333333333` }]);
    expect(outputSchema("googleads.customers.campaigns.mutate").safeParse(res).success).toBe(true);
    expect(await status(token, "333333333")).toMatchObject({ status: "ENABLED", name: "Winter promo" });
  });

  it("creates a campaign, paused by default, and returns the resource on request", async () => {
    const { token } = await account([ADWORDS]);
    const res = await json<{ results: Array<{ resourceName: string; campaign?: { id: string; name: string; status: string } }> }>(
      mutate(token, { operations: [{ create: { name: "Spring sale" } }], responseContentType: "MUTABLE_RESOURCE" }),
    );
    const made = res.results[0]?.campaign;
    expect(res.results[0]?.resourceName).toMatch(new RegExp(`^customers/${STORE}/campaigns/\\d{9}$`));
    expect(made).toMatchObject({ name: "Spring sale", status: "PAUSED" });
    expect(await status(token, made?.id ?? "")).toMatchObject({ name: "Spring sale", status: "PAUSED" });
    expect(await rowsOf(token, "SELECT campaign.id FROM campaign")).toHaveLength(4);
  });

  it("removes a campaign by setting it to REMOVED", async () => {
    const { token } = await account([ADWORDS]);
    await json(mutate(token, { operations: [{ remove: `customers/${STORE}/campaigns/222222222` }] }));
    expect(await status(token, "222222222")).toMatchObject({ status: "REMOVED" });
    // A removed campaign cannot be changed again.
    expect((await mutate(token, { operations: [{ update: { resourceName: `customers/${STORE}/campaigns/222222222`, status: "ENABLED" }, updateMask: "status" }] })).status).toBe(400);
  });

  it("is all or nothing, and validateOnly changes nothing", async () => {
    const { token } = await account([ADWORDS]);
    const good = { update: { resourceName: `customers/${STORE}/campaigns/333333333`, status: "ENABLED" }, updateMask: "status" };
    const bad = { remove: `customers/${STORE}/campaigns/404` };
    const res = await json<GoogleErrorBody>(mutate(token, { operations: [good, bad] }), 400);
    expect(res.error.status).toBe("INVALID_ARGUMENT");
    expect((await status(token, "333333333"))?.status).toBe("PAUSED");
    expect(await json(mutate(token, { operations: [good], validateOnly: true }))).toEqual({});
    expect((await status(token, "333333333"))?.status).toBe("PAUSED");
  });

  it("refuses unsupported or malformed operations", async () => {
    const { token } = await account([ADWORDS]);
    const target = `customers/${STORE}/campaigns/111111111`;
    for (const body of [
      {},
      { operations: [] },
      { operations: [{}] },
      { operations: [{ create: { name: "x" }, remove: target }] },
      { operations: [{ create: {} }] },
      { operations: [{ create: { name: "x", budget: "b" } }] },
      { operations: [{ create: { name: "Brand search" } }] },
      { operations: [{ create: { name: "x", status: "REMOVED" } }] },
      { operations: [{ update: { resourceName: target, status: "PAUSED" } }] },
      { operations: [{ update: { resourceName: target, status: "PAUSED" }, updateMask: "budget" }] },
      { operations: [{ remove: "customers/1/campaigns/1" }] },
      { operations: [{ remove: target }], partialFailure: true },
      { operations: [{ remove: target }], responseContentType: "NOPE" },
    ]) {
      expect((await mutate(token, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await status(token, "111111111"))?.status).toBe("ENABLED");
  });
});

describe("durable store", () => {
  it("keeps a mutation so that a following search sees it, with small chunks", async () => {
    const store = new DoStore(memoryBackend(), { chunkChars: 64 });
    await store.put("ads:customer:do@fake.test:9876543210", { id: STORE, descriptiveName: "x".repeat(200), currencyCode: "USD", timeZone: "UTC", manager: false });
    const made = await json<{ results: Array<{ resourceName: string }> }>(
      callRoute(routes, store, "POST", `${BASE}/${STORE}/campaigns:mutate`, { operations: [{ create: { name: "Durable" } }] }, HEADERS),
    );
    const found = await json<Search>(callRoute(routes, store, "POST", searchPath(), { query: "SELECT campaign.name FROM campaign" }, HEADERS));
    expect(found.results?.[0]?.campaign?.name).toBe("Durable");
    expect(found.results?.[0]?.campaign?.resourceName).toBe(made.results[0]?.resourceName);
  });

  it("keeps only the newest calls", async () => {
    const store = new DoStore(memoryBackend());
    await store.put("ads:customer:do@fake.test:9876543210", { id: STORE, descriptiveName: "x", currencyCode: "USD", timeZone: "UTC", manager: false });
    for (let i = 0; i < 205; i++) await callRoute(routes, store, "POST", searchPath(), { query: "SELECT campaign.id FROM campaign" }, HEADERS);
    const kept = await store.list<{ seq: number }>("ads:call:do@fake.test:");
    expect(kept).toHaveLength(200);
    expect(kept.at(-1)?.[1].seq).toBe(205);
    expect(kept[0]?.[1].seq).toBe(6);
  });
});

describe("fixtures", () => {
  it("are what the fake serves for a seeded account, replayed in order", async () => {
    const { email, token } = await account([ADWORDS]);
    const steps: Array<[ReturnType<typeof parseFixture>, unknown?]> = [
      [parseFixture(customersListAccessible)],
      [parseFixture(searchCampaigns), { query: "SELECT campaign.id, campaign.name, campaign.status, metrics.clicks FROM campaign ORDER BY campaign.id" }],
      [parseFixture(searchAdGroups), { query: "SELECT ad_group.id, ad_group.name, campaign.name FROM ad_group ORDER BY ad_group.id" }],
      [parseFixture(searchKeywords), { query: "SELECT ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM keyword_view ORDER BY ad_group_criterion.criterion_id LIMIT 2" }],
      [parseFixture(campaignsMutate), { operations: [{ update: { resourceName: `customers/${STORE}/campaigns/333333333`, status: "ENABLED" }, updateMask: "status" }] }],
    ];
    for (const [fx, body] of steps) {
      expect(await replay(token, email, fx, body, HEADERS), fx.id).toEqual(fx.response.body);
    }
  });
});
