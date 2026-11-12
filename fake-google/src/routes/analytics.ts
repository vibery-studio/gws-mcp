import { fakeKey, type JsonValue } from "../store";
import { DATE_RE, badRequest, forbidden, isObject, notFound, paginate, randomDigits, readJsonObject } from "./google-http";
import type { FakeContext, FakeRoute, SeedPresets } from "./index";

// ---------- admin model ----------

interface AccountRecord {
  [key: string]: JsonValue;
  name: string;
  displayName: string;
  regionCode: string;
  createTime: string;
  updateTime: string;
}

/** `parent` is `accounts/<id>`; the rest is returned as stored. */
interface PropertyRecord {
  [key: string]: JsonValue;
  name: string;
  parent: string;
}

interface DataStreamRecord {
  [key: string]: JsonValue;
  name: string;
  type: string;
  displayName: string;
  createTime: string;
  updateTime: string;
}

const accountPrefix = (email: string) => `analyticsadmin:account:${email}:`;
const propertyPrefix = (email: string) => `analyticsadmin:property:${email}:`;
const propertyKey = (email: string, id: string) => fakeKey("analyticsadmin", "property", email, id);
const streamPrefix = (email: string, propertyId: string) => `analyticsadmin:datastream:${email}:${propertyId}/`;
const streamKey = (email: string, propertyId: string, streamId: string) => `${streamPrefix(email, propertyId)}${streamId}`;

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

const noProperty = (id: string) => forbidden(`User does not have sufficient permissions for this property: properties/${id}.`);

async function propertyOr403(ctx: FakeContext, id: string): Promise<PropertyRecord | Response> {
  return (await ctx.store.get<PropertyRecord>(propertyKey(ctx.email, id))) ?? noProperty(id);
}

function pageOf<T>(ctx: FakeContext, all: T[], field: string): Response {
  const paged = paginate(all, ctx.url.searchParams, "pageSize", PAGE_DEFAULT, PAGE_MAX);
  if ("error" in paged) return badRequest(paged.error);
  const body: Record<string, JsonValue> = {};
  if (paged.page.length > 0) body[field] = paged.page as JsonValue;
  if (paged.nextPageToken) body.nextPageToken = paged.nextPageToken;
  return Response.json(body);
}

// ---------- admin handlers ----------

async function listAccounts(ctx: FakeContext): Promise<Response> {
  const all = (await ctx.store.list<AccountRecord>(accountPrefix(ctx.email))).map(([, a]) => a);
  return pageOf(ctx, all, "accounts");
}

/** Google requires a filter; the fake understands `parent:accounts/<id>`. */
async function listProperties(ctx: FakeContext): Promise<Response> {
  const m = /^\s*parent:(accounts\/\d+)\s*$/.exec(ctx.url.searchParams.get("filter") ?? "");
  if (!m) return badRequest("filter is required and must be of the form parent:accounts/<id>.");
  const all = (await ctx.store.list<PropertyRecord>(propertyPrefix(ctx.email))).map(([, p]) => p).filter((p) => p.parent === m[1]);
  return pageOf(ctx, all, "properties");
}

/** One summary per account, listing its properties: how a client finds every property it can report on. */
async function listAccountSummaries(ctx: FakeContext): Promise<Response> {
  const accounts = (await ctx.store.list<AccountRecord>(accountPrefix(ctx.email))).map(([, a]) => a);
  const properties = (await ctx.store.list<PropertyRecord>(propertyPrefix(ctx.email))).map(([, p]) => p);
  const all = accounts.map((a) => ({
    name: `accountSummaries/${a.name.slice("accounts/".length)}`,
    account: a.name,
    displayName: a.displayName,
    propertySummaries: properties
      .filter((p) => p.parent === a.name)
      .map((p) => ({ property: p.name, displayName: p.displayName, propertyType: p.propertyType, parent: p.parent })),
  }));
  return pageOf(ctx, all, "accountSummaries");
}

async function listStreams(ctx: FakeContext): Promise<Response> {
  const id = ctx.match[1] ?? "";
  const property = await propertyOr403(ctx, id);
  if (property instanceof Response) return property;
  const all = (await ctx.store.list<DataStreamRecord>(streamPrefix(ctx.email, id)))
    .map(([, s]) => s)
    .sort((a, b) => a.createTime.localeCompare(b.createTime) || a.name.localeCompare(b.name));
  return pageOf(ctx, all, "dataStreams");
}

const MEASUREMENT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const measurementId = () => `G-${Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => MEASUREMENT_CHARS[b % MEASUREMENT_CHARS.length]).join("")}`;

const isHttpUrl = (v: unknown): v is string => {
  try {
    return typeof v === "string" && ["http:", "https:"].includes(new URL(v).protocol);
  } catch {
    return false;
  }
};

/** Only web streams are modelled: they are the only ones with a website URL and a measurement id. */
async function createStream(ctx: FakeContext): Promise<Response> {
  const propertyId = ctx.match[1] ?? "";
  const property = await propertyOr403(ctx, propertyId);
  if (property instanceof Response) return property;
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  if (body.type !== "WEB_DATA_STREAM") return badRequest("The fake supports WEB_DATA_STREAM streams only.");
  if (typeof body.displayName !== "string" || body.displayName === "" || body.displayName.length > 255) {
    return badRequest("displayName is required (at most 255 characters).");
  }
  const web = body.webStreamData;
  if (!isObject(web) || !isHttpUrl(web.defaultUri)) return badRequest("webStreamData.defaultUri must be an absolute http(s) URL.");

  const streamId = randomDigits(10);
  const now = new Date(ctx.now()).toISOString();
  const rec: DataStreamRecord = {
    name: `properties/${propertyId}/dataStreams/${streamId}`,
    type: "WEB_DATA_STREAM",
    webStreamData: { measurementId: measurementId(), defaultUri: web.defaultUri },
    createTime: now,
    updateTime: now,
    displayName: body.displayName,
  };
  await ctx.store.put(streamKey(ctx.email, propertyId, streamId), rec);
  return Response.json(rec);
}

async function deleteStream(ctx: FakeContext): Promise<Response> {
  const propertyId = ctx.match[1] ?? "";
  const property = await propertyOr403(ctx, propertyId);
  if (property instanceof Response) return property;
  const streamId = ctx.match[2] ?? "";
  return (await ctx.store.delete(streamKey(ctx.email, propertyId, streamId))) ? Response.json({}) : notFound(`Data stream not found: ${streamId}`);
}

// ---------- reporting engine ----------

type Fact = Record<string, string | number>;

interface Table {
  /** Dimension values are strings; metric values are numbers. `_date` (YYYY-MM-DD) marks historical facts. */
  facts: Fact[];
  dimensions: Record<string, { uiName: string; description: string; category: string }>;
  metrics: Record<string, { uiName: string; description: string; category: string }>;
  kind: string;
}

const PAGES = ["/", "/pricing", "/blog/launch"];
const COUNTRIES = ["Vietnam", "United States"];
const DEVICES = ["desktop", "mobile"];
const FIRST_DAY = Date.UTC(2026, 10, 1);
const DAYS = 7;

/** Historical traffic: pages x countries x devices x days. Sums over any dimension agree. */
function historicalFacts(): Fact[] {
  const out: Fact[] = [];
  for (let d = 0; d < DAYS; d++) {
    const iso = new Date(FIRST_DAY + d * 86_400_000).toISOString().slice(0, 10);
    for (const [pi, pagePath] of PAGES.entries()) {
      for (const [ci, country] of COUNTRIES.entries()) {
        for (const [di, deviceCategory] of DEVICES.entries()) {
          const sessions = 10 + pi * 3 + ci * 5 + di * 2 + (d % 4);
          out.push({
            _date: iso,
            date: iso.replaceAll("-", ""),
            pagePath,
            country,
            deviceCategory,
            sessions,
            activeUsers: sessions - 3 - (d % 2),
            screenPageViews: sessions * 2 + pi,
            eventCount: sessions * 5 + d,
          });
        }
      }
    }
  }
  return out;
}

const REALTIME_FACTS: Fact[] = [
  { country: "Vietnam", city: "Ho Chi Minh City", deviceCategory: "mobile", activeUsers: 4, screenPageViews: 9, eventCount: 31 },
  { country: "Vietnam", city: "Hanoi", deviceCategory: "desktop", activeUsers: 2, screenPageViews: 5, eventCount: 17 },
  { country: "United States", city: "Seattle", deviceCategory: "desktop", activeUsers: 1, screenPageViews: 2, eventCount: 8 },
];

const info = (uiName: string, category: string, description: string) => ({ uiName, category, description });

const METRICS = {
  activeUsers: info("Active users", "User", "The number of distinct users who visited your site or app."),
  sessions: info("Sessions", "Session", "The number of sessions that began on your site or app."),
  screenPageViews: info("Views", "Page / screen", "The number of app screens or web pages your users viewed."),
  eventCount: info("Event count", "Event", "The count of events."),
};

const HISTORICAL: Table = {
  facts: historicalFacts(),
  dimensions: {
    date: info("Date", "Time", "The date of the event, formatted as YYYYMMDD."),
    pagePath: info("Page path", "Page / screen", "The portion of the URL between the hostname and the query string."),
    country: info("Country", "Geography", "The country from which the user activity originated."),
    deviceCategory: info("Device category", "Platform / device", "The type of device: desktop, tablet, or mobile."),
  },
  metrics: METRICS,
  kind: "analyticsData#runReport",
};

const REALTIME: Table = {
  facts: REALTIME_FACTS,
  dimensions: {
    country: HISTORICAL.dimensions.country as Table["dimensions"][string],
    city: info("City", "Geography", "The city from which the user activity originated."),
    deviceCategory: HISTORICAL.dimensions.deviceCategory as Table["dimensions"][string],
  },
  metrics: METRICS,
  kind: "analyticsData#runRealtimeReport",
};

const QUOTA = {
  tokensPerDay: { consumed: 1, remaining: 199_999 },
  tokensPerHour: { consumed: 1, remaining: 39_999 },
  concurrentRequests: { consumed: 0, remaining: 10 },
  serverErrorsPerProjectPerHour: { consumed: 0, remaining: 10 },
  potentiallyThresholdedRequestsPerHour: { consumed: 0, remaining: 120 },
  tokensPerProjectPerHour: { consumed: 1, remaining: 13_999 },
};

const UNSUPPORTED = ["dimensionFilter", "metricFilter", "cohortSpec", "comparisons", "metricAggregations", "keepEmptyRows", "currencyCode"];
const DEFAULT_LIMIT = 10_000;
const MAX_LIMIT = 250_000;

interface Range {
  from: string;
  to: string;
}

/** `YYYY-MM-DD`, `today`, `yesterday` or `NdaysAgo`, against the account clock. */
function resolveDate(value: unknown, now: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const day = (offset: number) => new Date(now - offset * 86_400_000).toISOString().slice(0, 10);
  if (value === "today") return day(0);
  if (value === "yesterday") return day(1);
  const ago = /^(\d{1,4})daysAgo$/.exec(value);
  if (ago) return day(Number(ago[1]));
  return DATE_RE.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function parseRanges(raw: unknown, now: number): Range[] | string {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return "dateRanges must list between 1 and 4 date ranges.";
  const out: Range[] = [];
  for (const r of raw) {
    const from = isObject(r) ? resolveDate(r.startDate, now) : undefined;
    const to = isObject(r) ? resolveDate(r.endDate, now) : undefined;
    if (!from || !to) return "Every date range needs a startDate and endDate (YYYY-MM-DD, today, yesterday or NdaysAgo).";
    if (from > to) return "A date range must not start after it ends.";
    out.push({ from, to });
  }
  return out;
}

function names(raw: unknown, what: string, allowed: Record<string, unknown>): string[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return `${what}s must be a list.`;
  const out: string[] = [];
  for (const item of raw) {
    const name = isObject(item) ? item.name : undefined;
    if (typeof name !== "string" || !(name in allowed)) return `Field ${typeof name === "string" ? name : JSON.stringify(item)} is not a valid ${what}.`;
    out.push(name);
  }
  return out;
}

interface Order {
  kind: "metric" | "dimension";
  name: string;
  desc: boolean;
}

function parseOrders(raw: unknown, dims: string[], metrics: string[]): Order[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "orderBys must be a list.";
  const out: Order[] = [];
  for (const o of raw) {
    if (!isObject(o)) return "Every orderBy must be an object.";
    const metric = isObject(o.metric) ? o.metric.metricName : undefined;
    const dimension = isObject(o.dimension) ? o.dimension.dimensionName : undefined;
    if (typeof metric === "string" && metrics.includes(metric)) out.push({ kind: "metric", name: metric, desc: o.desc === true });
    else if (typeof dimension === "string" && dims.includes(dimension)) out.push({ kind: "dimension", name: dimension, desc: o.desc === true });
    else return "An orderBy must name a metric or dimension of the report.";
  }
  return out;
}

function parseCount(raw: unknown, fallback: number, min: number, max: number, what: string): number | string {
  if (raw === undefined) return fallback;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : `${what} must be between ${min} and ${max}.`;
}

/**
 * One report over `table`. Rows group by the requested dimensions (plus a `dateRange` dimension when several
 * ranges are asked) and sum the metrics. Without orderBys the rows sort by dimension values, ascending.
 */
function report(table: Table, body: Record<string, unknown>, now: number, returnQuota: boolean): Record<string, JsonValue> | string {
  for (const k of UNSUPPORTED) if (body[k] !== undefined && !(Array.isArray(body[k]) && (body[k] as unknown[]).length === 0)) return `The fake does not support ${k}.`;
  const dims = names(body.dimensions, "dimension", table.dimensions);
  if (typeof dims === "string") return dims;
  const metrics = names(body.metrics, "metric", table.metrics);
  if (typeof metrics === "string") return metrics;
  if (metrics.length === 0) return "At least one metric is required.";
  const historical = table === HISTORICAL;
  const ranges = historical ? parseRanges(body.dateRanges, now) : [];
  if (typeof ranges === "string") return ranges;
  const orders = parseOrders(body.orderBys, dims, metrics);
  if (typeof orders === "string") return orders;
  const limit = parseCount(body.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, "limit");
  if (typeof limit === "string") return limit;
  const offset = parseCount(body.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
  if (typeof offset === "string") return offset;

  const multi = ranges.length > 1;
  const groups = new Map<string, { keys: string[]; sums: number[] }>();
  const scopes = historical ? ranges.map((r, i) => ({ i, test: (f: Fact) => String(f._date) >= r.from && String(f._date) <= r.to })) : [{ i: 0, test: () => true }];
  for (const scope of scopes) {
    for (const fact of table.facts) {
      if (!scope.test(fact)) continue;
      const keys = [...dims.map((d) => String(fact[d])), ...(multi ? [`date_range_${scope.i}`] : [])];
      const id = JSON.stringify(keys);
      const g = groups.get(id) ?? { keys, sums: metrics.map(() => 0) };
      metrics.forEach((m, i) => {
        g.sums[i] = (g.sums[i] ?? 0) + Number(fact[m]);
      });
      groups.set(id, g);
    }
  }

  const byKeys = (a: { keys: string[] }, b: { keys: string[] }) => {
    for (let i = 0; i < a.keys.length; i++) {
      const c = (a.keys[i] ?? "").localeCompare(b.keys[i] ?? "");
      if (c !== 0) return c;
    }
    return 0;
  };
  const sorted = [...groups.values()].sort((a, b) => {
    for (const o of orders) {
      const c = o.kind === "metric" ? (a.sums[metrics.indexOf(o.name)] ?? 0) - (b.sums[metrics.indexOf(o.name)] ?? 0) : (a.keys[dims.indexOf(o.name)] ?? "").localeCompare(b.keys[dims.indexOf(o.name)] ?? "");
      if (c !== 0) return o.desc ? -c : c;
    }
    return byKeys(a, b);
  });

  const out: Record<string, JsonValue> = {
    dimensionHeaders: [...dims, ...(multi ? ["dateRange"] : [])].map((name) => ({ name })),
    metricHeaders: metrics.map((name) => ({ name, type: "TYPE_INTEGER" })),
  };
  const rows = sorted.slice(offset, offset + limit).map((g) => ({
    dimensionValues: g.keys.map((value) => ({ value })),
    metricValues: g.sums.map((s) => ({ value: String(s) })),
  }));
  if (rows.length > 0) out.rows = rows;
  out.rowCount = sorted.length;
  out.metadata = { currencyCode: "USD", timeZone: "Asia/Saigon" };
  if (returnQuota || body.returnPropertyQuota === true) out.propertyQuota = QUOTA;
  out.kind = table.kind;
  return out;
}

// ---------- data handlers ----------

const propertyIdOf = (ctx: FakeContext) => ctx.match[1] ?? "";

async function runReport(ctx: FakeContext): Promise<Response> {
  const property = await propertyOr403(ctx, propertyIdOf(ctx));
  if (property instanceof Response) return property;
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  const out = report(HISTORICAL, body, ctx.now(), false);
  return typeof out === "string" ? badRequest(out) : Response.json(out);
}

async function batchRunReports(ctx: FakeContext): Promise<Response> {
  const id = propertyIdOf(ctx);
  const property = await propertyOr403(ctx, id);
  if (property instanceof Response) return property;
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  const requests = body.requests;
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 5) return badRequest("requests must list between 1 and 5 reports.");
  const reports: JsonValue[] = [];
  for (const [i, r] of requests.entries()) {
    if (!isObject(r)) return badRequest(`requests[${i}] must be an object.`);
    if (r.property !== undefined && r.property !== `properties/${id}`) return badRequest(`requests[${i}].property must match the property in the path.`);
    const out = report(HISTORICAL, r, ctx.now(), false);
    if (typeof out === "string") return badRequest(`requests[${i}]: ${out}`);
    reports.push(out);
  }
  return Response.json({ reports, kind: "analyticsData#batchRunReports" });
}

async function runRealtimeReport(ctx: FakeContext): Promise<Response> {
  const property = await propertyOr403(ctx, propertyIdOf(ctx));
  if (property instanceof Response) return property;
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  const out = report(REALTIME, body, ctx.now(), false);
  return typeof out === "string" ? badRequest(out) : Response.json(out);
}

/** `properties/0` stands for the property-independent list, as in Google. */
async function getMetadata(ctx: FakeContext): Promise<Response> {
  const id = propertyIdOf(ctx);
  if (id !== "0") {
    const property = await propertyOr403(ctx, id);
    if (property instanceof Response) return property;
  }
  const entry = (apiName: string, v: { uiName: string; description: string; category: string }) => ({ apiName, ...v, customDefinition: false });
  return Response.json({
    name: `properties/${id}/metadata`,
    dimensions: Object.entries(HISTORICAL.dimensions).map(([n, v]) => entry(n, v)),
    metrics: Object.entries(METRICS).map(([n, v]) => ({ ...entry(n, v), type: "TYPE_INTEGER" })),
  });
}

// ---------- routes ----------

const G = "https://www.googleapis.com/auth/";
const DATA = "^/analyticsdata\\.googleapis\\.com/v1beta/properties";
const ADMIN = "^/analyticsadmin\\.googleapis\\.com/v1beta";

/** Scopes per route: the Discovery `scopes` of the method (checked against the generated SDK in tests). */
const SCOPES = {
  data: [`${G}analytics`, `${G}analytics.readonly`],
  adminRead: [`${G}analytics.edit`, `${G}analytics.readonly`],
  adminWrite: [`${G}analytics.edit`],
};

export const routes: FakeRoute[] = [
  { method: "POST", pattern: new RegExp(`${DATA}/([^/:]+):runReport$`), scopes: SCOPES.data, handle: runReport },
  { method: "POST", pattern: new RegExp(`${DATA}/([^/:]+):batchRunReports$`), scopes: SCOPES.data, handle: batchRunReports },
  { method: "POST", pattern: new RegExp(`${DATA}/([^/:]+):runRealtimeReport$`), scopes: SCOPES.data, handle: runRealtimeReport },
  { method: "GET", pattern: new RegExp(`${DATA}/([^/]+)/metadata$`), scopes: SCOPES.data, handle: getMetadata },
  { method: "GET", pattern: new RegExp(`${ADMIN}/accounts$`), scopes: SCOPES.adminRead, handle: listAccounts },
  { method: "GET", pattern: new RegExp(`${ADMIN}/accountSummaries$`), scopes: SCOPES.adminRead, handle: listAccountSummaries },
  { method: "GET", pattern: new RegExp(`${ADMIN}/properties$`), scopes: SCOPES.adminRead, handle: listProperties },
  { method: "GET", pattern: new RegExp(`${ADMIN}/properties/([^/]+)/dataStreams$`), scopes: SCOPES.adminRead, handle: listStreams },
  { method: "POST", pattern: new RegExp(`${ADMIN}/properties/([^/]+)/dataStreams$`), scopes: SCOPES.adminWrite, handle: createStream },
  { method: "DELETE", pattern: new RegExp(`${ADMIN}/properties/([^/]+)/dataStreams/([^/]+)$`), scopes: SCOPES.adminWrite, handle: deleteStream },
];

// ---------- seed preset ----------

const account = (id: string, displayName: string, regionCode: string) => ({
  key: `analyticsadmin:account:{email}:${id}`,
  value: { name: `accounts/${id}`, displayName, regionCode, createTime: "2026-09-01T00:00:00.000Z", updateTime: "2026-09-01T00:00:00.000Z" },
});

const property = (id: string, parent: string, displayName: string) => ({
  key: `analyticsadmin:property:{email}:${id}`,
  value: {
    name: `properties/${id}`,
    parent: `accounts/${parent}`,
    displayName,
    industryCategory: "TECHNOLOGY",
    timeZone: "Asia/Saigon",
    currencyCode: "USD",
    serviceLevel: "GOOGLE_ANALYTICS_STANDARD",
    propertyType: "PROPERTY_TYPE_ORDINARY",
    createTime: "2026-09-01T00:00:00.000Z",
    updateTime: "2026-09-01T00:00:00.000Z",
  },
});

/** Two accounts with one property each (ids `2001` and `2002`); `2001` has one web stream and the report data. */
export const presets: SeedPresets = {
  default: [
    account("1001", "Example Co", "VN"),
    account("1002", "Example Labs", "US"),
    property("2001", "1001", "Example site"),
    property("2002", "1002", "Example app"),
    {
      key: "analyticsadmin:datastream:{email}:2001/3001",
      value: {
        name: "properties/2001/dataStreams/3001",
        type: "WEB_DATA_STREAM",
        displayName: "Example web",
        webStreamData: { measurementId: "G-FAKE000001", defaultUri: "https://example.test" },
        createTime: "2026-09-01T00:00:00.000Z",
        updateTime: "2026-09-01T00:00:00.000Z",
      },
    },
  ],
};
