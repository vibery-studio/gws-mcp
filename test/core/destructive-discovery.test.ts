import { describe, expect, it } from "vitest";
import docsDiscovery from "../../discovery/docs.v1.json?raw";
import formsDiscovery from "../../discovery/forms.v1.json?raw";
import slidesDiscovery from "../../discovery/slides.v1.json?raw";
import { DELETING_REQUEST_KINDS, isDestructive } from "../../src/core/destructive";

/** The pinned Discovery doc of each batchUpdate method whose request kinds are checked for deletes. */
const DISCOVERY: Readonly<Record<string, string>> = {
  "docs.documents.batchUpdate": docsDiscovery,
  "slides.presentations.batchUpdate": slidesDiscovery,
  "forms.forms.batchUpdate": formsDiscovery,
};

/** Kinds named `delete*` that remove only formatting, not content, so they are deliberately not flagged. */
const FORMATTING_ONLY: Readonly<Record<string, string>> = {
  deleteParagraphBullets: "removes the bullets of the paragraphs; their text stays",
};

type Json = Record<string, unknown>;

function child(node: unknown, key: string, where: string): Json {
  const value = typeof node === "object" && node !== null ? (node as Json)[key] : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Discovery has no object at ${where}.${key}`);
  return value as Json;
}

function ref(node: Json, where: string): string {
  const target = node.$ref;
  if (typeof target !== "string") throw new Error(`Discovery has no $ref at ${where}`);
  return target;
}

/** The request kinds a batchUpdate method accepts: the properties of its `requests` item schema. */
function requestKinds(fn: string): string[] {
  const raw = DISCOVERY[fn];
  if (raw === undefined) throw new Error(`no pinned Discovery doc for ${fn}`);
  const doc = JSON.parse(raw) as unknown;
  const [, resource, method] = fn.split(".");
  if (resource === undefined || method === undefined) throw new Error(`unexpected method name ${fn}`);
  const request = child(child(child(child(doc, "resources", fn), resource, fn), "methods", fn), method, fn);
  const schemas = child(doc, "schemas", fn);
  const bodySchema = child(schemas, ref(child(request, "request", fn), `${fn}.request`), fn);
  const items = child(child(child(bodySchema, "properties", fn), "requests", fn), "items", fn);
  const kinds = Object.keys(child(child(schemas, ref(items, `${fn}.requests.items`), fn), "properties", fn));
  if (kinds.length === 0) throw new Error(`no request kinds for ${fn}`);
  return kinds;
}

const single = (kind: string) => ({ requestBody: { requests: [{ [kind]: {} }] } });

const deleteKinds = Object.keys(DISCOVERY).flatMap((fn) => requestKinds(fn).filter((k) => k.startsWith("delete")).map((k) => [fn, k] as const));

describe("deleting request kinds against the pinned Discovery docs", () => {
  it("checks every method that has a list of deleting kinds", () => {
    expect(Object.keys(DELETING_REQUEST_KINDS).sort()).toEqual(Object.keys(DISCOVERY).sort());
  });

  it.each(deleteKinds.filter(([, kind]) => !(kind in FORMATTING_ONLY)))("%s flags %s alone as a delete", (fn, kind) => {
    expect(isDestructive(fn, single(kind))).toEqual({ destructive: true, reason: "delete" });
  });

  it.each(deleteKinds.filter(([, kind]) => kind in FORMATTING_ONLY))("%s leaves the formatting-only %s unflagged", (fn, kind) => {
    expect(isDestructive(fn, single(kind)).destructive).toBe(false);
  });

  it("lists only formatting-only exceptions that Discovery still has", () => {
    const known = new Set(deleteKinds.map(([, kind]) => kind));
    expect(Object.keys(FORMATTING_ONLY).filter((kind) => !known.has(kind))).toEqual([]);
  });

  it.each(Object.entries(DELETING_REQUEST_KINDS))("every kind listed for %s exists in Discovery", (fn, kinds) => {
    const known = new Set(requestKinds(fn));
    expect(kinds.filter((kind) => !known.has(kind))).toEqual([]);
  });
});
