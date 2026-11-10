import { describe, expect, it } from "vitest";
import { z } from "zod";
import { emitService } from "../../../scripts/gen/service";
import type { DiscoveryDoc } from "../../../scripts/gen/types";

const SCOPE = "https://www.googleapis.com/auth/x.readonly";

function doc(partial: Partial<DiscoveryDoc>): DiscoveryDoc {
  return {
    version: "v1",
    revision: "20260101",
    rootUrl: "https://x.googleapis.com/",
    servicePath: "",
    schemas: {},
    resources: {},
    ...partial,
  };
}

/** Evaluates emitted zod expressions against real zod, resolving schema refs lazily. */
function evaluator(schemaExprs: ReadonlyMap<string, { expr: string }>) {
  const cache = new Map<string, z.ZodType>();
  const schemas = new Proxy({} as Record<string, () => z.ZodType>, {
    get: (_t, name: string) => () => {
      let hit = cache.get(name);
      if (!hit) {
        const def = schemaExprs.get(name);
        if (!def) throw new Error(`no schema ${name}`);
        hit = new Function("z", "schemas", `return ${def.expr};`)(z, schemas) as z.ZodType;
        cache.set(name, hit);
      }
      return hit;
    },
  });
  return (expr: string) => new Function("z", "schemas", `return ${expr};`)(z, schemas) as z.ZodType;
}

const listMethod = {
  id: "x.things.list",
  httpMethod: "GET",
  path: "things/{thingId}/items",
  parameterOrder: ["thingId"],
  parameters: {
    thingId: { location: "path", required: true, type: "string" },
    ids: { location: "query", type: "string", repeated: true },
    mode: { location: "query", type: "string", enum: ["a", "b"] },
    big: { location: "query", type: "string", format: "uint64" },
    count: { location: "query", type: "integer", format: "int32" },
    limit: { location: "query", type: "integer", format: "int32", default: "10" },
    flag: { location: "query", type: "boolean", default: "false" },
  },
  response: { $ref: "Node" },
  scopes: [SCOPE],
};

const nodeSchema = {
  Node: {
    id: "Node",
    type: "object",
    properties: {
      name: { type: "string" },
      size: { type: "string", format: "int64" },
      kind: { type: "string", enum: ["x", "y"] },
      children: { type: "array", items: { $ref: "Node" } },
    },
  },
};

function build(partial: Partial<DiscoveryDoc>, service: "gmail" | "calendar" = "gmail") {
  return emitService(service, doc(partial));
}

describe("method input mapping", () => {
  const built = build({ schemas: nodeSchema, resources: { things: { methods: { list: listMethod } } } });
  const method = built.methods[0]!;
  const parse = evaluator(built.schemas)(method.inputExpr);

  it("requires path params and accepts the optional account", () => {
    expect(parse.safeParse({}).success).toBe(false);
    expect(parse.safeParse({ thingId: "t", account: "work" }).success).toBe(true);
    expect(parse.safeParse({ thingId: "t", account: 5 }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(parse.safeParse({ thingId: "t", bogus: 1 }).success).toBe(false);
  });

  it("maps repeated, enum, 64-bit and 32-bit params", () => {
    expect(parse.safeParse({ thingId: "t", ids: ["a", "b"] }).success).toBe(true);
    expect(parse.safeParse({ thingId: "t", ids: "a" }).success).toBe(false);
    expect(parse.safeParse({ thingId: "t", mode: "a" }).success).toBe(true);
    expect(parse.safeParse({ thingId: "t", mode: "c" }).success).toBe(false);
    expect(parse.safeParse({ thingId: "t", big: "123" }).success).toBe(true);
    expect(parse.safeParse({ thingId: "t", big: 123 }).success).toBe(false);
    expect(parse.safeParse({ thingId: "t", count: 3 }).success).toBe(true);
    expect(parse.safeParse({ thingId: "t", count: 3.5 }).success).toBe(false);
  });

  it("applies Discovery defaults", () => {
    expect(parse.parse({ thingId: "t" })).toMatchObject({ limit: 10, flag: false });
  });

  it("records path and query params in the method meta", () => {
    expect(method.meta.pathParams).toEqual([{ name: "thingId", reserved: false }]);
    expect(method.meta.queryParams.map((q) => q.name)).toEqual(["big", "count", "flag", "ids", "limit", "mode"]);
    expect(method.meta.queryParams.find((q) => q.name === "ids")?.repeated).toBe(true);
    expect(method.meta.effect).toBe("read");
    expect(method.id).toBe("x.things.list");
  });

  it("builds a signature, example and tags", () => {
    expect(method.signature).toBe(
      'x.things.list({ thingId: string, big?: string, count?: number, flag?: boolean, ids?: string[], limit?: number, mode?: "a" | "b", account?: string }): Promise<Node>',
    );
    expect(method.example).toBe('await sdk.x.things.list({ thingId: "<thingId>" })');
    expect(method.tags).toEqual(expect.arrayContaining(["things", "list", "read"]));
    expect(method.scopes).toEqual([SCOPE]);
  });
});

describe("global query parameters", () => {
  const GLOBALS = {
    "$.xgafv": { location: "query", type: "string", enum: ["1", "2"] },
    access_token: { location: "query", type: "string" },
    alt: { location: "query", type: "string", enum: ["json", "media", "proto"], default: "json" },
    callback: { location: "query", type: "string" },
    fields: { location: "query", type: "string", description: "Selector specifying which fields to include in a partial response." },
    key: { location: "query", type: "string" },
    oauth_token: { location: "query", type: "string" },
    prettyPrint: { location: "query", type: "boolean", default: "true" },
    quotaUser: { location: "query", type: "string" },
    uploadType: { location: "query", type: "string" },
    upload_protocol: { location: "query", type: "string" },
  };
  const built = build({ parameters: GLOBALS, schemas: nodeSchema, resources: { things: { methods: { list: listMethod } } } });
  const method = built.methods[0]!;
  const parse = evaluator(built.schemas)(method.inputExpr);

  it("adds fields as an optional string query param", () => {
    expect(method.meta.queryParams).toContainEqual({ name: "fields", repeated: false });
    expect(parse.safeParse({ thingId: "t", fields: "items(id,name)" }).success).toBe(true);
    expect(parse.safeParse({ thingId: "t", fields: 5 }).success).toBe(false);
    expect(parse.parse({ thingId: "t" })).not.toHaveProperty("fields");
    expect(method.tsHead).toContain("  fields?: string;\n");
    expect(method.signature).toContain(", fields?: string,");
  });

  it("adds no other global param", () => {
    expect(method.meta.queryParams.map((q) => q.name)).toEqual(["big", "count", "fields", "flag", "ids", "limit", "mode"]);
    for (const name of Object.keys(GLOBALS).filter((n) => n !== "fields")) {
      expect(parse.safeParse({ thingId: "t", [name]: "x" }).success).toBe(false);
    }
  });

  it("adds nothing when the document declares no global fields", () => {
    const plain = build({ schemas: nodeSchema, resources: { things: { methods: { list: listMethod } } } }).methods[0]!;
    expect(plain.meta.queryParams.some((q) => q.name === "fields")).toBe(false);
  });

  it("keeps a method's own fields param over the global one", () => {
    const own = { ...listMethod, parameters: { ...listMethod.parameters, fields: { location: "query", type: "string", enum: ["a"] } } };
    const m = build({ parameters: GLOBALS, schemas: nodeSchema, resources: { things: { methods: { list: own } } } }).methods[0]!;
    expect(m.meta.queryParams.filter((q) => q.name === "fields")).toEqual([{ name: "fields", repeated: false }]);
    expect(evaluator(built.schemas)(m.inputExpr).safeParse({ thingId: "t", fields: "b" }).success).toBe(false);
  });

  it("fails generation when the global fields param is not an optional string query param", () => {
    const bad = { ...GLOBALS, fields: { location: "query", type: "string", repeated: true } };
    expect(() => build({ parameters: bad, schemas: nodeSchema, resources: { things: { methods: { list: listMethod } } } })).toThrow(
      /global parameter fields/,
    );
  });
});

describe("schemas", () => {
  const built = build({ schemas: nodeSchema, resources: { things: { methods: { list: listMethod } } } });
  const method = built.methods[0]!;
  const out = evaluator(built.schemas)(method.outputExpr);

  it("emits a lazy reference for recursive refs", () => {
    expect(built.schemas.get("Node")?.expr).toContain("z.lazy(() => schemas.Node())");
  });

  it("accepts unknown fields but rejects type mismatches", () => {
    expect(out.safeParse({ name: "a", extra: true }).success).toBe(true);
    expect(out.safeParse({ name: 5 }).success).toBe(false);
    expect(out.safeParse({ children: [{ name: "x", children: [{ name: 1 }] }] }).success).toBe(false);
    expect(out.safeParse({ children: [{ children: [{ name: "deep" }] }] }).success).toBe(true);
  });

  it("makes every response property optional and 64-bit ints strings", () => {
    expect(out.safeParse({}).success).toBe(true);
    expect(out.safeParse({ size: "12" }).success).toBe(true);
    expect(out.safeParse({ size: 12 }).success).toBe(false);
  });

  it("tolerates new enum values in schema properties", () => {
    expect(out.safeParse({ kind: "brand-new" }).success).toBe(true);
  });

  it("emits only schemas reachable from supported methods", () => {
    const b = build({
      schemas: { ...nodeSchema, Orphan: { id: "Orphan", type: "object", properties: { a: { type: "string" } } } },
      resources: { things: { methods: { list: listMethod } } },
    });
    expect([...b.schemas.keys()]).toEqual(["Node"]);
  });

  it("declares referenced types in the TypeScript text", () => {
    expect(built.schemas.get("Node")?.ts).toContain("children?: Node[];");
  });
});

describe("request bodies and media", () => {
  const create = {
    id: "x.files.create",
    httpMethod: "POST",
    path: "files",
    request: { $ref: "Node" },
    response: { $ref: "Node" },
    supportsMediaUpload: true,
    mediaUpload: {
      accept: ["*/*"],
      maxSize: "1000",
      protocols: {
        simple: { multipart: true, path: "/upload/x/v1/files" },
        resumable: { multipart: true, path: "/resumable/upload/x/v1/files" },
      },
    },
    scopes: [SCOPE],
  };

  it("adds requestBody and media for simple uploads", () => {
    const b = build({ schemas: nodeSchema, resources: { files: { methods: { create } } } });
    const m = b.methods[0]!;
    const input = evaluator(b.schemas)(m.inputExpr);
    expect(m.meta.requestBody).toBe(true);
    expect(m.meta.mediaUpload).toEqual({
      multipartPath: "/upload/x/v1/files",
      simplePath: "/upload/x/v1/files",
      accept: ["*/*"],
      maxBytes: 1000,
    });
    expect(m.meta.effect).toBe("write");
    expect(input.safeParse({ requestBody: { name: "n" }, media: { mimeType: "text/plain", text: "hi" } }).success).toBe(true);
    expect(input.safeParse({ media: { mimeType: "image/png", dataBase64: "AAAA" } }).success).toBe(true);
    expect(input.safeParse({ media: { mimeType: "text/plain" } }).success).toBe(false);
    expect(input.safeParse({ requestBody: { name: 5 } }).success).toBe(false);
  });

  it("keeps the JSON-body variant for message uploads", () => {
    const send = { ...create, id: "x.files.send", mediaUpload: { ...create.mediaUpload, accept: ["message/*"] } };
    const b = build({ schemas: nodeSchema, resources: { files: { methods: { send } } } });
    const m = b.methods[0]!;
    expect(m.meta.mediaUpload).toBeUndefined();
    expect(evaluator(b.schemas)(m.inputExpr).safeParse({ media: { mimeType: "a/b", text: "x" } }).success).toBe(false);
    expect(b.droppedUploads).toEqual(["x.files.send"]);
  });

  it("lists resumable-only uploads as unsupported", () => {
    const big = {
      ...create,
      id: "x.files.big",
      mediaUpload: { ...create.mediaUpload, protocols: { resumable: create.mediaUpload.protocols.resumable } },
    };
    const b = build({ schemas: nodeSchema, resources: { files: { methods: { big } } } });
    expect(b.methods).toHaveLength(0);
    expect(b.unsupported).toEqual([{ method: "x.files.big", reason: expect.stringContaining("resumable") }]);
  });
});

describe("media download", () => {
  const get = {
    id: "x.files.get",
    httpMethod: "GET",
    path: "files/{id}",
    parameterOrder: ["id"],
    parameters: { id: { location: "path", required: true, type: "string" } },
    response: { $ref: "Node" },
    supportsMediaDownload: true,
    scopes: [SCOPE],
  };
  const exp = {
    id: "x.files.export",
    httpMethod: "GET",
    path: "files/{id}/export",
    parameterOrder: ["id"],
    parameters: { id: { location: "path", required: true, type: "string" } },
    supportsMediaDownload: true,
    scopes: [SCOPE],
  };
  const b = build({ schemas: nodeSchema, resources: { files: { methods: { get, export: exp } } } });
  const ev = evaluator(b.schemas);
  const byId = (id: string) => b.methods.find((m) => m.id === id)!;

  it("accepts alt on downloadable methods and returns media or metadata", () => {
    const m = byId("x.files.get");
    expect(m.meta.mediaDownload).toBe(true);
    expect(m.meta.queryParams.map((q) => q.name)).toContain("alt");
    expect(ev(m.inputExpr).safeParse({ id: "1", alt: "media" }).success).toBe(true);
    const out = ev(m.outputExpr);
    expect(out.safeParse({ mimeType: "a/b", sizeBytes: 3, dataBase64: "AAAA" }).success).toBe(true);
    expect(out.safeParse({ name: "n" }).success).toBe(true);
    expect(out.safeParse({ name: 5 }).success).toBe(false);
  });

  it("always returns media for export", () => {
    const m = byId("x.files.export");
    const out = ev(m.outputExpr);
    expect(out.safeParse({ mimeType: "application/pdf", sizeBytes: 3, dataBase64: "AAAA" }).success).toBe(true);
    expect(out.safeParse({ name: "n" }).success).toBe(false);
  });
});

describe("classification", () => {
  const watch = {
    id: "x.things.watch",
    httpMethod: "POST",
    path: "things/watch",
    request: { $ref: "Node" },
    response: { $ref: "Node" },
    supportsSubscription: true,
    scopes: [SCOPE],
  };
  const stop = { id: "x.channels.stop", httpMethod: "POST", path: "channels/stop", scopes: [SCOPE] };
  const freebusy = {
    id: "calendar.freebusy.query",
    httpMethod: "POST",
    path: "freeBusy",
    request: { $ref: "Node" },
    response: { $ref: "Node" },
    scopes: [SCOPE],
  };
  const del = {
    id: "x.things.delete",
    httpMethod: "DELETE",
    path: "things/{id}",
    parameterOrder: ["id"],
    parameters: { id: { location: "path", required: true, type: "string" } },
    scopes: [SCOPE],
  };

  it("puts watch and channel stop into the unsupported list", () => {
    const b = build({
      schemas: nodeSchema,
      resources: { things: { methods: { watch } }, channels: { methods: { stop } } },
    });
    expect(b.methods).toHaveLength(0);
    expect(b.unsupported.map((u) => u.method)).toEqual(["x.channels.stop", "x.things.watch"]);
    expect(b.unsupported.every((u) => u.reason.length > 0)).toBe(true);
  });

  it("puts every method of a watches resource into the unsupported list", () => {
    const watchMethod = (verb: string, httpMethod: string) => ({ id: `x.things.watches.${verb}`, httpMethod, path: `things/watches/${verb}`, scopes: [SCOPE] });
    const b = build({
      schemas: nodeSchema,
      resources: {
        things: {
          resources: {
            watches: {
              methods: { create: watchMethod("create", "POST"), list: watchMethod("list", "GET"), delete: watchMethod("delete", "DELETE"), renew: watchMethod("renew", "POST") },
            },
          },
        },
      },
    });
    expect(b.methods).toHaveLength(0);
    expect(b.unsupported.map((u) => u.method)).toEqual(["x.things.watches.create", "x.things.watches.delete", "x.things.watches.list", "x.things.watches.renew"]);
    expect(b.unsupported.every((u) => u.reason.startsWith("push notification channel"))).toBe(true);
  });

  it("classifies the POST reads as read and other non-GET as write", () => {
    const b = build(
      { schemas: nodeSchema, resources: { freebusy: { methods: { query: freebusy } }, things: { methods: { del } } } },
      "calendar",
    );
    const byId = new Map(b.methods.map((m) => [m.id, m]));
    expect(byId.get("calendar.freebusy.query")?.meta.effect).toBe("read");
    expect(byId.get("x.things.delete")?.meta.effect).toBe("write");
  });

  it("walks nested resources", () => {
    const nested = {
      resources: { a: { resources: { b: { methods: { get: { ...del, id: "x.a.b.get", httpMethod: "GET" } } } } } },
    };
    expect(build(nested).methods.map((m) => m.id)).toEqual(["x.a.b.get"]);
  });

  it("lists methods whose schema shape cannot be mapped, with a reason", () => {
    const weird = {
      Weird: {
        id: "Weird",
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: { type: "string" },
      },
    };
    const m = { id: "x.things.get", httpMethod: "GET", path: "w", response: { $ref: "Weird" }, scopes: [SCOPE] };
    const b = build({ schemas: weird, resources: { things: { methods: { get: m } } } });
    expect(b.methods).toHaveLength(0);
    expect(b.unsupported).toEqual([{ method: "x.things.get", reason: expect.stringContaining("Weird") }]);
  });

  it("gives every supported method the optional account", () => {
    const b = build({ schemas: nodeSchema, resources: { things: { methods: { list: listMethod, del } } } });
    for (const m of b.methods) {
      const p = evaluator(b.schemas)(m.inputExpr);
      const input = m.id === "x.things.list" ? { thingId: "t" } : { id: "i" };
      expect(p.safeParse({ ...input, account: "me@example.com" }).success).toBe(true);
      expect(m.signature).toContain("account?: string");
    }
  });
});
