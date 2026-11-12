import { z } from "zod";
import type { CallCtx, FnDef } from "../../contracts";
import { GwsError } from "../../errors";

const DAY_MS = 86_400_000;
/** Search Console data is complete up to about three days ago; newer days are partial. */
const DATA_LAG_DAYS = 3;
const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

const SiteUrl = z.string().min(1).max(2048);

const QueryInput = z.strictObject({
  account: z.string().min(1).max(320).optional(),
  siteUrl: SiteUrl,
  days: z.number().int().min(1).max(480).default(28),
  limit: z.number().int().min(1).max(1000).default(25),
});
type QueryInput = z.output<typeof QueryInput>;

const Metrics = { clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() };

const QueryOutput = z.strictObject({
  siteUrl: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  rows: z.array(z.strictObject({ query: z.string(), ...Metrics })),
});
const PageOutput = z.strictObject({
  siteUrl: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  rows: z.array(z.strictObject({ page: z.string(), ...Metrics })),
});

const SearchResponse = z.looseObject({
  rows: z
    .array(z.looseObject({ keys: z.array(z.string()).optional(), clicks: z.number().optional(), impressions: z.number().optional(), ctr: z.number().optional(), position: z.number().optional() }))
    .optional(),
});

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The `days` complete days that end DATA_LAG_DAYS before `now`, as inclusive YYYY-MM-DD dates. */
export function reportWindow(now: number, days: number): { startDate: string; endDate: string } {
  const end = now - DATA_LAG_DAYS * DAY_MS;
  return { startDate: isoDay(end - (days - 1) * DAY_MS), endDate: isoDay(end) };
}

async function top(dimension: "query" | "page", input: QueryInput, ctx: CallCtx) {
  const { siteUrl, days, limit, account } = input;
  const window = reportWindow(Date.now(), days);
  const raw = await ctx.call("webmasters.searchanalytics.query", {
    siteUrl,
    requestBody: { ...window, dimensions: [dimension], rowLimit: limit },
    ...(account === undefined ? {} : { account }),
  });
  const parsed = SearchResponse.safeParse(raw);
  if (!parsed.success) throw new GwsError("GWS_RESPONSE_SHAPE", "webmasters.searchanalytics.query returned an unexpected shape");
  const rows = (parsed.data.rows ?? []).map((r) => ({
    [dimension]: r.keys?.[0] ?? "",
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
  return { siteUrl, ...window, rows };
}

const queryDecl = (dimension: string) =>
  [
    "type Input = {",
    '  siteUrl: string; // the property exactly as listed by webmasters.sites.list, e.g. "https://example.com/" or "sc-domain:example.com"',
    "  days?: number; // 1-480, default 28; ends three days ago, when the data is complete",
    "  limit?: number; // 1-1000, default 25",
    "  account?: string;",
    "};",
    "type Output = {",
    "  siteUrl: string;",
    "  startDate: string; // YYYY-MM-DD, inclusive",
    "  endDate: string;",
    `  rows: { ${dimension}: string; clicks: number; impressions: number; ctr: number; position: number }[]; // most clicks first`,
    "};",
  ].join("\n");

const topQueriesDef: FnDef<QueryInput, z.output<typeof QueryOutput>> = {
  kind: "host",
  name: "searchconsole.topQueries",
  service: "helpers",
  effect: "read",
  description:
    "Top Google search queries of a Search Console property by clicks over the last days (SEO): clicks, impressions, click-through rate and average position per query. Ends three days ago, when the data is complete.",
  signature:
    "searchconsole.topQueries({ siteUrl: string, days?: number, limit?: number, account?: string }): Promise<{ siteUrl: string, startDate: string, endDate: string, rows: { query: string, clicks: number, impressions: number, ctr: number, position: number }[] }>",
  tsDecl: queryDecl("query"),
  example: 'await sdk.searchconsole.topQueries({ siteUrl: "https://example.com/", days: 28, limit: 25 })',
  tags: ["helpers", "searchconsole", "gsc", "seo", "search", "queries", "keywords", "clicks", "impressions", "ranking", "top", "read"],
  scopes: SCOPES,
  input: QueryInput,
  output: QueryOutput,
  run: (input, ctx) => top("query", input, ctx) as Promise<z.output<typeof QueryOutput>>,
};

const topPagesDef: FnDef<QueryInput, z.output<typeof PageOutput>> = {
  kind: "host",
  name: "searchconsole.topPages",
  service: "helpers",
  effect: "read",
  description:
    "Top pages of a Search Console property by clicks from Google search over the last days (SEO): clicks, impressions, click-through rate and average position per page URL. Ends three days ago, when the data is complete.",
  signature:
    "searchconsole.topPages({ siteUrl: string, days?: number, limit?: number, account?: string }): Promise<{ siteUrl: string, startDate: string, endDate: string, rows: { page: string, clicks: number, impressions: number, ctr: number, position: number }[] }>",
  tsDecl: queryDecl("page"),
  example: 'await sdk.searchconsole.topPages({ siteUrl: "https://example.com/", days: 28 })',
  tags: ["helpers", "searchconsole", "gsc", "seo", "search", "pages", "urls", "clicks", "impressions", "landing", "top", "read"],
  scopes: SCOPES,
  input: QueryInput,
  output: PageOutput,
  run: (input, ctx) => top("page", input, ctx) as Promise<z.output<typeof PageOutput>>,
};

const InspectInput = z.strictObject({
  account: z.string().min(1).max(320).optional(),
  siteUrl: SiteUrl,
  url: z.string().min(1).max(2048),
});
type InspectInput = z.output<typeof InspectInput>;

const InspectOutput = z.strictObject({
  url: z.string(),
  verdict: z.string().optional(),
  coverageState: z.string().optional(),
  indexingState: z.string().optional(),
  robotsTxtState: z.string().optional(),
  pageFetchState: z.string().optional(),
  lastCrawlTime: z.string().optional(),
  googleCanonical: z.string().optional(),
  userCanonical: z.string().optional(),
  crawledAs: z.string().optional(),
  link: z.string().optional(),
});
type InspectOutput = z.output<typeof InspectOutput>;

const InspectResponse = z.looseObject({
  inspectionResult: z
    .looseObject({
      inspectionResultLink: z.string().optional(),
      indexStatusResult: z
        .looseObject({
          verdict: z.string().optional(),
          coverageState: z.string().optional(),
          indexingState: z.string().optional(),
          robotsTxtState: z.string().optional(),
          pageFetchState: z.string().optional(),
          lastCrawlTime: z.string().optional(),
          googleCanonical: z.string().optional(),
          userCanonical: z.string().optional(),
          crawledAs: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

const inspectDef: FnDef<InspectInput, InspectOutput> = {
  kind: "host",
  name: "searchconsole.inspect",
  service: "helpers",
  effect: "read",
  description:
    "Checks whether Google has indexed one URL of a Search Console property (URL inspection): verdict, coverage state, robots.txt and fetch state, last crawl time and the canonical URLs. Google limits URL inspection to about 2000 inspections a day and 600 a minute per property, so inspect single URLs rather than whole sites.",
  signature:
    "searchconsole.inspect({ siteUrl: string, url: string, account?: string }): Promise<{ url: string, verdict?: string, coverageState?: string, indexingState?: string, robotsTxtState?: string, pageFetchState?: string, lastCrawlTime?: string, googleCanonical?: string, userCanonical?: string, crawledAs?: string, link?: string }>",
  tsDecl: [
    "type Input = {",
    "  siteUrl: string; // the property, as listed by webmasters.sites.list",
    "  url: string; // the page to inspect; it must belong to the property",
    "  account?: string;",
    "};",
    "type Output = {",
    "  url: string;",
    '  verdict?: string; // "PASS", "FAIL", "NEUTRAL" ...',
    '  coverageState?: string; // e.g. "Submitted and indexed"',
    "  indexingState?: string;",
    "  robotsTxtState?: string;",
    "  pageFetchState?: string;",
    "  lastCrawlTime?: string;",
    "  googleCanonical?: string;",
    "  userCanonical?: string;",
    "  crawledAs?: string;",
    "  link?: string; // the page in the Search Console UI",
    "};",
  ].join("\n"),
  example: 'await sdk.searchconsole.inspect({ siteUrl: "https://example.com/", url: "https://example.com/pricing" })',
  tags: ["helpers", "searchconsole", "gsc", "seo", "inspect", "inspection", "indexed", "index", "url", "crawl", "canonical", "read"],
  scopes: SCOPES,
  input: InspectInput,
  output: InspectOutput,
  async run(input, ctx) {
    const { siteUrl, url, account } = input;
    const raw = await ctx.call("searchconsole.urlInspection.index.inspect", {
      requestBody: { inspectionUrl: url, siteUrl },
      ...(account === undefined ? {} : { account }),
    });
    const parsed = InspectResponse.safeParse(raw);
    if (!parsed.success) throw new GwsError("GWS_RESPONSE_SHAPE", "searchconsole.urlInspection.index.inspect returned an unexpected shape");
    const result = parsed.data.inspectionResult;
    const index = result?.indexStatusResult;
    const out: InspectOutput = { url };
    for (const key of ["verdict", "coverageState", "indexingState", "robotsTxtState", "pageFetchState", "lastCrawlTime", "googleCanonical", "userCanonical", "crawledAs"] as const) {
      const value = index?.[key];
      if (value !== undefined) out[key] = value;
    }
    if (result?.inspectionResultLink !== undefined) out.link = result.inspectionResultLink;
    return out;
  },
};

// The registry holds FnDef<unknown>; these definitions are typed with their own input and output.
export const topQueries = topQueriesDef as FnDef;
export const topPages = topPagesDef as FnDef;
export const inspectUrl = inspectDef as FnDef;
