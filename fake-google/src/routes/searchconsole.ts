import { fakeKey, type JsonValue } from "../store";
import { DATE_RE, badRequest, forbidden, isObject, noContent, notFound, readJsonObject } from "./google-http";
import type { FakeContext, FakeRoute, SeedPresets } from "./index";

// ---------- model ----------

/** Stored at `searchconsole:site:<email>:<siteUrl>`: the property exactly as the API lists it. */
interface SiteRecord {
  [key: string]: JsonValue;
  siteUrl: string;
  permissionLevel: string;
}

/** Stored at `searchconsole:sitemap:<email>:<siteUrl>|<feedpath>`: the sitemap as the API returns it. */
interface SitemapRecord {
  [key: string]: JsonValue;
  path: string;
  type: string;
  isPending: boolean;
  isSitemapsIndex: boolean;
  lastSubmitted: string;
  warnings: string;
  errors: string;
}

const siteKey = (email: string, siteUrl: string) => fakeKey("searchconsole", "site", email, siteUrl);
const sitemapPrefix = (email: string, siteUrl: string) => `searchconsole:sitemap:${email}:${siteUrl}|`;
const sitemapKey = (email: string, siteUrl: string, feed: string) => `${sitemapPrefix(email, siteUrl)}${feed}`;

const decoded = (ctx: FakeContext, group: number) => decodeURIComponent(ctx.match[group] ?? "");

// ---------- errors ----------

const noSite = (siteUrl: string) =>
  forbidden(`User does not have sufficient permission for site '${siteUrl}'. See also: https://support.google.com/webmasters/answer/2451999.`);

const isHttpUrl = (value: string): boolean => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

async function siteOr403(ctx: FakeContext, siteUrl: string): Promise<SiteRecord | Response> {
  return (await ctx.store.get<SiteRecord>(siteKey(ctx.email, siteUrl))) ?? noSite(siteUrl);
}

// ---------- sites ----------

async function listSites(ctx: FakeContext): Promise<Response> {
  const sites = (await ctx.store.list<SiteRecord>(`searchconsole:site:${ctx.email}:`)).map(([, s]) => s);
  return Response.json(sites.length > 0 ? { siteEntry: sites } : {});
}

async function getSite(ctx: FakeContext): Promise<Response> {
  const site = await siteOr403(ctx, decoded(ctx, 1));
  return site instanceof Response ? site : Response.json(site);
}

// ---------- sitemaps ----------

/** Google refuses `sitemapIndex`-scoped listings here: the fake does not model sitemap indexes. */
async function listSitemaps(ctx: FakeContext): Promise<Response> {
  const siteUrl = decoded(ctx, 1);
  const site = await siteOr403(ctx, siteUrl);
  if (site instanceof Response) return site;
  if (ctx.url.searchParams.has("sitemapIndex")) return badRequest("The fake does not support the sitemapIndex option.");
  const sitemaps = (await ctx.store.list<SitemapRecord>(sitemapPrefix(ctx.email, siteUrl))).map(([, s]) => s);
  return Response.json(sitemaps.length > 0 ? { sitemap: sitemaps } : {});
}

async function getSitemap(ctx: FakeContext): Promise<Response> {
  const siteUrl = decoded(ctx, 1);
  const site = await siteOr403(ctx, siteUrl);
  if (site instanceof Response) return site;
  const feed = decoded(ctx, 2);
  const rec = await ctx.store.get<SitemapRecord>(sitemapKey(ctx.email, siteUrl, feed));
  return rec ? Response.json(rec) : notFound(`Sitemap not found: ${feed}`);
}

/** Submitting registers the sitemap as pending; submitting it again refreshes `lastSubmitted`. Google answers 204. */
async function submitSitemap(ctx: FakeContext): Promise<Response> {
  const siteUrl = decoded(ctx, 1);
  const site = await siteOr403(ctx, siteUrl);
  if (site instanceof Response) return site;
  const feed = decoded(ctx, 2);
  if (!isHttpUrl(feed)) return badRequest(`Invalid sitemap URL: ${feed}`);
  const key = sitemapKey(ctx.email, siteUrl, feed);
  const existing = await ctx.store.get<SitemapRecord>(key);
  const rec: SitemapRecord = {
    ...(existing ?? { type: "SITEMAP", isSitemapsIndex: false, warnings: "0", errors: "0" }),
    path: feed,
    isPending: true,
    lastSubmitted: new Date(ctx.now()).toISOString(),
  };
  await ctx.store.put(key, rec);
  return noContent();
}

async function deleteSitemap(ctx: FakeContext): Promise<Response> {
  const siteUrl = decoded(ctx, 1);
  const site = await siteOr403(ctx, siteUrl);
  if (site instanceof Response) return site;
  const feed = decoded(ctx, 2);
  return (await ctx.store.delete(sitemapKey(ctx.email, siteUrl, feed))) ? noContent() : notFound(`Sitemap not found: ${feed}`);
}

// ---------- search analytics ----------

/** Canned daily facts: each query ranks one page. Every property of the account serves the same data. */
const QUERIES = [
  { query: "example widgets", page: "https://example.test/", base: 6, position: 2.1 },
  { query: "widget pricing", page: "https://example.test/pricing", base: 5, position: 3.4 },
  { query: "buy widgets", page: "https://example.test/pricing", base: 3, position: 5.8 },
  { query: "launch notes", page: "https://example.test/blog/launch", base: 2, position: 7.2 },
];
const FIRST_DAY = Date.UTC(2026, 10, 1);
const DAYS = 7;

interface Fact {
  query: string;
  page: string;
  date: string;
  clicks: number;
  impressions: number;
  /** Position times impressions, so that sums average correctly. */
  weightedPosition: number;
}

function facts(): Fact[] {
  const out: Fact[] = [];
  for (const [i, q] of QUERIES.entries()) {
    for (let d = 0; d < DAYS; d++) {
      const clicks = q.base + (d % 3);
      const impressions = clicks * (18 + i * 4) + 20;
      out.push({
        query: q.query,
        page: q.page,
        date: new Date(FIRST_DAY + d * 86_400_000).toISOString().slice(0, 10),
        clicks,
        impressions,
        weightedPosition: (q.position + (d % 2) * 0.3) * impressions,
      });
    }
  }
  return out;
}

const DIMENSIONS = ["query", "page", "date"] as const;
type Dimension = (typeof DIMENSIONS)[number];
const isDimension = (v: unknown): v is Dimension => (DIMENSIONS as readonly unknown[]).includes(v);
const FILTERABLE = new Set<string>(["query", "page"]);

type Predicate = (fact: Fact) => boolean;

function filterPredicate(f: Record<string, unknown>): Predicate | string {
  const dimension = f.dimension;
  if (typeof dimension !== "string" || !FILTERABLE.has(dimension)) return "Filters can use the query or page dimension only.";
  if (typeof f.expression !== "string") return "Every filter needs an expression.";
  const operator = f.operator ?? "equals";
  const expression = f.expression;
  const value = (fact: Fact) => (dimension === "query" ? fact.query : fact.page);
  const lower = expression.toLowerCase();
  switch (operator) {
    case "equals":
      return (fact) => value(fact) === expression;
    case "notEquals":
      return (fact) => value(fact) !== expression;
    case "contains":
      return (fact) => value(fact).toLowerCase().includes(lower);
    case "notContains":
      return (fact) => !value(fact).toLowerCase().includes(lower);
    case "includingRegex":
    case "excludingRegex": {
      let re: RegExp;
      try {
        re = new RegExp(expression);
      } catch {
        return `Invalid regular expression: ${expression}`;
      }
      return operator === "includingRegex" ? (fact) => re.test(value(fact)) : (fact) => !re.test(value(fact));
    }
    default:
      return `Unsupported filter operator: ${String(operator)}`;
  }
}

function parseFilters(groups: unknown): Predicate[] | string {
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) return "dimensionFilterGroups must be a list.";
  const out: Predicate[] = [];
  for (const g of groups) {
    if (!isObject(g) || !Array.isArray(g.filters)) return "Every filter group needs a list of filters.";
    if (g.groupType !== undefined && g.groupType !== "and") return "Only groupType 'and' is supported.";
    for (const f of g.filters) {
      const p = isObject(f) ? filterPredicate(f) : "Every filter must be an object.";
      if (typeof p === "string") return p;
      out.push(p);
    }
  }
  return out;
}

const validDate = (s: unknown): s is string => typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(s));

async function queryAnalytics(ctx: FakeContext): Promise<Response> {
  const site = await siteOr403(ctx, decoded(ctx, 1));
  if (site instanceof Response) return site;
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  if (!validDate(body.startDate) || !validDate(body.endDate)) return badRequest("startDate and endDate are required, as YYYY-MM-DD.");
  if (body.startDate > body.endDate) return badRequest("The start date must not be after the end date.");
  const dims = body.dimensions ?? [];
  if (!Array.isArray(dims) || !dims.every(isDimension)) return badRequest(`dimensions can be ${DIMENSIONS.join(", ")}.`);
  const searchType = body.searchType ?? body.type;
  if (searchType !== undefined && searchType !== "WEB") return badRequest("The fake supports the WEB search type only.");
  if (body.aggregationType !== undefined && body.aggregationType !== "AUTO") return badRequest("The fake supports automatic aggregation only.");
  const limit = body.rowLimit === undefined ? 1000 : body.rowLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 25000) return badRequest("rowLimit must be between 1 and 25000.");
  const start = body.startRow === undefined ? 0 : body.startRow;
  if (typeof start !== "number" || !Number.isInteger(start) || start < 0) return badRequest("startRow must be zero or more.");
  const filters = parseFilters(body.dimensionFilterGroups);
  if (typeof filters === "string") return badRequest(filters);

  const startDate = body.startDate;
  const endDate = body.endDate;
  const groups = new Map<string, { keys: string[]; clicks: number; impressions: number; weighted: number }>();
  for (const fact of facts()) {
    if (fact.date < startDate || fact.date > endDate || !filters.every((p) => p(fact))) continue;
    const keys = dims.map((d) => fact[d]);
    const id = JSON.stringify(keys);
    const g = groups.get(id) ?? { keys, clicks: 0, impressions: 0, weighted: 0 };
    g.clicks += fact.clicks;
    g.impressions += fact.impressions;
    g.weighted += fact.weightedPosition;
    groups.set(id, g);
  }

  const dateAt = dims.indexOf("date");
  const ordered = [...groups.values()].sort((a, b) => {
    if (dateAt >= 0) return (a.keys[dateAt] ?? "").localeCompare(b.keys[dateAt] ?? "");
    return b.clicks - a.clicks || b.impressions - a.impressions || a.keys.join("\n").localeCompare(b.keys.join("\n"));
  });
  const rows = ordered.slice(start, start + limit).map((g) => ({
    ...(dims.length > 0 ? { keys: g.keys } : {}),
    clicks: g.clicks,
    impressions: g.impressions,
    ctr: g.clicks / g.impressions,
    position: g.weighted / g.impressions,
  }));
  return Response.json(rows.length > 0 ? { rows } : {});
}

// ---------- url inspection ----------

const OUTSIDE = "You do not own this site, or the inspected URL is not part of this property.";

function inProperty(siteUrl: string, inspected: URL): boolean {
  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length);
    return inspected.hostname === domain || inspected.hostname.endsWith(`.${domain}`);
  }
  return inspected.href.startsWith(siteUrl);
}

async function inspectUrl(ctx: FakeContext): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  const { inspectionUrl, siteUrl } = body;
  if (typeof inspectionUrl !== "string" || typeof siteUrl !== "string" || inspectionUrl === "" || siteUrl === "") {
    return badRequest("inspectionUrl and siteUrl are required.");
  }
  if (!isHttpUrl(inspectionUrl)) return badRequest("inspectionUrl must be an absolute http(s) URL.");
  const site = await siteOr403(ctx, siteUrl);
  if (site instanceof Response) return forbidden(OUTSIDE);
  const inspected = new URL(inspectionUrl);
  if (!inProperty(siteUrl, inspected)) return forbidden(OUTSIDE);

  const indexed = !inspected.pathname.startsWith("/draft");
  const sitemaps = (await ctx.store.list<SitemapRecord>(sitemapPrefix(ctx.email, siteUrl))).map(([, s]) => s.path);
  const status: Record<string, JsonValue> = indexed
    ? {
        verdict: "PASS",
        coverageState: "Submitted and indexed",
        robotsTxtState: "ALLOWED",
        indexingState: "INDEXING_ALLOWED",
        lastCrawlTime: "2026-11-08T21:14:09Z",
        pageFetchState: "SUCCESSFUL",
        googleCanonical: inspectionUrl,
        userCanonical: inspectionUrl,
        crawledAs: "MOBILE",
        ...(sitemaps.length > 0 ? { sitemap: sitemaps } : {}),
      }
    : {
        verdict: "NEUTRAL",
        coverageState: "Discovered - currently not indexed",
        robotsTxtState: "ALLOWED",
        indexingState: "INDEXING_ALLOWED",
        pageFetchState: "PAGE_FETCH_STATE_UNSPECIFIED",
      };
  return Response.json({
    inspectionResult: {
      inspectionResultLink: `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(siteUrl)}&id=${encodeURIComponent(inspectionUrl)}`,
      indexStatusResult: status,
    },
  });
}

// ---------- routes ----------

const G = "https://www.googleapis.com/auth/";
const HOST = "^/searchconsole\\.googleapis\\.com";
const SITES = `${HOST}/webmasters/v3/sites`;

/** Scopes per route: the Discovery `scopes` of the method (checked against the generated SDK in tests). */
const SCOPES = {
  write: [`${G}webmasters`],
  read: [`${G}webmasters`, `${G}webmasters.readonly`],
};

export const routes: FakeRoute[] = [
  { method: "GET", pattern: new RegExp(`${SITES}$`), scopes: SCOPES.read, handle: listSites },
  { method: "GET", pattern: new RegExp(`${SITES}/([^/]+)$`), scopes: SCOPES.read, handle: getSite },
  { method: "GET", pattern: new RegExp(`${SITES}/([^/]+)/sitemaps$`), scopes: SCOPES.read, handle: listSitemaps },
  { method: "GET", pattern: new RegExp(`${SITES}/([^/]+)/sitemaps/([^/]+)$`), scopes: SCOPES.read, handle: getSitemap },
  { method: "PUT", pattern: new RegExp(`${SITES}/([^/]+)/sitemaps/([^/]+)$`), scopes: SCOPES.write, handle: submitSitemap },
  { method: "DELETE", pattern: new RegExp(`${SITES}/([^/]+)/sitemaps/([^/]+)$`), scopes: SCOPES.write, handle: deleteSitemap },
  { method: "POST", pattern: new RegExp(`${SITES}/([^/]+)/searchAnalytics/query$`), scopes: SCOPES.read, handle: queryAnalytics },
  { method: "POST", pattern: new RegExp(`${HOST}/v1/urlInspection/index:inspect$`), scopes: SCOPES.read, handle: inspectUrl },
];

// ---------- seed preset ----------

/** Two verified properties (a URL prefix and a domain) and one submitted sitemap on the URL prefix. */
export const presets: SeedPresets = {
  default: [
    { key: `searchconsole:site:{email}:https://example.test/`, value: { siteUrl: "https://example.test/", permissionLevel: "SITE_OWNER" } },
    { key: `searchconsole:site:{email}:sc-domain:example.test`, value: { siteUrl: "sc-domain:example.test", permissionLevel: "SITE_OWNER" } },
    {
      key: `searchconsole:sitemap:{email}:https://example.test/|https://example.test/sitemap.xml`,
      value: {
        path: "https://example.test/sitemap.xml",
        type: "SITEMAP",
        isPending: false,
        isSitemapsIndex: false,
        lastSubmitted: "2026-11-01T02:00:00.000Z",
        lastDownloaded: "2026-11-08T05:30:00.000Z",
        warnings: "0",
        errors: "0",
        contents: [{ type: "WEB", submitted: "120", indexed: "96" }],
      },
    },
  ],
};
