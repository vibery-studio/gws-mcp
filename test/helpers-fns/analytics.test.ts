import { describe, expect, it } from "vitest";
import { fake } from "../helpers/fake";
import { auditRows, connect, errorCodeOf, G, session, valueOf } from "./harness";

const READ = `${G}analytics.readonly`;
/** The fake's report data covers 2026-11-01 to 2026-11-07. */
const NOW = Date.parse("2026-11-08T05:00:00Z");

type Row = Record<string, string | number>;

describe("analytics.report", () => {
  it.each([false, true])("returns flat rows with numeric metrics (apply=%s)", async (apply) => {
    const { auth, email } = await connect("h-ga", [READ], { now: NOW });
    const { s, executeId } = session(auth, apply);

    const out = valueOf(await s.dispatch("analytics.report", { propertyId: "2001", dimensions: ["date"], metrics: ["sessions", "activeUsers"], days: 7 }));

    expect(out).toMatchObject({ propertyId: "properties/2001", startDate: "7daysAgo", endDate: "yesterday", rowCount: 7, truncated: false });
    const rows = out.rows as Row[];
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({ date: "20261101", sessions: 198, activeUsers: 162 });
    expect(rows[6]).toEqual({ date: "20261107", sessions: 222, activeUsers: 186 });
    expect(s.plan).toEqual([]);

    await s.close();
    expect((await auditRows(executeId)).map((r) => [r.fn, r.applied, r.status])).toEqual([
      ["analyticsdata.properties.runReport", 0, "ok"],
      ["analytics.report", 0, "ok"],
    ]);
    const asked = (await fake.requests(email)).filter((q) => q.path.endsWith(":runReport"));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.path).toContain("/properties/2001:runReport");
  });

  it("accepts the property as properties/<id> and works without dimensions", async () => {
    const { auth } = await connect("h-ga", [READ], { now: NOW });
    const out = valueOf(await session(auth, false).s.dispatch("analytics.report", { propertyId: "properties/2001", metrics: ["sessions"], days: 7 }));
    expect(out.propertyId).toBe("properties/2001");
    const rows = out.rows as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessions).toBe(1494);
  });

  it("marks the output truncated when Google counted more rows than were returned", async () => {
    const { auth } = await connect("h-ga", [READ], { now: NOW });
    const out = valueOf(await session(auth, false).s.dispatch("analytics.report", { propertyId: "2001", dimensions: ["date"], metrics: ["sessions"], days: 7, limit: 3 }));
    expect(out).toMatchObject({ rowCount: 7, truncated: true });
    expect(out.rows as Row[]).toHaveLength(3);
  });

  it("rejects bad input before calling Google", async () => {
    const { auth } = await connect("h-ga", [READ], { now: NOW });
    const { s } = session(auth, false);
    const bad = [
      { propertyId: "abc", metrics: ["sessions"] },
      { propertyId: "2001", metrics: [] },
      { propertyId: "2001", metrics: ["sessions;drop"] },
      { propertyId: "2001", metrics: ["sessions"], days: 0 },
      { propertyId: "2001", metrics: ["sessions"], dimensions: Array.from({ length: 10 }, (_, i) => `d${i}`) },
    ];
    for (const input of bad) expect(errorCodeOf(await s.dispatch("analytics.report", input))).toBe("GWS_INVALID_INPUT");
    expect(s.calls.every((c) => c.fn === "analytics.report")).toBe(true);
  });

  it("surfaces an unknown metric as a Google error", async () => {
    const { auth } = await connect("h-ga", [READ], { now: NOW });
    expect(errorCodeOf(await session(auth, false).s.dispatch("analytics.report", { propertyId: "2001", metrics: ["notAMetric"] }))).toBe("GWS_UPSTREAM_ERROR");
  });

  it("surfaces a property the account cannot see as a Google error", async () => {
    const { auth } = await connect("h-ga", [READ], { now: NOW });
    expect(errorCodeOf(await session(auth, false).s.dispatch("analytics.report", { propertyId: "999999", metrics: ["sessions"] }))).toBe("GWS_UPSTREAM_ERROR");
  });

  it("names the missing scope when Analytics was never granted", async () => {
    const { auth } = await connect("h-ga", [`${G}drive.file`]);
    expect(errorCodeOf(await session(auth, false).s.dispatch("analytics.report", { propertyId: "2001", metrics: ["sessions"] }))).toBe("GWS_SCOPE_MISSING");
  });
});

describe("analytics.properties", () => {
  it("lists every property with its account, flattened", async () => {
    const { auth } = await connect("h-ga", [READ]);
    const { s, executeId } = session(auth, false);
    const out = valueOf(await s.dispatch("analytics.properties", {}));
    expect(out.truncated).toBe(false);
    expect(out.properties).toEqual([
      { propertyId: "2001", displayName: "Example site", propertyType: "PROPERTY_TYPE_ORDINARY", accountId: "1001", accountName: "Example Co" },
      { propertyId: "2002", displayName: "Example app", propertyType: "PROPERTY_TYPE_ORDINARY", accountId: "1002", accountName: "Example Labs" },
    ]);
    await s.close();
    expect((await auditRows(executeId)).map((r) => r.fn)).toEqual(["analyticsadmin.accountSummaries.list", "analytics.properties"]);
  });

  it("follows every page of account summaries", async () => {
    const { auth, email } = await connect("h-ga", [READ]);
    const resources = Array.from({ length: 205 }, (_, i) => ({
      key: `analyticsadmin:account:${email}:${String(5000 + i)}`,
      value: { name: `accounts/${5000 + i}`, displayName: `Bulk ${i}`, regionCode: "VN", createTime: "2026-09-01T00:00:00.000Z", updateTime: "2026-09-01T00:00:00.000Z" },
    }));
    const properties = resources.map((r, i) => ({
      key: `analyticsadmin:property:${email}:${String(7000 + i)}`,
      value: { name: `properties/${7000 + i}`, parent: r.value.name, displayName: `Prop ${i}`, propertyType: "PROPERTY_TYPE_ORDINARY" },
    }));
    await fake.seed({ accounts: [], resources: [...resources, ...properties] });
    const { s } = session(auth, false);
    const out = valueOf(await s.dispatch("analytics.properties", {}));
    expect((out.properties as unknown[]).length).toBe(207);
    expect(s.calls.filter((c) => c.fn === "analyticsadmin.accountSummaries.list")).toHaveLength(2);
  });
});
