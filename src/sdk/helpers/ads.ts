import { z } from "zod";
import type { FnDef } from "../../contracts";
import { GwsError } from "../../errors";
import { paginate } from "../../google/paginate";

const DAY_MS = 86_400_000;
const SCOPES = ["https://www.googleapis.com/auth/adwords"];
const MAX_ROWS = 10_000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

const Account = z.string().min(1).max(320).optional();

const AccountsInput = z.strictObject({ account: Account });
type AccountsInput = z.output<typeof AccountsInput>;

const AccountsOutput = z.strictObject({
  customers: z.array(z.strictObject({ customerId: z.string(), resourceName: z.string() })),
});
type AccountsOutput = z.output<typeof AccountsOutput>;

const AccessibleCustomers = z.looseObject({ resourceNames: z.array(z.string()).optional() });

const accountsDef: FnDef<AccountsInput, AccountsOutput> = {
  kind: "host",
  name: "ads.accounts",
  service: "helpers",
  effect: "read",
  description:
    "Lists the Google Ads customer accounts the signed-in Google account can access directly (listAccessibleCustomers): customer id and resource name. Needs the Google Ads developer token saved in settings. Use a customer id with ads.report.",
  signature: "ads.accounts({ account?: string }): Promise<{ customers: { customerId: string, resourceName: string }[] }>",
  tsDecl: ["type Input = { account?: string };", "type Output = { customers: { customerId: string; resourceName: string }[] }; // customerId is 10 digits"].join("\n"),
  example: "await sdk.ads.accounts({})",
  tags: ["helpers", "ads", "googleads", "adwords", "google", "advertising", "accounts", "account", "customers", "list", "read"],
  scopes: SCOPES,
  input: AccountsInput,
  output: AccountsOutput,
  async run(input, ctx) {
    const raw = await ctx.call("googleads.customers.listAccessibleCustomers", input.account === undefined ? {} : { account: input.account });
    const parsed = AccessibleCustomers.safeParse(raw);
    if (!parsed.success) throw new GwsError("GWS_RESPONSE_SHAPE", "googleads.customers.listAccessibleCustomers returned an unexpected shape");
    return { customers: (parsed.data.resourceNames ?? []).map((resourceName) => ({ customerId: resourceName.replace(/^customers\//, ""), resourceName })) };
  },
};

const METRICS = "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions";

/** One fixed query per preset; `where` and `limit` are filled in from the input. */
const PRESETS = {
  campaigns: {
    select: `campaign.id, campaign.name, campaign.status, ${METRICS}`,
    from: "campaign",
    extra: "campaign.status != 'REMOVED'",
  },
  adGroups: {
    select: `campaign.name, ad_group.id, ad_group.name, ad_group.status, ${METRICS}`,
    from: "ad_group",
    extra: "ad_group.status != 'REMOVED'",
  },
  keywords: {
    select: `campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ${METRICS}`,
    from: "keyword_view",
    extra: "ad_group_criterion.status != 'REMOVED'",
  },
} as const;
type Preset = keyof typeof PRESETS;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The preset's GAQL for the `days` complete days that end yesterday (UTC), costliest rows first. */
export function presetQuery(preset: Preset, days: number, limit: number, now: number): string {
  const p = PRESETS[preset];
  const end = now - DAY_MS;
  const start = end - (days - 1) * DAY_MS;
  return `SELECT ${p.select} FROM ${p.from} WHERE segments.date BETWEEN '${isoDay(start)}' AND '${isoDay(end)}' AND ${p.extra} ORDER BY metrics.cost_micros DESC LIMIT ${limit}`;
}

const ReportInput = z
  .strictObject({
    account: Account,
    customerId: z
      .string()
      .regex(/^\d{3}-?\d{3}-?\d{4}$/, "use the 10-digit customer id, e.g. 1234567890")
      .transform((v) => v.replaceAll("-", "")),
    gaql: z.string().min(1).max(8000).optional(),
    preset: z.enum(["campaigns", "adGroups", "keywords"]).optional(),
    days: z.number().int().min(1).max(365).default(30),
    limit: z.number().int().min(1).max(MAX_ROWS).default(100),
  })
  .superRefine((v, issues) => {
    if ((v.gaql === undefined) === (v.preset === undefined)) {
      issues.addIssue({ code: "custom", path: ["gaql"], message: "give exactly one of gaql or preset" });
    }
  });
type ReportInput = z.output<typeof ReportInput>;

const ReportOutput = z.strictObject({
  customerId: z.string(),
  query: z.string(),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  truncated: z.boolean(),
});
type ReportOutput = z.output<typeof ReportOutput>;

const SearchPage = z.looseObject({ results: z.array(z.unknown()).optional(), nextPageToken: z.string().optional() });

type Cell = string | number | boolean | null;

/** `{ campaign: { name: "x" }, metrics: { clicks: "5" } }` becomes `{ "campaign.name": "x", "metrics.clicks": 5 }`. */
function flatten(row: unknown): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  const walk = (value: unknown, path: string[]) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
      return;
    }
    const key = path.join(".");
    if (typeof value === "string" && path[0] === "metrics" && value !== "" && Number.isFinite(Number(value))) out[key] = Number(value);
    else if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else out[key] = JSON.stringify(value); // a list, e.g. labels
  };
  walk(row, []);
  return out;
}

const reportDef: FnDef<ReportInput, ReportOutput> = {
  kind: "host",
  name: "ads.report",
  service: "helpers",
  effect: "read",
  description:
    "Runs a Google Ads report for one customer account and returns flat rows keyed by field, like \"campaign.name\" and \"metrics.clicks\" (metrics as numbers, cost in micros). Give a preset (campaigns, adGroups or keywords: impressions, clicks, cost and conversions over the last days, costliest first) or your own GAQL query. Needs the Google Ads developer token saved in settings.",
  signature:
    "ads.report({ customerId: string, preset?: \"campaigns\" | \"adGroups\" | \"keywords\", gaql?: string, days?: number, limit?: number, account?: string }): Promise<{ customerId: string, query: string, rows: Record<string, string | number | boolean | null>[], truncated: boolean }>",
  tsDecl: [
    "type Input = {",
    "  customerId: string; // 10 digits, from ads.accounts",
    "  preset?: \"campaigns\" | \"adGroups\" | \"keywords\"; // exactly one of preset and gaql",
    "  gaql?: string; // a GAQL SELECT query, run as given",
    "  days?: number; // preset only: 1-365, default 30, ending yesterday",
    "  limit?: number; // preset only: 1-10000, default 100",
    "  account?: string;",
    "};",
    "type Output = {",
    "  customerId: string;",
    "  query: string; // the GAQL that ran",
    '  rows: Record<string, string | number | boolean | null>[]; // e.g. { "campaign.name": "Brand", "metrics.clicks": 255 }',
    "  truncated: boolean; // more than 10000 rows",
    "};",
  ].join("\n"),
  example: 'await sdk.ads.report({ customerId: "<customerId>", preset: "campaigns", days: 30 })',
  tags: ["helpers", "ads", "adwords", "google", "advertising", "report", "campaign", "campaigns", "adgroup", "keywords", "gaql", "cost", "clicks", "spend", "read"],
  scopes: SCOPES,
  input: ReportInput,
  output: ReportOutput,
  async run(input, ctx) {
    const { customerId, account } = input;
    const query = input.gaql ?? presetQuery(input.preset as Preset, input.days, input.limit, Date.now());
    // Pages of `search`: bounded by maxPages and maxItems, one dispatcher call each.
    const walked = await paginate<unknown>(
      async (pageToken) => {
        const raw = await ctx.call("googleads.customers.googleAds.search", {
          customerId,
          requestBody: { query, pageSize: PAGE_SIZE, ...(pageToken === undefined ? {} : { pageToken }) },
          ...(account === undefined ? {} : { account }),
        });
        const page = SearchPage.safeParse(raw);
        if (!page.success) throw new GwsError("GWS_RESPONSE_SHAPE", "googleads.customers.googleAds.search returned an unexpected shape");
        return { items: page.data.results ?? [], ...(page.data.nextPageToken === undefined || page.data.nextPageToken === "" ? {} : { nextPageToken: page.data.nextPageToken }) };
      },
      { maxPages: MAX_PAGES, maxItems: MAX_ROWS },
    );
    return { customerId, query, rows: walked.items.map(flatten), truncated: walked.truncated };
  },
};

// The registry holds FnDef<unknown>; these definitions are typed with their own input and output.
export const adsAccounts = accountsDef as FnDef;
export const adsReport = reportDef as FnDef;
