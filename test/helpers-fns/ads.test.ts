import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { presetQuery } from "../../src/sdk/helpers/ads";
import { openUserSettings } from "../../src/store/user-settings";
import { fake } from "../helpers/fake";
import { auditRows, connect, errorCodeOf, G, session, valueOf } from "./harness";

const ADWORDS = `${G}adwords`;
const STORE = "9876543210";
/** The fake's metrics cover 2026-11-03 to 2026-11-09. */
const NOW = Date.parse("2026-11-10T05:00:00Z");
const settings = openUserSettings(env);

type Row = Record<string, string | number | boolean | null>;

async function adsClient(withToken = true) {
  const client = await connect("h-ads", [ADWORDS], { now: NOW });
  if (withToken) await settings.set(client.auth.userId, "ads.developer_token", `FAKE-dev-token-${crypto.randomUUID().slice(0, 8)}`);
  return client;
}

describe("presetQuery", () => {
  it("builds fixed GAQL per preset with dates from days", () => {
    const now = Date.parse("2026-11-10T05:00:00Z");
    expect(presetQuery("campaigns", 7, 20, now)).toBe(
      "SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '2026-11-03' AND '2026-11-09' AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC LIMIT 20",
    );
    expect(presetQuery("adGroups", 1, 5, now)).toContain("FROM ad_group WHERE segments.date BETWEEN '2026-11-09' AND '2026-11-09'");
    expect(presetQuery("keywords", 30, 5, now)).toContain("FROM keyword_view WHERE segments.date BETWEEN '2026-10-11' AND '2026-11-09'");
  });
});

describe("ads.accounts", () => {
  it("lists the accessible customers", async () => {
    const { auth } = await adsClient();
    const { s, executeId } = session(auth, false);
    const out = valueOf(await s.dispatch("ads.accounts", {}));
    expect(out.customers).toEqual([
      { customerId: "1234567890", resourceName: "customers/1234567890" },
      { customerId: STORE, resourceName: `customers/${STORE}` },
    ]);
    await s.close();
    expect((await auditRows(executeId)).map((r) => r.fn)).toEqual(["googleads.customers.listAccessibleCustomers", "ads.accounts"]);
  });

  it("fails with the missing-token error before any Google request", async () => {
    const { auth, email } = await adsClient(false);
    expect(errorCodeOf(await session(auth, false).s.dispatch("ads.accounts", {}))).toBe("GWS_ADS_DEVELOPER_TOKEN_MISSING");
    expect((await fake.requests(email)).filter((q) => q.path.includes("googleads"))).toEqual([]);
  });
});

describe("raw searchStream", () => {
  it("returns the array of batches without a shape error", async () => {
    const { auth } = await adsClient();
    const out = (await session(auth, false).s.dispatch("googleads.customers.googleAds.searchStream", {
      customerId: STORE,
      requestBody: { query: "SELECT campaign.id, segments.date, metrics.clicks FROM campaign ORDER BY campaign.id, segments.date" },
    })) as { ok?: true; value?: unknown };
    expect(out.ok).toBe(true);
    const batches = out.value as Array<{ results?: unknown[]; fieldMask?: string }>;
    expect(Array.isArray(batches)).toBe(true);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((b) => b.results ?? []).length).toBe(21);
  });
});

describe("ads.report", () => {
  it.each([false, true])("flattens the campaigns preset (apply=%s)", async (apply) => {
    const { auth, email } = await adsClient();
    const { s, executeId } = session(auth, apply);

    const out = valueOf(await s.dispatch("ads.report", { customerId: STORE, preset: "campaigns", days: 7 }));

    expect(out.truncated).toBe(false);
    const rows = out.rows as Row[];
    expect(rows.map((r) => r["campaign.name"]).sort()).toEqual(["Brand search", "Shopping feed", "Winter promo"]);
    const brand = rows.find((r) => r["campaign.name"] === "Brand search");
    expect(brand).toMatchObject({ "campaign.id": "111111111", "campaign.status": "ENABLED" });
    expect(typeof brand?.["metrics.clicks"]).toBe("number");
    expect(typeof brand?.["metrics.costMicros"]).toBe("number");
    const costs = rows.map((r) => r["metrics.costMicros"] as number);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
    expect(s.plan).toEqual([]);

    await s.close();
    expect((await auditRows(executeId)).map((r) => [r.fn, r.applied, r.status])).toEqual([
      ["googleads.customers.googleAds.search", 0, "ok"],
      ["ads.report", 0, "ok"],
    ]);
    expect((await fake.requests(email)).filter((q) => q.path.endsWith("googleAds:search"))).toHaveLength(1);
  });

  it("follows every page of a large result through the dispatcher", async () => {
    const { auth, email } = await adsClient();
    const resources = Array.from({ length: 1100 }, (_, i) => ({
      key: `ads:keyword:${email}:${STORE}/${String(10_000 + i)}`,
      value: { id: String(10_000 + i), text: `bulk keyword ${i}`, matchType: "BROAD", status: "ENABLED", adGroupId: "1001" },
    }));
    // One seed request takes at most 1000 resources.
    await fake.seed({ accounts: [], resources: resources.slice(0, 550) });
    await fake.seed({ accounts: [], resources: resources.slice(550) });
    const { s } = session(auth, false);
    const out = valueOf(await s.dispatch("ads.report", { customerId: STORE, preset: "keywords", days: 7, limit: 5000 }));
    expect((out.rows as Row[]).length).toBe(1104);
    expect(out.truncated).toBe(false);
    expect(s.calls.filter((c) => c.fn === "googleads.customers.googleAds.search")).toHaveLength(2);
  });

  it("covers ad groups and keywords", async () => {
    const { auth } = await adsClient();
    const groups = valueOf(await session(auth, false).s.dispatch("ads.report", { customerId: STORE, preset: "adGroups", days: 7 }));
    expect((groups.rows as Row[]).map((r) => r["adGroup.name"]).sort()).toEqual(["Asset group", "Brand exact", "Brand phrase", "Remarketing"]);

    const keywords = valueOf(await session(auth, false).s.dispatch("ads.report", { customerId: STORE, preset: "keywords", days: 7, limit: 2 }));
    const rows = keywords.rows as Row[];
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(typeof r["adGroupCriterion.keyword.text"]).toBe("string");
      expect(["EXACT", "PHRASE", "BROAD"]).toContain(r["adGroupCriterion.keyword.matchType"]);
    }
  });

  it("runs a custom GAQL query as given and echoes it", async () => {
    const { auth } = await adsClient();
    const gaql = "SELECT campaign.name, metrics.clicks FROM campaign WHERE campaign.status = 'PAUSED'";
    const out = valueOf(await session(auth, false).s.dispatch("ads.report", { customerId: "987-654-3210", gaql }));
    expect(out).toMatchObject({ customerId: STORE, query: gaql });
    expect((out.rows as Row[]).map((r) => r["campaign.name"])).toEqual(["Winter promo"]);
  });

  it("handles an empty result", async () => {
    const { auth } = await adsClient();
    const out = valueOf(await session(auth, false).s.dispatch("ads.report", { customerId: STORE, gaql: "SELECT campaign.id FROM campaign WHERE campaign.name = 'nope'" }));
    expect(out).toMatchObject({ rows: [], truncated: false });
  });

  it("needs exactly one of gaql and preset, and a 10-digit customer id", async () => {
    const { auth } = await adsClient();
    const { s } = session(auth, false);
    for (const input of [
      { customerId: STORE },
      { customerId: STORE, gaql: "SELECT campaign.id FROM campaign", preset: "campaigns" },
      { customerId: "123", preset: "campaigns" },
      { customerId: STORE, preset: "nope" },
    ]) {
      expect(errorCodeOf(await s.dispatch("ads.report", input))).toBe("GWS_INVALID_INPUT");
    }
    expect(s.calls.every((c) => c.fn === "ads.report")).toBe(true);
  });

  it("surfaces a bad query as a Google error", async () => {
    const { auth } = await adsClient();
    expect(errorCodeOf(await session(auth, false).s.dispatch("ads.report", { customerId: STORE, gaql: "SELECT nonsense FROM campaign" }))).toBe("GWS_UPSTREAM_ERROR");
  });

  it("fails with the missing-token error before any Google request", async () => {
    const { auth, email } = await adsClient(false);
    expect(errorCodeOf(await session(auth, false).s.dispatch("ads.report", { customerId: STORE, preset: "campaigns" }))).toBe("GWS_ADS_DEVELOPER_TOKEN_MISSING");
    expect((await fake.requests(email)).filter((q) => q.path.includes("googleads"))).toEqual([]);
  });
});
