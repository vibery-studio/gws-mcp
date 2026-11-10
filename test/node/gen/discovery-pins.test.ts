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
    expect(Object.keys(pins)).toEqual(DISCOVERY_SOURCES.map((s) => s.service));
    for (const src of DISCOVERY_SOURCES) {
      const p = pins[src.service]!;
      expect(p.version, src.service).toBe(src.version);
      expect(p.url, src.service).toBe(src.url);
      const bytes = readFileSync(path.join(root, `discovery/${src.service}.${src.version}.json`));
      expect(bytes.length, src.service).toBe(p.bytes);
      expect(createHash("sha256").update(bytes).digest("hex"), src.service).toBe(p.sha256);
      const doc = JSON.parse(bytes.toString("utf8")) as { revision: string; version: string };
      expect(doc.revision, src.service).toBe(p.revision);
    }
  });

  it("selects all sources by default and exactly the named ones otherwise", () => {
    expect(selectSources([])).toHaveLength(DISCOVERY_SOURCES.length);
    expect(selectSources(["slides", "forms"]).map((s) => s.service)).toEqual(["forms", "slides"]);
    expect(() => selectSources(["nope"])).toThrow(/unknown discovery service nope/);
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
