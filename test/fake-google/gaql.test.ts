import { describe, expect, it } from "vitest";
import { GaqlError, parseGaql } from "../../fake-google/src/routes/ads-gaql";

describe("parseGaql", () => {
  it("parses select, from, where, order by and limit", () => {
    expect(
      parseGaql(`SELECT campaign.id, campaign.name, metrics.clicks
        FROM campaign
        WHERE campaign.status = 'ENABLED' AND metrics.clicks >= 10
        ORDER BY metrics.clicks DESC, campaign.id
        LIMIT 5`),
    ).toEqual({
      select: ["campaign.id", "campaign.name", "metrics.clicks"],
      from: "campaign",
      where: [
        { field: "campaign.status", op: "=", value: "ENABLED" },
        { field: "metrics.clicks", op: ">=", value: 10 },
      ],
      orderBy: [
        { field: "metrics.clicks", desc: true },
        { field: "campaign.id", desc: false },
      ],
      limit: 5,
    });
  });

  it("is case-insensitive for keywords and accepts a bare enum and double quotes", () => {
    const q = parseGaql(`select ad_group.name from ad_group where ad_group.status = PAUSED and campaign.name = "A b"`);
    expect(q.from).toBe("ad_group");
    expect(q.where).toEqual([
      { field: "ad_group.status", op: "=", value: "PAUSED" },
      { field: "campaign.name", op: "=", value: "A b" },
    ]);
  });

  it("parses IN, NOT IN, LIKE, BETWEEN and DURING", () => {
    const q = parseGaql(
      `SELECT campaign.id FROM campaign WHERE campaign.status IN (ENABLED, PAUSED) AND campaign.id NOT IN (1, 2) AND campaign.name LIKE '%brand%' AND segments.date BETWEEN '2026-11-01' AND '2026-11-05' AND segments.date DURING LAST_7_DAYS`,
    );
    expect(q.where).toEqual([
      { field: "campaign.status", op: "IN", value: ["ENABLED", "PAUSED"] },
      { field: "campaign.id", op: "NOT IN", value: [1, 2] },
      { field: "campaign.name", op: "LIKE", value: "%brand%" },
      { field: "segments.date", op: "BETWEEN", value: ["2026-11-01", "2026-11-05"] },
      { field: "segments.date", op: "DURING", value: "LAST_7_DAYS" },
    ]);
  });

  it("reads quoted values with escapes and negative numbers", () => {
    const q = parseGaql(`SELECT campaign.id FROM campaign WHERE campaign.name = 'it\\'s' AND metrics.ctr > -1`);
    expect(q.where.map((w) => w.value)).toEqual(["it's", -1]);
  });

  const code = (query: string) => {
    try {
      parseGaql(query);
    } catch (e) {
      if (e instanceof GaqlError) return e.code;
      throw e;
    }
    return "none";
  };

  it.each([
    ["", "UNEXPECTED_END_OF_QUERY"],
    ["SELECT", "UNEXPECTED_END_OF_QUERY"],
    ["SELECT campaign.id", "UNEXPECTED_END_OF_QUERY"],
    ["SELECT campaign.id FROM", "UNEXPECTED_END_OF_QUERY"],
    ["FROM campaign", "UNEXPECTED_INPUT"],
    ["SELECT FROM campaign", "UNEXPECTED_INPUT"],
    ["SELECT campaign.id, FROM campaign", "UNEXPECTED_INPUT"],
    ["SELECT campaign.id FROM campaign WHERE", "UNEXPECTED_END_OF_QUERY"],
    ["SELECT campaign.id FROM campaign WHERE campaign.id", "UNEXPECTED_END_OF_QUERY"],
    ["SELECT campaign.id FROM campaign WHERE campaign.id ~ 1", "UNEXPECTED_INPUT"],
    ["SELECT campaign.id FROM campaign WHERE campaign.id IN 1", "UNEXPECTED_INPUT"],
    ["SELECT campaign.id FROM campaign WHERE a = 1 OR b = 2", "UNSUPPORTED_CLAUSE"],
    ["SELECT campaign.id FROM campaign LIMIT 0", "INVALID_LIMIT_CLAUSE"],
    ["SELECT campaign.id FROM campaign LIMIT x", "INVALID_LIMIT_CLAUSE"],
    ["SELECT campaign.id FROM campaign PARAMETERS include_drafts=true", "UNSUPPORTED_CLAUSE"],
    ["SELECT campaign.id FROM campaign garbage", "UNEXPECTED_INPUT"],
    ["SELECT campaign.id FROM campaign WHERE campaign.name = 'open", "UNEXPECTED_INPUT"],
  ])("rejects %j with %s", (query, expected) => {
    expect(code(query)).toBe(expected);
  });
});
