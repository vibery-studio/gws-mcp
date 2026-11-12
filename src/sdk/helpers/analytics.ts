import { z } from "zod";
import type { FnDef } from "../../contracts";
import { GwsError } from "../../errors";
import { paginate } from "../../google/paginate";

const SCOPES = ["https://www.googleapis.com/auth/analytics.readonly"];
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_:]*$/;
const Field = z.string().regex(FIELD_NAME, "use a GA4 API name such as sessions or sessionSource").max(128);
const Account = z.string().min(1).max(320).optional();

const PropertyId = z
  .string()
  .regex(/^(properties\/)?\d{1,20}$/, "use the numeric property id, e.g. 2001 or properties/2001")
  .transform((v) => (v.startsWith("properties/") ? v : `properties/${v}`));

const ReportInput = z.strictObject({
  account: Account,
  propertyId: PropertyId,
  dimensions: z.array(Field).max(9).default([]),
  metrics: z.array(Field).min(1).max(10),
  days: z.number().int().min(1).max(3650).default(28),
  limit: z.number().int().min(1).max(10_000).default(1000),
});
type ReportInput = z.output<typeof ReportInput>;

const ReportOutput = z.strictObject({
  propertyId: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
  /** Rows Google counted for the report, which may exceed the rows returned. */
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
type ReportOutput = z.output<typeof ReportOutput>;

const Header = z.looseObject({ name: z.string() });
const Value = z.looseObject({ value: z.string().optional() });
const RunReportResponse = z.looseObject({
  dimensionHeaders: z.array(Header).optional(),
  metricHeaders: z.array(Header).optional(),
  rows: z.array(z.looseObject({ dimensionValues: z.array(Value).optional(), metricValues: z.array(Value).optional() })).optional(),
  rowCount: z.number().int().optional(),
});

/** Metric values come as strings; a numeric one becomes a number. */
function metricValue(raw: string | undefined): string | number {
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

const reportDef: FnDef<ReportInput, ReportOutput> = {
  kind: "host",
  name: "analytics.report",
  service: "helpers",
  effect: "read",
  description:
    "Runs a Google Analytics 4 report for a property over the last days (ending yesterday) and returns flat rows: one object per row keyed by dimension and metric name, with numeric metrics. For traffic, sessions, users, pages and sources, e.g. dimensions [\"date\"] with metrics [\"sessions\",\"activeUsers\"]. Find property ids with analytics.properties.",
  signature:
    "analytics.report({ propertyId: string, dimensions?: string[], metrics: string[], days?: number, limit?: number, account?: string }): Promise<{ propertyId: string, startDate: string, endDate: string, rows: Record<string, string | number>[], rowCount: number, truncated: boolean }>",
  tsDecl: [
    "type Input = {",
    '  propertyId: string; // numeric id, e.g. "2001" or "properties/2001"; see analytics.properties',
    '  dimensions?: string[]; // up to 9 GA4 API names, e.g. "date", "pagePath", "sessionSource"',
    '  metrics: string[]; // 1-10 GA4 API names, e.g. "sessions", "activeUsers", "screenPageViews"',
    "  days?: number; // 1-3650, default 28; the range ends yesterday",
    "  limit?: number; // 1-10000 rows, default 1000",
    "  account?: string;",
    "};",
    "type Output = {",
    "  propertyId: string; // properties/<id>",
    '  startDate: string; // e.g. "28daysAgo"',
    '  endDate: string; // "yesterday"',
    "  rows: Record<string, string | number>[]; // dimension values as text, metric values as numbers",
    "  rowCount: number; // rows Google counted, may exceed rows.length",
    "  truncated: boolean;",
    "};",
  ].join("\n"),
  example: 'await sdk.analytics.report({ propertyId: "<propertyId>", dimensions: ["date"], metrics: ["sessions", "activeUsers"], days: 7 })',
  tags: ["helpers", "analytics", "ga4", "report", "traffic", "sessions", "users", "pageviews", "visitors", "metrics", "dimensions", "read"],
  scopes: SCOPES,
  input: ReportInput,
  output: ReportOutput,
  async run(input, ctx) {
    const { propertyId, dimensions, metrics, days, limit, account } = input;
    const startDate = `${days}daysAgo`;
    const endDate = "yesterday";
    const raw = await ctx.call("analyticsdata.properties.runReport", {
      property: propertyId,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
        limit: String(limit), // an int64 field, sent as text
      },
      ...(account === undefined ? {} : { account }),
    });
    const parsed = RunReportResponse.safeParse(raw);
    if (!parsed.success) throw new GwsError("GWS_RESPONSE_SHAPE", "analyticsdata.properties.runReport returned an unexpected shape");
    const dimNames = parsed.data.dimensionHeaders?.map((h) => h.name) ?? dimensions;
    const metricNames = parsed.data.metricHeaders?.map((h) => h.name) ?? metrics;
    const rows = (parsed.data.rows ?? []).map((r) => {
      const row: Record<string, string | number> = {};
      dimNames.forEach((name, i) => {
        row[name] = r.dimensionValues?.[i]?.value ?? "";
      });
      metricNames.forEach((name, i) => {
        row[name] = metricValue(r.metricValues?.[i]?.value);
      });
      return row;
    });
    const rowCount = parsed.data.rowCount ?? rows.length;
    return { propertyId, startDate, endDate, rows, rowCount, truncated: rowCount > rows.length };
  },
};

const PropertiesInput = z.strictObject({ account: Account });
type PropertiesInput = z.output<typeof PropertiesInput>;

const PropertiesOutput = z.strictObject({
  properties: z.array(
    z.strictObject({
      propertyId: z.string(),
      displayName: z.string(),
      propertyType: z.string().optional(),
      accountId: z.string(),
      accountName: z.string(),
    }),
  ),
  /** True when more than 1000 properties exist. */
  truncated: z.boolean(),
});
type PropertiesOutput = z.output<typeof PropertiesOutput>;

const SummariesPage = z.looseObject({
  accountSummaries: z
    .array(
      z.looseObject({
        account: z.string().optional(),
        displayName: z.string().optional(),
        propertySummaries: z
          .array(z.looseObject({ property: z.string().optional(), displayName: z.string().optional(), propertyType: z.string().optional() }))
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

const MAX_PROPERTIES = 1000;
const MAX_PAGES = 10;

const propertiesDef: FnDef<PropertiesInput, PropertiesOutput> = {
  kind: "host",
  name: "analytics.properties",
  service: "helpers",
  effect: "read",
  description:
    "Lists the Google Analytics properties (GA4) the account can see, with each property's id, name and account. Use the property id with analytics.report.",
  signature:
    "analytics.properties({ account?: string }): Promise<{ properties: { propertyId: string, displayName: string, propertyType?: string, accountId: string, accountName: string }[], truncated: boolean }>",
  tsDecl: [
    "type Input = { account?: string };",
    "type Output = {",
    "  properties: { propertyId: string; displayName: string; propertyType?: string; accountId: string; accountName: string }[];",
    "  truncated: boolean; // more than 1000 properties",
    "};",
  ].join("\n"),
  example: "await sdk.analytics.properties({})",
  tags: ["helpers", "analytics", "analyticsadmin", "analyticsdata", "ga4", "google", "properties", "list", "read"],
  scopes: SCOPES,
  input: PropertiesInput,
  output: PropertiesOutput,
  async run(input, ctx) {
    const acct = input.account === undefined ? {} : { account: input.account };
    const walked = await paginate<z.output<typeof PropertiesOutput>["properties"][number]>(
      async (pageToken) => {
        const raw = await ctx.call("analyticsadmin.accountSummaries.list", { pageSize: 200, ...(pageToken === undefined ? {} : { pageToken }), ...acct });
        const page = SummariesPage.safeParse(raw);
        if (!page.success) throw new GwsError("GWS_RESPONSE_SHAPE", "analyticsadmin.accountSummaries.list returned an unexpected shape");
        const items = (page.data.accountSummaries ?? []).flatMap((a) =>
          (a.propertySummaries ?? []).flatMap((p) =>
            p.property === undefined
              ? []
              : [
                  {
                    propertyId: p.property.replace(/^properties\//, ""),
                    displayName: p.displayName ?? "",
                    ...(p.propertyType === undefined ? {} : { propertyType: p.propertyType }),
                    accountId: (a.account ?? "").replace(/^accounts\//, ""),
                    accountName: a.displayName ?? "",
                  },
                ],
          ),
        );
        return { items, ...(page.data.nextPageToken === undefined ? {} : { nextPageToken: page.data.nextPageToken }) };
      },
      { maxPages: MAX_PAGES, maxItems: MAX_PROPERTIES },
    );
    return { properties: walked.items, truncated: walked.truncated };
  },
};

// The registry holds FnDef<unknown>; these definitions are typed with their own input and output.
export const analyticsReport = reportDef as FnDef;
export const analyticsProperties = propertiesDef as FnDef;
