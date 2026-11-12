import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_NAMES } from "../../../scripts/gen/service";
import type { DiscoveryDoc, DiscoveryMethod, DiscoveryResource } from "../../../scripts/gen/types";
import type { MethodMeta } from "../../../src/contracts";
import { GwsError } from "../../../src/errors";
import { buildRequest } from "../../../src/google/request";
import { generatedFns } from "../../../src/sdk/generated/index";

const root = path.resolve(import.meta.dirname, "../../..");
const pins = JSON.parse(readFileSync(path.join(root, "discovery/pins.json"), "utf8")) as Record<string, { version: string }>;

function collect(res: DiscoveryResource, into: Map<string, DiscoveryMethod>): Map<string, DiscoveryMethod> {
  for (const m of Object.values(res.methods ?? {})) into.set(m.id, m);
  for (const child of Object.values(res.resources ?? {})) collect(child, into);
  return into;
}

/** Every Discovery method of the pinned documents the SDK is generated from, by id. */
const discovered = new Map<string, DiscoveryMethod>();
for (const api of API_NAMES) {
  const pin = pins[api];
  if (pin === undefined) throw new Error(`no pin for ${api}`);
  collect(JSON.parse(readFileSync(path.join(root, `discovery/${api}.${pin.version}.json`), "utf8")) as DiscoveryDoc, discovered);
}

const metas = generatedFns.flatMap((f) => (f.method ? [f.method] : []));
const patterned = metas.flatMap((meta) => meta.pathParams.flatMap((p) => (p.pattern === undefined ? [] : [{ meta, param: p.name, pattern: p.pattern }])));
const reserved = metas.flatMap((meta) => meta.pathParams.filter((p) => p.reserved).map((p) => ({ meta, param: p.name })));

/** A value the pattern accepts: each one-segment wildcard becomes "1". */
const sampleOf = (pattern: string): string => pattern.slice(1, -1).replaceAll("[^/]+", "1");

/** Input with a sample value for every path param of the method, then `overrides`. */
function inputFor(meta: MethodMeta, overrides: Record<string, string> = {}): Record<string, string> {
  const input: Record<string, string> = {};
  for (const p of meta.pathParams) input[p.name] = p.pattern === undefined ? "x" : sampleOf(p.pattern);
  return { ...input, ...overrides };
}

function refusal(meta: MethodMeta, input: Record<string, string>): GwsError | undefined {
  try {
    buildRequest(meta, input);
    return undefined;
  } catch (e) {
    if (e instanceof GwsError) return e;
    throw e;
  }
}

describe("Discovery path patterns in the generated SDK", () => {
  it("covers the services with reserved paths", () => {
    const perService: Record<string, number> = {};
    for (const { meta } of reserved) perService[meta.id.split(".")[0]!] = (perService[meta.id.split(".")[0]!] ?? 0) + 1;
    expect(perService).toEqual({ analyticsadmin: 49, analyticsdata: 11, googleads: 80, slides: 1, tagmanager: 104 });
  });

  it("gives every reserved path parameter the pattern Discovery has for it", () => {
    const missing = reserved.filter(({ meta, param }) => {
      const pattern = discovered.get(meta.id)?.parameters?.[param]?.pattern;
      return pattern === undefined || meta.pathParams.find((p) => p.name === param)?.pattern !== pattern;
    });
    expect(missing.map(({ meta, param }) => `${meta.id}:${param}`)).toEqual([]);
  });

  it("keeps exactly the Discovery pattern of every path parameter that has one", () => {
    for (const meta of metas) {
      const params = discovered.get(meta.id)?.parameters ?? {};
      for (const p of meta.pathParams) expect(p.pattern, `${meta.id}:${p.name}`).toBe(params[p.name]?.pattern);
    }
  });

  it.each(patterned.map(({ meta, param, pattern }) => [meta.id, param, pattern] as const))("%s builds a %s matching %s", (id, param, pattern) => {
    const meta = metas.find((m) => m.id === id)!;
    expect(refusal(meta, inputFor(meta))).toBeUndefined();
    expect(buildRequest(meta, inputFor(meta)).url).toContain(`/${sampleOf(pattern)}`);
  });

  it.each(patterned.map(({ meta, param }) => [meta.id, param] as const))("%s refuses a %s with an extra segment", (id, param) => {
    const meta = metas.find((m) => m.id === id)!;
    const value = `${inputFor(meta)[param]}/1`;
    const e = refusal(meta, inputFor(meta, { [param]: value }));
    expect(e?.code).toBe("GWS_INVALID_INPUT");
    expect(e?.details).toMatchObject({ param, reason: "pattern-mismatch" });
  });

  it("refuses, for each reserved parameter, every other resource form of its service", () => {
    let refused = 0;
    for (const { meta, param } of reserved) {
      const own = meta.pathParams.find((p) => p.name === param)!.pattern!;
      const service = meta.id.split(".")[0]!;
      const others = new Set(patterned.filter((x) => x.meta.id.split(".")[0] === service && x.pattern !== own).map((x) => sampleOf(x.pattern)));
      for (const value of others) {
        if (new RegExp(own, "u").test(value)) continue;
        const e = refusal(meta, inputFor(meta, { [param]: value }));
        expect(e?.details, `${meta.id}:${param}=${value}`).toMatchObject({ param, reason: "pattern-mismatch" });
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(0);
  });

  it.each(reserved.map(({ meta, param }) => [meta.id, param] as const))("%s refuses traversal and percent signs in %s", (id, param) => {
    const meta = metas.find((m) => m.id === id)!;
    const valid = inputFor(meta)[param]!;
    const cases: Array<[string, string]> = [
      [`${valid}/..`, "dot-segment"],
      [`../${valid}`, "dot-segment"],
      [`${valid}/.`, "dot-segment"],
      [`/${valid}`, "empty-segment"],
      [`${valid}/`, "empty-segment"],
      [`${valid}%2F1`, "percent-sign"],
      [`${valid}%2e%2e`, "percent-sign"],
      [`${valid}%5C1`, "percent-sign"],
      [`${valid}%252F1`, "percent-sign"],
      [`${valid}%41`, "percent-sign"],
    ];
    for (const [value, reason] of cases) {
      expect(refusal(meta, inputFor(meta, { [param]: value }))?.details, value).toEqual({ param, reason });
    }
  });
});
