import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { FnDef, MethodMeta } from "../../src/contracts";
import { POST_READS, buildRegistry, getRegistry } from "../../src/core/registry";
import { isGwsError } from "../../src/errors";
import { registry } from "../../src/sdk/index";

function googleFn(name: string, method: Partial<MethodMeta>, effect: FnDef["effect"]): FnDef {
  const meta: MethodMeta = {
    id: name,
    service: "drive",
    httpMethod: "GET",
    rootUrl: "https://www.googleapis.com/",
    servicePath: "drive/v3/",
    path: "files",
    pathParams: [],
    queryParams: [],
    requestBody: false,
    mediaDownload: false,
    scopes: [],
    effect,
    ...method,
  };
  return {
    name,
    service: "drive",
    effect,
    kind: "google",
    description: "",
    signature: "",
    tsDecl: "",
    example: "",
    tags: [],
    scopes: [],
    input: z.looseObject({}),
    output: z.unknown(),
    method: meta,
  };
}

function hostFn(name: string, service: FnDef["service"]): FnDef {
  return {
    name,
    service,
    effect: "read",
    kind: "host",
    description: "",
    signature: "",
    tsDecl: "",
    example: "",
    tags: [],
    scopes: [],
    input: z.looseObject({}),
    output: z.unknown(),
    async run() {
      return {};
    },
  };
}

function refusal(fns: FnDef[]): string {
  try {
    buildRegistry(fns);
  } catch (e) {
    if (isGwsError(e) && e.code === "GWS_INTERNAL") return e.message;
    throw e;
  }
  throw new Error("expected buildRegistry to refuse");
}

describe("registry consistency", () => {
  it("builds the real SDK registry, whose every google fn agrees with its method metadata", () => {
    const reg = buildRegistry(registry());
    expect(reg.size).toBe(registry().length);
    expect(getRegistry().get("drive.files.delete")?.effect).toBe("write");
    for (const id of POST_READS) expect(reg.get(id)).toMatchObject({ effect: "read", method: { httpMethod: "POST", effect: "read" } });
  });

  it("names exactly the four read-only POST methods", () => {
    expect([...POST_READS].sort()).toEqual([
      "calendar.freebusy.query",
      "sheets.spreadsheets.developerMetadata.search",
      "sheets.spreadsheets.getByDataFilter",
      "sheets.spreadsheets.values.batchGetByDataFilter",
    ]);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("refuses a %s method that claims to be a read", (httpMethod) => {
    expect(refusal([googleFn("drive.files.fake", { httpMethod, effect: "read" }, "read")])).toMatch(/drive\.files\.fake/);
  });

  it("refuses a GET method that claims to be a write", () => {
    refusal([googleFn("drive.files.fake", { httpMethod: "GET", effect: "write" }, "write")]);
  });

  it("refuses a fn whose effect differs from its method's", () => {
    refusal([googleFn("drive.files.fake", { httpMethod: "DELETE", effect: "write" }, "read")]);
    refusal([googleFn("drive.files.fake", { httpMethod: "DELETE", effect: "read" }, "write")]);
  });

  it("refuses a fn whose name differs from its method id", () => {
    refusal([googleFn("drive.files.list", { id: "drive.files.delete", httpMethod: "DELETE" }, "write")]);
  });

  it("refuses a POST read that is not one of the known read-only POSTs", () => {
    refusal([googleFn("drive.files.query", { httpMethod: "POST", effect: "read" }, "read")]);
  });

  it("accepts a known read-only POST and ordinary writes and reads", () => {
    const reg = buildRegistry([
      googleFn("calendar.freebusy.query", { httpMethod: "POST", effect: "read" }, "read"),
      googleFn("drive.files.fake", { httpMethod: "PATCH", effect: "write" }, "write"),
      googleFn("drive.files.get2", { httpMethod: "GET", effect: "read" }, "read"),
    ]);
    expect(reg.size).toBe(3);
  });

  it("keeps the accounts namespace for accounts host fns only", () => {
    refusal([hostFn("accounts.sneaky", "helpers")]);
    refusal([hostFn("helpers.sneaky", "accounts")]);
    refusal([{ ...googleFn("accounts.list", { id: "accounts.list" }, "read"), service: "accounts" }]);
    expect(buildRegistry([hostFn("accounts.list", "accounts"), hostFn("helpers.x", "helpers")]).size).toBe(2);
  });
});
