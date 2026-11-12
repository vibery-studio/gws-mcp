import { googleError, randomToken } from "../oauth";
import { fakeKey, type JsonValue } from "../store";
import { GaqlError, parseGaql, type GaqlCondition, type GaqlErrorCode, type GaqlQuery, type GaqlValue } from "./ads-gaql";
import { DATE_RE, isObject, paginate, randomDigits, readJsonObject } from "./google-http";
import type { FakeContext, FakeRoute, SeedPresets } from "./index";

// ---------- model ----------

interface CustomerRecord {
  [key: string]: JsonValue;
  id: string;
  descriptiveName: string;
  currencyCode: string;
  timeZone: string;
  manager: boolean;
}

/** Stored at `ads:campaign:<email>:<customerId>/<id>`. Removing a campaign keeps it with status REMOVED. */
interface CampaignRecord {
  [key: string]: JsonValue;
  id: string;
  name: string;
  status: string;
  advertisingChannelType: string;
}

interface AdGroupRecord {
  [key: string]: JsonValue;
  id: string;
  name: string;
  status: string;
  campaignId: string;
}

/** Stored at `ads:keyword:<email>:<customerId>/<id>`: a positive keyword of an ad group. */
interface KeywordRecord {
  [key: string]: JsonValue;
  id: string;
  text: string;
  matchType: string;
  status: string;
  adGroupId: string;
}

/** One request seen by the fake, kept so tests can assert on headers. Never holds the token itself. */
interface CallRecord {
  [key: string]: JsonValue;
  seq: number;
  method: string;
  path: string;
  developerToken: boolean;
  loginCustomerId: string | null;
}

const customerKey = (email: string, id: string) => fakeKey("ads", "customer", email, id);
const campaignPrefix = (email: string, cid: string) => `ads:campaign:${email}:${cid}/`;
const adGroupPrefix = (email: string, cid: string) => `ads:adgroup:${email}:${cid}/`;
const keywordPrefix = (email: string, cid: string) => `ads:keyword:${email}:${cid}/`;
const callPrefix = (email: string) => `ads:call:${email}:`;

const byId = <T extends { id: string }>(a: T, b: T) => Number(a.id) - Number(b.id);

/** How many calls are kept per account; the oldest go first. */
const CALL_LOG_MAX = 200;

// ---------- Google's error shape ----------

const FAILURE_TYPE = "type.googleapis.com/google.ads.googleads.v23.errors.GoogleAdsFailure";

/** Google Ads wraps the reason in `details[].errors[].errorCode`, a one-key object naming the error family. */
function adsError(status: number, googleStatus: string, message: string, errorCode: Record<string, string>, detail: string): Response {
  return googleError(status, message, googleStatus, {
    details: [{ "@type": FAILURE_TYPE, errors: [{ errorCode, message: detail }], requestId: randomToken(12) }],
  });
}

const invalidArgument = (detail: string, errorCode: Record<string, string> = { requestError: "UNKNOWN" }) =>
  adsError(400, "INVALID_ARGUMENT", "Request contains an invalid argument.", errorCode, detail);

const missingToken = () =>
  adsError(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.", { authenticationError: "DEVELOPER_TOKEN_PARAMETER_MISSING" }, "Developer token is not provided.");

const noCustomer = () =>
  adsError(
    403,
    "PERMISSION_DENIED",
    "The caller does not have permission",
    { authorizationError: "USER_PERMISSION_DENIED" },
    "User doesn't have permission to access customer. Note: If you're accessing a client customer, the manager's customer id must be set in the 'login-customer-id' header.",
  );

// ---------- request preamble ----------

/** Every Ads request needs a developer token; the login customer id header is recorded when present. */
async function preamble(ctx: FakeContext): Promise<Response | undefined> {
  const login = ctx.req.headers.get("login-customer-id");
  const token = ctx.req.headers.get("developer-token");
  const prior = await ctx.store.list<CallRecord>(callPrefix(ctx.email));
  const seq = (prior.at(-1)?.[1].seq ?? 0) + 1;
  const record: CallRecord = { seq, method: ctx.req.method, path: ctx.path, developerToken: token !== null && token !== "", loginCustomerId: login };
  await ctx.store.put(`${callPrefix(ctx.email)}${String(seq).padStart(8, "0")}`, record);
  for (const [key] of prior.slice(0, Math.max(0, prior.length + 1 - CALL_LOG_MAX))) await ctx.store.delete(key);

  if (!record.developerToken) return missingToken();
  if (login !== null && !/^\d{10}$/.test(login)) {
    return adsError(400, "INVALID_ARGUMENT", "Request contains an invalid argument.", { headerError: "INVALID_LOGIN_CUSTOMER_ID" }, "Login customer ID is invalid. Use the 10 digits without dashes.");
  }
  return undefined;
}

async function customerOr403(ctx: FakeContext): Promise<CustomerRecord | Response> {
  return (await ctx.store.get<CustomerRecord>(customerKey(ctx.email, ctx.match[1] ?? ""))) ?? noCustomer();
}

// ---------- listAccessibleCustomers ----------

async function listAccessibleCustomers(ctx: FakeContext): Promise<Response> {
  const early = await preamble(ctx);
  if (early) return early;
  const customers = (await ctx.store.list<CustomerRecord>(`ads:customer:${ctx.email}:`)).map(([, c]) => c).sort(byId);
  return Response.json(customers.length > 0 ? { resourceNames: customers.map((c) => `customers/${c.id}`) } : {});
}

// ---------- GAQL evaluation ----------

/** Canned daily metrics exist for these days, per ad group. */
const FIRST_DAY = Date.UTC(2026, 10, 3);
const DAYS = 7;
const CANNED_DATES = Array.from({ length: DAYS }, (_, i) => new Date(FIRST_DAY + i * 86_400_000).toISOString().slice(0, 10));

interface Totals {
  impressions: number;
  clicks: number;
  costMicros: number;
}

function dayTotals(adGroupId: string, day: number): Totals {
  const n = Number(adGroupId);
  const impressions = 200 + (n % 9) * 40 + day * 13;
  const clicks = Math.floor(impressions * (0.04 + (n % 5) * 0.01));
  return { impressions, clicks, costMicros: clicks * (300_000 + (n % 4) * 50_000) };
}

function sumTotals(adGroups: AdGroupRecord[], dates: string[]): Totals {
  const t: Totals = { impressions: 0, clicks: 0, costMicros: 0 };
  for (const date of dates) {
    for (const ag of adGroups) {
      const d = dayTotals(ag.id, CANNED_DATES.indexOf(date));
      t.impressions += d.impressions;
      t.clicks += d.clicks;
      t.costMicros += d.costMicros;
    }
  }
  return t;
}

interface RowContext {
  cid: string;
  customer: CustomerRecord;
  campaign?: CampaignRecord;
  adGroup?: AdGroupRecord;
  keyword?: KeywordRecord;
  totals: Totals;
  date?: string;
}

type FieldType = "int" | "float" | "string" | "date";
type Scope = "ad_group" | "keyword" | "both";

interface FieldDef {
  type: FieldType;
  /** Where it can be selected from. */
  scope: Scope;
  get(r: RowContext): string | number | undefined;
}

const resource = (kind: "campaigns" | "adGroups", cid: string, id: string) => `customers/${cid}/${kind}/${id}`;
const criterionResource = (cid: string, k: KeywordRecord) => `customers/${cid}/adGroupCriteria/${k.adGroupId}~${k.id}`;

const FIELDS: Record<string, FieldDef> = {
  "customer.id": { type: "int", scope: "both", get: (r) => r.customer.id },
  "customer.descriptive_name": { type: "string", scope: "both", get: (r) => r.customer.descriptiveName },
  "customer.currency_code": { type: "string", scope: "both", get: (r) => r.customer.currencyCode },
  "customer.time_zone": { type: "string", scope: "both", get: (r) => r.customer.timeZone },
  "campaign.id": { type: "int", scope: "both", get: (r) => r.campaign?.id },
  "campaign.name": { type: "string", scope: "both", get: (r) => r.campaign?.name },
  "campaign.status": { type: "string", scope: "both", get: (r) => r.campaign?.status },
  "campaign.advertising_channel_type": { type: "string", scope: "both", get: (r) => r.campaign?.advertisingChannelType },
  "campaign.resource_name": { type: "string", scope: "both", get: (r) => (r.campaign ? resource("campaigns", r.cid, r.campaign.id) : undefined) },
  "ad_group.id": { type: "int", scope: "ad_group", get: (r) => r.adGroup?.id },
  "ad_group.name": { type: "string", scope: "ad_group", get: (r) => r.adGroup?.name },
  "ad_group.status": { type: "string", scope: "ad_group", get: (r) => r.adGroup?.status },
  "ad_group.resource_name": { type: "string", scope: "ad_group", get: (r) => (r.adGroup ? resource("adGroups", r.cid, r.adGroup.id) : undefined) },
  "ad_group_criterion.criterion_id": { type: "int", scope: "keyword", get: (r) => r.keyword?.id },
  "ad_group_criterion.keyword.text": { type: "string", scope: "keyword", get: (r) => r.keyword?.text },
  "ad_group_criterion.keyword.match_type": { type: "string", scope: "keyword", get: (r) => r.keyword?.matchType },
  "ad_group_criterion.status": { type: "string", scope: "keyword", get: (r) => r.keyword?.status },
  "ad_group_criterion.resource_name": { type: "string", scope: "keyword", get: (r) => (r.keyword ? criterionResource(r.cid, r.keyword) : undefined) },
  "metrics.impressions": { type: "int", scope: "both", get: (r) => r.totals.impressions },
  "metrics.clicks": { type: "int", scope: "both", get: (r) => r.totals.clicks },
  "metrics.cost_micros": { type: "int", scope: "both", get: (r) => r.totals.costMicros },
  "metrics.conversions": { type: "float", scope: "both", get: (r) => r.totals.clicks / 10 },
  "metrics.ctr": { type: "float", scope: "both", get: (r) => (r.totals.impressions === 0 ? 0 : r.totals.clicks / r.totals.impressions) },
  "metrics.average_cpc": { type: "float", scope: "both", get: (r) => (r.totals.clicks === 0 ? 0 : r.totals.costMicros / r.totals.clicks) },
  "segments.date": { type: "date", scope: "both", get: (r) => r.date },
};

const RESOURCES = ["campaign", "ad_group", "keyword_view"] as const;
type FromResource = (typeof RESOURCES)[number];

/** Which field scopes each resource can select: a keyword row carries its ad group and campaign too. */
const VISIBLE: Record<FromResource, readonly Scope[]> = {
  campaign: ["both"],
  ad_group: ["both", "ad_group"],
  keyword_view: ["both", "ad_group", "keyword"],
};

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function field(name: string, from: FromResource, clause: "SELECT" | "WHERE" | "ORDER_BY"): FieldDef {
  const def = FIELDS[name];
  if (!def) throw new GaqlError("UNRECOGNIZED_FIELD", `Error in query: unrecognized field in the query: '${name}'.`);
  if (!VISIBLE[from].includes(def.scope)) {
    const code: GaqlErrorCode = `PROHIBITED_FIELD_IN_${clause}_CLAUSE`;
    throw new GaqlError(code, `Error in query: unable to use '${name}' in the ${clause.replace("_", " ")} clause of a query from ${from}.`);
  }
  return def;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The inclusive date range of a `DURING` keyword, against the account clock. */
function during(keyword: string, now: number): [string, string] {
  const day = (back: number) => iso(now - back * 86_400_000);
  switch (keyword.toUpperCase()) {
    case "TODAY":
      return [day(0), day(0)];
    case "YESTERDAY":
      return [day(1), day(1)];
    case "LAST_7_DAYS":
      return [day(7), day(1)];
    case "LAST_14_DAYS":
      return [day(14), day(1)];
    case "LAST_30_DAYS":
      return [day(30), day(1)];
    case "THIS_MONTH":
      return [`${day(0).slice(0, 8)}01`, day(0)];
    default:
      throw new GaqlError("INVALID_DATE", `Error in query: unsupported date range '${keyword}'.`);
  }
}

function dateValue(v: GaqlValue): string {
  if (typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new GaqlError("INVALID_DATE", `Error in query: '${String(v)}' is not a date (use 'YYYY-MM-DD').`);
  }
  return v;
}

/** A predicate on the `segments.date` conditions, applied before metrics are summed. */
function datePredicate(conds: GaqlCondition[], now: number): (date: string) => boolean {
  const tests = conds.map((c): ((d: string) => boolean) => {
    const values = Array.isArray(c.value) ? c.value : [c.value];
    const [a, b] = values as [GaqlValue, GaqlValue | undefined];
    switch (c.op) {
      case "DURING": {
        const [from, to] = during(String(a), now);
        return (d) => d >= from && d <= to;
      }
      case "BETWEEN":
        return (d) => d >= dateValue(a) && d <= dateValue(b ?? a);
      case "=":
        return (d) => d === dateValue(a);
      case "!=":
        return (d) => d !== dateValue(a);
      case "<":
        return (d) => d < dateValue(a);
      case "<=":
        return (d) => d <= dateValue(a);
      case ">":
        return (d) => d > dateValue(a);
      case ">=":
        return (d) => d >= dateValue(a);
      default:
        throw new GaqlError("UNSUPPORTED_CLAUSE", `Error in query: the operator ${c.op} cannot be used on segments.date.`);
    }
  });
  // Evaluate each test once against a sample so that a bad date fails the query, not just the rows.
  for (const t of tests) t(CANNED_DATES[0] ?? "");
  return (d) => tests.every((t) => t(d));
}

function like(value: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("%", ".*")}$`);
  return re.test(value);
}

function matches(def: FieldDef, actual: string | number | undefined, c: GaqlCondition): boolean {
  if (actual === undefined) return false;
  const numeric = def.type === "int" || def.type === "float";
  const norm = (v: GaqlValue): string | number => (numeric ? Number(v) : String(v));
  const a = norm(actual);
  const values = (Array.isArray(c.value) ? c.value : [c.value]).map(norm);
  const [v] = values as [string | number];
  switch (c.op) {
    case "=":
      return a === v;
    case "!=":
      return a !== v;
    case "<":
      return a < v;
    case "<=":
      return a <= v;
    case ">":
      return a > v;
    case ">=":
      return a >= v;
    case "IN":
      return values.includes(a);
    case "NOT IN":
      return !values.includes(a);
    case "LIKE":
      return like(String(a), String(v));
    case "NOT LIKE":
      return !like(String(a), String(v));
    case "BETWEEN":
      return a >= v && a <= (values[1] as string | number);
    default:
      return false;
  }
}

function compare(a: string | number | undefined, b: string | number | undefined, type: FieldType): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
  return type === "int" || type === "float" ? Number(a) - Number(b) : String(a).localeCompare(String(b));
}

interface Account {
  cid: string;
  customer: CustomerRecord;
  campaigns: CampaignRecord[];
  adGroups: AdGroupRecord[];
  keywords: KeywordRecord[];
}

async function loadAccount(ctx: FakeContext, customer: CustomerRecord): Promise<Account> {
  const cid = customer.id;
  const campaigns = (await ctx.store.list<CampaignRecord>(campaignPrefix(ctx.email, cid))).map(([, c]) => c).sort(byId);
  const adGroups = (await ctx.store.list<AdGroupRecord>(adGroupPrefix(ctx.email, cid))).map(([, a]) => a).sort(byId);
  const keywords = (await ctx.store.list<KeywordRecord>(keywordPrefix(ctx.email, cid))).map(([, k]) => k).sort(byId);
  return { cid, customer, campaigns, adGroups, keywords };
}

interface Entity {
  campaign: CampaignRecord;
  adGroup: AdGroupRecord | undefined;
  keyword?: KeywordRecord;
  /** The ad groups whose daily metrics add up to this row. A keyword has the metrics of its own id. */
  adGroups: AdGroupRecord[];
}

function entitiesOf(from: FromResource, account: Account): Entity[] {
  if (from === "campaign") {
    return account.campaigns.map((campaign) => ({ campaign, adGroup: undefined, adGroups: account.adGroups.filter((a) => a.campaignId === campaign.id) }));
  }
  const withCampaign = (adGroup: AdGroupRecord) => account.campaigns.find((c) => c.id === adGroup.campaignId);
  if (from === "ad_group") {
    return account.adGroups.flatMap((adGroup) => {
      const campaign = withCampaign(adGroup);
      return campaign ? [{ campaign, adGroup, adGroups: [adGroup] }] : [];
    });
  }
  return account.keywords.flatMap((keyword) => {
    const adGroup = account.adGroups.find((a) => a.id === keyword.adGroupId);
    const campaign = adGroup && withCampaign(adGroup);
    return adGroup && campaign ? [{ campaign, adGroup, keyword, adGroups: [{ ...adGroup, id: keyword.id }] }] : [];
  });
}

interface GaqlResult {
  fieldMask: string;
  rows: Array<Record<string, JsonValue>>;
}

/** Runs a parsed query. Rows come back in the API's nested camelCase shape, int64 values as strings. */
function evaluate(q: GaqlQuery, account: Account, now: number): GaqlResult {
  if (!(RESOURCES as readonly string[]).includes(q.from)) {
    throw new GaqlError("PROHIBITED_RESOURCE_TYPE_IN_FROM_CLAUSE", `Error in query: the resource '${q.from}' cannot be used in the FROM clause; the fake serves campaign, ad_group and keyword_view.`);
  }
  const from = q.from as FromResource;
  const selected = q.select.map((name) => ({ name, def: field(name, from, "SELECT") }));
  const dateConds = q.where.filter((c) => c.field === "segments.date");
  const otherConds = q.where.filter((c) => c.field !== "segments.date").map((c) => ({ c, def: field(c.field, from, "WHERE") }));
  for (const c of dateConds) field(c.field, from, "WHERE");
  const orders = q.orderBy.map((o) => ({ ...o, def: field(o.field, from, "ORDER_BY") }));

  const inRange = datePredicate(dateConds, now);
  const dates = CANNED_DATES.filter(inRange);
  const segmentByDate = q.select.includes("segments.date");

  const entities = entitiesOf(from, account);

  const contexts: RowContext[] = [];
  for (const e of entities) {
    const base = {
      cid: account.cid,
      customer: account.customer,
      campaign: e.campaign,
      ...(e.adGroup ? { adGroup: e.adGroup } : {}),
      ...(e.keyword ? { keyword: e.keyword } : {}),
    };
    if (segmentByDate) {
      if (e.adGroups.length === 0) continue;
      for (const date of dates) contexts.push({ ...base, date, totals: sumTotals(e.adGroups, [date]) });
    } else {
      contexts.push({ ...base, totals: sumTotals(e.adGroups, dates) });
    }
  }

  const kept = contexts.filter((r) => otherConds.every(({ c, def }) => matches(def, def.get(r), c)));
  if (orders.length > 0) {
    kept.sort((a, b) => {
      for (const o of orders) {
        const c = compare(o.def.get(a), o.def.get(b), o.def.type);
        if (c !== 0) return o.desc ? -c : c;
      }
      return 0;
    });
  }
  const limited = q.limit === undefined ? kept : kept.slice(0, q.limit);

  const rows = limited.map((r) => {
    const row: Record<string, JsonValue> = {};
    const put = (name: string, def: FieldDef) => {
      const value = def.get(r);
      if (value === undefined) return;
      const path = name.split(".").map(camel);
      const leaf = path.pop() as string;
      let out = row;
      for (const part of path) out = (out[part] ??= {}) as Record<string, JsonValue>;
      out[leaf] = def.type === "int" ? String(value) : value;
    };
    // The resource being queried always carries its resource name, as in Google.
    const own = from === "campaign" ? "campaign.resource_name" : from === "ad_group" ? "ad_group.resource_name" : "ad_group_criterion.resource_name";
    put(own, FIELDS[own] as FieldDef);
    for (const s of selected) put(s.name, s.def);
    return row;
  });
  return { fieldMask: q.select.map((n) => n.split(".").map(camel).join(".")).join(","), rows };
}

function runQuery(ctx: FakeContext, account: Account, query: unknown): GaqlResult | Response {
  if (typeof query !== "string" || query.trim() === "") return invalidArgument("query is required.", { queryError: "UNEXPECTED_END_OF_QUERY" });
  try {
    return evaluate(parseGaql(query), account, ctx.now());
  } catch (e) {
    if (e instanceof GaqlError) return invalidArgument(e.message, { queryError: e.code });
    throw e;
  }
}

// ---------- googleAds:search and :searchStream ----------

const SEARCH_PAGE_MAX = 10_000;
/** Rows per batch of searchStream. Google sends up to 10 000; the fake uses fewer so multi-batch handling gets exercised. */
export const STREAM_BATCH_SIZE = 10;

async function search(ctx: FakeContext): Promise<Response> {
  const early = await preamble(ctx);
  if (early) return early;
  const customer = await customerOr403(ctx);
  if (customer instanceof Response) return customer;
  const body = await readJsonObject(ctx.req);
  if (!body) return invalidArgument("Invalid JSON payload received.");
  const params = new URLSearchParams();
  for (const k of ["pageSize", "pageToken"]) {
    const v = body[k];
    if (v === undefined) continue;
    if (typeof v !== "string" && typeof v !== "number") return invalidArgument(`${k} has the wrong type.`);
    params.set(k, String(v));
  }
  const result = runQuery(ctx, await loadAccount(ctx, customer), body.query);
  if (result instanceof Response) return result;
  if (body.validateOnly === true) return Response.json({});

  const paged = paginate(result.rows, params, "pageSize", SEARCH_PAGE_MAX, SEARCH_PAGE_MAX);
  if ("error" in paged) return invalidArgument(paged.error);
  const out: Record<string, JsonValue> = {};
  if (paged.page.length > 0) out.results = paged.page;
  if (paged.nextPageToken) out.nextPageToken = paged.nextPageToken;
  if (body.returnTotalResultsCount === true) out.totalResultsCount = String(result.rows.length);
  out.fieldMask = result.fieldMask;
  return Response.json(out);
}

/** Google streams a JSON array of batches: each batch holds a slice of the rows and repeats the field mask. */
async function searchStream(ctx: FakeContext): Promise<Response> {
  const early = await preamble(ctx);
  if (early) return early;
  const customer = await customerOr403(ctx);
  if (customer instanceof Response) return customer;
  const body = await readJsonObject(ctx.req);
  if (!body) return invalidArgument("Invalid JSON payload received.");
  const summary = body.summaryRowSetting;
  if (summary !== undefined && summary !== "NO_SUMMARY_ROW" && summary !== "UNSPECIFIED") return invalidArgument("The fake does not return summary rows.");
  const result = runQuery(ctx, await loadAccount(ctx, customer), body.query);
  if (result instanceof Response) return result;

  const batches: JsonValue[] = [];
  for (let i = 0; i === 0 || i < result.rows.length; i += STREAM_BATCH_SIZE) {
    const rows = result.rows.slice(i, i + STREAM_BATCH_SIZE);
    batches.push({ ...(rows.length > 0 ? { results: rows } : {}), fieldMask: result.fieldMask, requestId: randomToken(12) });
  }
  return Response.json(batches);
}

// ---------- campaigns:mutate ----------

const CHANNEL_TYPES = ["SEARCH", "DISPLAY", "SHOPPING", "HOTEL", "VIDEO", "MULTI_CHANNEL", "LOCAL", "SMART", "PERFORMANCE_MAX", "LOCAL_SERVICES", "TRAVEL", "DEMAND_GEN"];
const SETTABLE_STATUS = ["ENABLED", "PAUSED"];

const mutateFailure = (detail: string) => invalidArgument(detail, { mutateError: "RESOURCE_NOT_FOUND" });

/** Applies one operation to `campaigns` (a working copy) and returns its result, or the reason it fails. */
function applyOperation(op: unknown, i: number, cid: string, campaigns: Map<string, CampaignRecord>): { resourceName: string; campaignId: string } | string {
  const kinds = isObject(op) ? ["create", "update", "remove"].filter((k) => op[k] !== undefined) : [];
  const [kind] = kinds;
  if (!isObject(op) || kinds.length !== 1 || kind === undefined) return `operations[${i}] must set exactly one of create, update or remove.`;
  const named = (resourceName: unknown): CampaignRecord | string => {
    const m = typeof resourceName === "string" ? new RegExp(`^customers/${cid}/campaigns/(\\d+)$`).exec(resourceName) : null;
    const rec = m?.[1] === undefined ? undefined : campaigns.get(m[1]);
    return rec && rec.status !== "REMOVED" ? rec : `operations[${i}]: the campaign ${String(resourceName)} was not found.`;
  };

  if (kind === "remove") {
    const rec = named(op.remove);
    if (typeof rec === "string") return rec;
    rec.status = "REMOVED";
    return { resourceName: resource("campaigns", cid, rec.id), campaignId: rec.id };
  }

  const arg = op[kind];
  if (!isObject(arg)) return `operations[${i}].${kind} must be an object.`;
  const unsupported = Object.keys(arg).filter((k) => !["name", "status", "advertisingChannelType", "resourceName"].includes(k));
  if (unsupported.length > 0) return `operations[${i}].${kind}: the fake supports name, status and advertisingChannelType only, not ${unsupported.join(", ")}.`;
  if (arg.status !== undefined && (typeof arg.status !== "string" || !SETTABLE_STATUS.includes(arg.status))) return `operations[${i}].${kind}.status must be ENABLED or PAUSED.`;
  if (arg.name !== undefined && (typeof arg.name !== "string" || arg.name.trim() === "")) return `operations[${i}].${kind}.name must be a non-empty string.`;

  if (kind === "create") {
    if (typeof arg.name !== "string") return `operations[${i}].create.name is required.`;
    const type = arg.advertisingChannelType ?? "SEARCH";
    if (typeof type !== "string" || !CHANNEL_TYPES.includes(type)) return `operations[${i}].create.advertisingChannelType is not a channel type.`;
    const used = [...campaigns.values()].some((c) => c.status !== "REMOVED" && c.name === arg.name);
    if (used) return `operations[${i}].create.name: a campaign named '${arg.name}' already exists.`;
    const rec: CampaignRecord = { id: randomDigits(9), name: arg.name, status: typeof arg.status === "string" ? arg.status : "PAUSED", advertisingChannelType: type };
    campaigns.set(rec.id, rec);
    return { resourceName: resource("campaigns", cid, rec.id), campaignId: rec.id };
  }

  const rec = named(arg.resourceName);
  if (typeof rec === "string") return rec;
  if (typeof op.updateMask !== "string" || op.updateMask.trim() === "") return `operations[${i}].updateMask is required for an update.`;
  for (const f of op.updateMask.split(",").map((s) => s.trim())) {
    if (f === "name" && typeof arg.name === "string") rec.name = arg.name;
    else if (f === "status" && typeof arg.status === "string") rec.status = arg.status;
    else return `operations[${i}].updateMask: '${f}' cannot be updated (the fake supports name and status, and the field must be set).`;
  }
  return { resourceName: resource("campaigns", cid, rec.id), campaignId: rec.id };
}

function renderCampaign(cid: string, c: CampaignRecord): Record<string, JsonValue> {
  return { resourceName: resource("campaigns", cid, c.id), id: c.id, name: c.name, status: c.status, advertisingChannelType: c.advertisingChannelType };
}

async function mutateCampaigns(ctx: FakeContext): Promise<Response> {
  const early = await preamble(ctx);
  if (early) return early;
  const customer = await customerOr403(ctx);
  if (customer instanceof Response) return customer;
  const body = await readJsonObject(ctx.req);
  if (!body) return invalidArgument("Invalid JSON payload received.");
  const ops = body.operations;
  if (!Array.isArray(ops) || ops.length === 0) return invalidArgument("operations must be a non-empty list.");
  if (body.partialFailure === true) return invalidArgument("The fake applies operations all or nothing: partialFailure is not supported.");
  const content = body.responseContentType;
  if (content !== undefined && content !== "RESOURCE_NAME_ONLY" && content !== "MUTABLE_RESOURCE" && content !== "UNSPECIFIED") {
    return invalidArgument("responseContentType is not one of RESOURCE_NAME_ONLY or MUTABLE_RESOURCE.");
  }

  const cid = customer.id;
  const working = new Map((await ctx.store.list<CampaignRecord>(campaignPrefix(ctx.email, cid))).map(([, c]) => [c.id, structuredClone(c)]));
  const results: Array<{ resourceName: string; campaignId: string }> = [];
  for (const [i, op] of ops.entries()) {
    const r = applyOperation(op, i, cid, working);
    if (typeof r === "string") return mutateFailure(r);
    results.push(r);
  }
  if (body.validateOnly === true) return Response.json({});

  for (const r of results) {
    const rec = working.get(r.campaignId) as CampaignRecord;
    await ctx.store.put(`${campaignPrefix(ctx.email, cid)}${rec.id}`, rec);
  }
  return Response.json({
    results: results.map((r) => ({
      resourceName: r.resourceName,
      ...(content === "MUTABLE_RESOURCE" ? { campaign: renderCampaign(cid, working.get(r.campaignId) as CampaignRecord) } : {}),
    })),
  });
}

// ---------- routes ----------

const ADWORDS = "https://www.googleapis.com/auth/adwords";
const V = "^/googleads\\.googleapis\\.com/v23/customers";

export const routes: FakeRoute[] = [
  { method: "GET", pattern: new RegExp(`${V}:listAccessibleCustomers$`), scopes: [ADWORDS], handle: listAccessibleCustomers },
  { method: "POST", pattern: new RegExp(`${V}/([^/]+)/googleAds:search$`), scopes: [ADWORDS], handle: search },
  { method: "POST", pattern: new RegExp(`${V}/([^/]+)/googleAds:searchStream$`), scopes: [ADWORDS], handle: searchStream },
  { method: "POST", pattern: new RegExp(`${V}/([^/]+)/campaigns:mutate$`), scopes: [ADWORDS], handle: mutateCampaigns },
];

// ---------- seed preset ----------

const MANAGER = "1234567890";
const STORE = "9876543210";

const customer = (id: string, descriptiveName: string, manager: boolean) => ({
  key: `ads:customer:{email}:${id}`,
  value: { id, descriptiveName, currencyCode: "USD", timeZone: "Asia/Saigon", manager },
});
const campaign = (id: string, name: string, status: string, advertisingChannelType: string) => ({
  key: `ads:campaign:{email}:${STORE}/${id}`,
  value: { id, name, status, advertisingChannelType },
});
const adGroup = (id: string, name: string, campaignId: string) => ({
  key: `ads:adgroup:{email}:${STORE}/${id}`,
  value: { id, name, status: "ENABLED", campaignId },
});

const keyword = (id: string, text: string, matchType: string, adGroupId: string) => ({
  key: `ads:keyword:{email}:${STORE}/${id}`,
  value: { id, text, matchType, status: "ENABLED", adGroupId },
});

/** A manager account and a client account (`9876543210`) with three campaigns, four ad groups and four keywords. */
export const presets: SeedPresets = {
  default: [
    customer(MANAGER, "Example Agency", true),
    customer(STORE, "Example Store", false),
    campaign("111111111", "Brand search", "ENABLED", "SEARCH"),
    campaign("222222222", "Shopping feed", "ENABLED", "PERFORMANCE_MAX"),
    campaign("333333333", "Winter promo", "PAUSED", "DISPLAY"),
    adGroup("1001", "Brand exact", "111111111"),
    adGroup("1002", "Brand phrase", "111111111"),
    adGroup("1003", "Asset group", "222222222"),
    adGroup("1004", "Remarketing", "333333333"),
    keyword("5001", "example store", "EXACT", "1001"),
    keyword("5002", "buy example", "PHRASE", "1002"),
    keyword("5003", "example shipping", "BROAD", "1002"),
    keyword("5004", "winter sale", "PHRASE", "1004"),
  ],
};
