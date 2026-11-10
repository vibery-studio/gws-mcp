import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generate, type GenerateInput } from "../../../scripts/gen/generate";
import type { DiscoveryDoc } from "../../../scripts/gen/types";

const small: DiscoveryDoc = {
  version: "v1",
  revision: "20260101",
  rootUrl: "https://x.googleapis.com/",
  servicePath: "",
  schemas: {
    B: { id: "B", type: "object", properties: { z: { type: "string" }, a: { $ref: "A" } } },
    A: { id: "A", type: "object", properties: { b: { $ref: "B" }, n: { type: "integer", format: "int32" } } },
  },
  resources: {
    zeta: {
      methods: {
        get: { id: "gmail.zeta.get", httpMethod: "GET", path: "z", response: { $ref: "A" }, scopes: ["s2", "s1"] },
      },
    },
    alpha: {
      methods: {
        list: { id: "gmail.alpha.list", httpMethod: "GET", path: "a", response: { $ref: "B" }, scopes: ["s1"] },
      },
    },
  },
};

const input = (docs: DiscoveryDoc = small): GenerateInput => ({
  gmail: { doc: docs, version: "v1", revision: "20260101" },
});

describe("generation determinism", () => {
  it("produces identical bytes and hash across runs", () => {
    const a = generate(input());
    const b = generate(input());
    expect([...a.files]).toEqual([...b.files]);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is independent of source key order", () => {
    const reordered: DiscoveryDoc = {
      ...small,
      schemas: Object.fromEntries(Object.entries(small.schemas).reverse()),
      resources: Object.fromEntries(Object.entries(small.resources ?? {}).reverse()),
    };
    expect(generate(input(reordered)).hash).toBe(generate(input()).hash);
  });

  it("changes the hash when one input byte changes", () => {
    const changed = JSON.parse(JSON.stringify(small).replace('"path":"z"', '"path":"y"')) as DiscoveryDoc;
    expect(generate(input(changed)).hash).not.toBe(generate(input()).hash);
  });

  it("emits LF only, no timestamps or absolute paths", () => {
    for (const [file, text] of generate(input()).files) {
      expect(text, file).not.toContain("\r");
      expect(text, file).not.toContain(process.cwd());
      expect(text, file).not.toMatch(/\b20\d\d-\d\d-\d\dT\d\d:/);
      expect(text.endsWith("\n"), file).toBe(true);
    }
  });

  it("keeps the manifest out of the hash and renders the unsupported report", () => {
    const out = generate(input());
    expect(out.files.get("manifest.ts")).toContain(out.hash);
    expect(out.files.get("UNSUPPORTED.md")).toContain("| method | reason |");
  });

  it("generates the pinned documents deterministically", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const pins = JSON.parse(readFileSync(path.join(root, "discovery/pins.json"), "utf8")) as Record<
      string,
      { version: string; revision: string }
    >;
    const load = (): GenerateInput =>
      Object.fromEntries(
        Object.entries(pins).map(([svc, pin]) => [
          svc,
          {
            doc: JSON.parse(readFileSync(path.join(root, `discovery/${svc}.${pin.version}.json`), "utf8")) as DiscoveryDoc,
            version: pin.version,
            revision: pin.revision,
          },
        ]),
      ) as GenerateInput;
    expect(generate(load()).hash).toBe(generate(load()).hash);
  });
});
