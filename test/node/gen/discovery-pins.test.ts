import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DISCOVERY_SOURCES, mergePins, selectSources, type Pin } from "../../../scripts/fetch-discovery";

const root = path.resolve(import.meta.dirname, "../../..");
const pins = JSON.parse(readFileSync(path.join(root, "discovery/pins.json"), "utf8")) as Record<string, Pin>;
const pin = (revision: string): Pin => ({ version: "v1", revision, url: "u", sha256: "h", bytes: 1 });

describe("discovery pins", () => {
  it("pins every discovery source, in source order, with a matching file", () => {
    expect(Object.keys(pins)).toEqual(DISCOVERY_SOURCES.map((s) => s.api));
    for (const src of DISCOVERY_SOURCES) {
      const p = pins[src.api]!;
      expect(p.version, src.api).toBe(src.version);
      expect(p.url, src.api).toBe(src.url);
      const bytes = readFileSync(path.join(root, `discovery/${src.api}.${src.version}.json`));
      expect(bytes.length, src.api).toBe(p.bytes);
      expect(createHash("sha256").update(bytes).digest("hex"), src.api).toBe(p.sha256);
      const doc = JSON.parse(bytes.toString("utf8")) as { revision: string; version: string };
      expect(doc.revision, src.api).toBe(p.revision);
    }
  });

  it("pins the marketing, groups and tag manager documents under their api names", () => {
    const byApi = new Map(DISCOVERY_SOURCES.map((s) => [s.api as string, s.version as string]));
    expect(Object.fromEntries(["searchconsole", "analyticsdata", "analyticsadmin", "admin", "groupssettings", "googleads", "tagmanager"].map((a) => [a, byApi.get(a)]))).toEqual({
      searchconsole: "v1",
      analyticsdata: "v1beta",
      analyticsadmin: "v1beta",
      admin: "directory_v1",
      groupssettings: "v1",
      googleads: "v23",
      tagmanager: "v2",
    });
  });

  it("selects all sources by default and exactly the named ones otherwise", () => {
    expect(selectSources([])).toHaveLength(DISCOVERY_SOURCES.length);
    expect(selectSources(["slides", "forms"]).map((s) => s.api)).toEqual(["forms", "slides"]);
    expect(() => selectSources(["nope"])).toThrow(/unknown discovery api nope/);
    expect(() => selectSources(["tasks", "tasks"])).toThrow(/given twice/);
  });

  it("merges fetched pins without touching the others, in source order", () => {
    const merged = mergePins({ docs: pin("1"), gmail: pin("2") }, { forms: pin("3"), docs: pin("4") });
    expect(Object.keys(merged)).toEqual(["gmail", "docs", "forms"]);
    expect(merged.gmail?.revision).toBe("2");
    expect(merged.docs?.revision).toBe("4");
    expect(() => mergePins({ stray: pin("1") }, {})).toThrow(/without a discovery source: stray/);
  });
});
