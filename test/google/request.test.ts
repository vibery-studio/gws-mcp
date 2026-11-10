import { describe, expect, it } from "vitest";
import type { MethodMeta } from "../../src/contracts";
import { GwsError } from "../../src/errors";
import { buildRequest, describeRequest, pathCollisions } from "../../src/google/request";
import { generatedFns } from "../../src/sdk/generated/index";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

const filesGet: MethodMeta = {
  id: "drive.files.get",
  service: "drive",
  httpMethod: "GET",
  rootUrl: "https://www.googleapis.com/",
  servicePath: "drive/v3/",
  path: "files/{fileId}",
  pathParams: [{ name: "fileId", reserved: false }],
  queryParams: [
    { name: "alt", repeated: false },
    { name: "supportsAllDrives", repeated: false },
  ],
  requestBody: false,
  mediaDownload: true,
  scopes: [DRIVE_SCOPE],
  effect: "read",
};

const messagesGet: MethodMeta = {
  id: "gmail.users.messages.get",
  service: "gmail",
  httpMethod: "GET",
  rootUrl: "https://gmail.googleapis.com/",
  servicePath: "",
  path: "gmail/v1/users/{userId}/messages/{id}",
  pathParams: [
    { name: "userId", reserved: false },
    { name: "id", reserved: false },
  ],
  queryParams: [
    { name: "format", repeated: false },
    { name: "metadataHeaders", repeated: true },
    { name: "maxResults", repeated: false },
  ],
  requestBody: false,
  mediaDownload: false,
  scopes: ["https://mail.google.com/"],
  effect: "read",
};

/** A Discovery-style method with reserved expansion, e.g. `v1/{+name}`. */
const reservedGet: MethodMeta = {
  id: "docs.items.get",
  service: "docs",
  httpMethod: "GET",
  rootUrl: "https://docs.googleapis.com/",
  servicePath: "",
  path: "v1/{+name}",
  pathParams: [{ name: "name", reserved: true }],
  queryParams: [],
  requestBody: false,
  mediaDownload: false,
  scopes: [],
  effect: "read",
};

const permissionsCreate: MethodMeta = {
  id: "drive.permissions.create",
  service: "drive",
  httpMethod: "POST",
  rootUrl: "https://www.googleapis.com/",
  servicePath: "drive/v3/",
  path: "files/{fileId}/permissions",
  pathParams: [{ name: "fileId", reserved: false }],
  queryParams: [{ name: "sendNotificationEmail", repeated: false }],
  requestBody: true,
  mediaDownload: false,
  scopes: [DRIVE_SCOPE],
  effect: "write",
};

function thrown(fn: () => unknown): GwsError {
  try {
    fn();
  } catch (e) {
    if (e instanceof GwsError) return e;
    throw e;
  }
  throw new Error("expected a GwsError");
}

describe("buildRequest URL", () => {
  it("joins rootUrl, servicePath and the expanded path", () => {
    const req = buildRequest(filesGet, { fileId: "abc123" });
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://www.googleapis.com/drive/v3/files/abc123");
  });

  it("percent-encodes simple path params, including slashes", () => {
    const req = buildRequest(filesGet, { fileId: "a b/c?d#e%2e" });
    expect(req.url).toBe("https://www.googleapis.com/drive/v3/files/a%20b%2Fc%3Fd%23e%252e");
  });

  it("keeps slashes in reserved expansion and encodes everything else", () => {
    const req = buildRequest(reservedGet, { name: "projects/p1/items/i 1?x" });
    expect(req.url).toBe("https://docs.googleapis.com/v1/projects/p1/items/i%201%3Fx");
  });

  it("rejects a missing path param", () => {
    const e = thrown(() => buildRequest(filesGet, {}));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "fileId", reason: "missing" });
  });
});

describe("path param safety", () => {
  it.each([
    ["../x", "dot-segment"],
    ["..", "dot-segment"],
    [".", "dot-segment"],
    ["x/../y", "dot-segment"],
    ["x/./y", "dot-segment"],
    ["", "empty"],
    ["a\u0000b", "control-char"],
    ["a\nb", "control-char"],
    ["a\u007fb", "control-char"],
  ])("rejects the simple param value %j (%s)", (value, reason) => {
    const e = thrown(() => buildRequest(filesGet, { fileId: value }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "fileId", reason });
  });

  it.each([
    ["a/../b", "dot-segment"],
    ["a/./b", "dot-segment"],
    ["../../drive/v3/files/x", "dot-segment"],
    ["//evil.example/x", "empty-segment"],
    ["/abs/path", "empty-segment"],
    ["a//b", "empty-segment"],
    ["a/b/", "empty-segment"],
  ])("rejects the reserved param value %j (%s)", (value, reason) => {
    const e = thrown(() => buildRequest(reservedGet, { name: value }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "name", reason });
  });

  it.each([".evil.example/x", "@evil.example/x"])(
    "refuses a rootUrl without its trailing slash before %j could complete the host",
    (value) => {
      const meta: MethodMeta = { ...reservedGet, rootUrl: "https://docs.googleapis.com", path: "{+name}" };
      const e = thrown(() => buildRequest(meta, { name: value }));
      expect(e.code).toBe("GWS_INTERNAL");
      expect(e.details).toEqual({ reason: "bad-root-url" });
    },
  );

  it("refuses a rootUrl without its trailing slash even when the template would land on another allowed host", () => {
    const meta: MethodMeta = {
      ...filesGet,
      rootUrl: "https://docs.googleapis.co",
      servicePath: "",
      path: "m/v1/{fileId}",
      queryParams: [],
    };
    const e = thrown(() => buildRequest(meta, { fileId: "x" }));
    expect(e.code).toBe("GWS_INTERNAL");
    expect(e.details).toEqual({ reason: "bad-root-url" });
  });

  it.each(["https://www.googleapis.com", "https://www.googleapis.com/drive/", "https://www.googleapis.com:443/", "not a url"])(
    "refuses the rootUrl %j that is not exactly an origin plus a slash",
    (rootUrl) => {
      const e = thrown(() => buildRequest({ ...filesGet, rootUrl }, { fileId: "x" }));
      expect(e.code).toBe("GWS_INTERNAL");
      expect(e.details).toEqual({ reason: "bad-root-url" });
    },
  );

  it("refuses a rootUrl outside the Google allowlist", () => {
    const meta: MethodMeta = { ...filesGet, rootUrl: "https://evil.example/" };
    const e = thrown(() => buildRequest(meta, { fileId: "x" }));
    expect(e.code).toBe("GWS_INTERNAL");
    expect(e.details).toEqual({ reason: "host-not-allowed" });
  });

  it("refuses a request whose path the URL parser would rewrite", () => {
    const meta: MethodMeta = { ...filesGet, path: "files/../about/{fileId}" };
    const e = thrown(() => buildRequest(meta, { fileId: "x" }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ reason: "target-changed" });
  });
});

describe("malformed unicode", () => {
  it.each(["\uD800", "a\uDC00b", "x\uDBFF"])("rejects the path param value %j with a lone surrogate", (value) => {
    const e = thrown(() => buildRequest(filesGet, { fileId: value }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "fileId", reason: "malformed-unicode" });
  });

  it("rejects a reserved path param value with a lone surrogate", () => {
    const e = thrown(() => buildRequest(reservedGet, { name: "projects/\uDFFF" }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "name", reason: "malformed-unicode" });
  });

  it("rejects query values with a lone surrogate instead of silently replacing it", () => {
    const one = thrown(() => buildRequest(messagesGet, { userId: "me", id: "m", format: "full\uD800" }));
    expect(one.code).toBe("GWS_INVALID_INPUT");
    expect(one.details).toEqual({ param: "format", reason: "malformed-unicode" });
    const many = thrown(() => buildRequest(messagesGet, { userId: "me", id: "m", metadataHeaders: ["From", "\uDC00"] }));
    expect(many.details).toEqual({ param: "metadataHeaders", reason: "malformed-unicode" });
  });

  it("accepts well-formed astral characters", () => {
    const req = buildRequest(messagesGet, { userId: "me", id: "\u{1F600}", metadataHeaders: ["\u{1F600}"] });
    expect(req.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/%F0%9F%98%80?metadataHeaders=%F0%9F%98%80");
  });
});

describe("path values that name a literal sibling route", () => {
  const metas = generatedFns.flatMap((f) => (f.method ? [f.method] : []));
  const byId = (id: string): MethodMeta => {
    const meta = metas.find((m) => m.id === id);
    if (!meta) throw new Error(`no generated method ${id}`);
    return meta;
  };

  it("finds exactly the collisions in the generated methods", () => {
    const found: Record<string, Record<string, string[]>> = {};
    for (const [id, params] of pathCollisions(metas)) {
      found[id] = Object.fromEntries([...params].map(([name, literals]) => [name, [...literals].sort()]));
    }
    expect(found).toEqual({
      "drive.files.delete": { fileId: ["trash"] },
      "drive.files.get": { fileId: ["generateCseToken", "generateIds"] },
    });
  });

  it("matches only same-method, same-root siblings with a literal where the method has a variable", () => {
    const base = { ...filesGet, queryParams: [], mediaDownload: false };
    const collisions = pathCollisions([
      { ...base, id: "a.get", path: "items/{itemId}" },
      { ...base, id: "a.special", path: "items/special" },
      { ...base, id: "a.post", httpMethod: "POST", path: "items/other" },
      { ...base, id: "a.deep", path: "items/{itemId}/sub/{subId}" },
      { ...base, id: "a.deepLiteral", path: "items/{otherId}/sub/latest" },
      { ...base, id: "a.elsewhere", rootUrl: "https://gmail.googleapis.com/", path: "items/far" },
    ]);
    expect(Object.fromEntries([...collisions].map(([id, p]) => [id, Object.fromEntries([...p].map(([k, v]) => [k, [...v]]))]))).toEqual({
      "a.get": { itemId: ["special"] },
      "a.deep": { subId: ["latest"] },
    });
  });

  it.each([
    ["drive.files.delete", "trash"],
    ["drive.files.get", "generateIds"],
    ["drive.files.get", "generateCseToken"],
  ])("rejects %s with fileId %j", (id, fileId) => {
    const e = thrown(() => buildRequest(byId(id), { fileId }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "fileId", reason: "path-collides-with-route" });
  });

  it("still builds ordinary and near-miss values for those methods", () => {
    expect(buildRequest(byId("drive.files.delete"), { fileId: "trash2" }).url).toBe("https://www.googleapis.com/drive/v3/files/trash2");
    expect(buildRequest(byId("drive.files.delete"), { fileId: "Trash" }).url).toBe("https://www.googleapis.com/drive/v3/files/Trash");
    expect(buildRequest(byId("drive.files.emptyTrash"), {}).url).toBe("https://www.googleapis.com/drive/v3/files/trash");
    expect(buildRequest(byId("drive.permissions.list"), { fileId: "trash" }).url).toBe(
      "https://www.googleapis.com/drive/v3/files/trash/permissions",
    );
  });
});

describe("transport-owned query names", () => {
  const OWNED = ["uploadType", "upload_protocol", "access_token", "oauth_token", "key", "callback", "$.xgafv", "prettyPrint"];
  const declaring: MethodMeta = {
    ...permissionsCreate,
    queryParams: [...permissionsCreate.queryParams, ...[...OWNED, "alt"].map((name) => ({ name, repeated: false }))],
  };

  it.each([...OWNED, "alt"])("rejects %s even when a method declares it", (name) => {
    const e = thrown(() => buildRequest(declaring, { fileId: "f", [name]: "x" }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: name, reason: "transport-owned" });
  });

  it("does not let a declared uploadType duplicate the one an upload sets", () => {
    const meta: MethodMeta = {
      ...declaring,
      mediaUpload: { multipartPath: "/upload/drive/v3/files/{fileId}/permissions", simplePath: "/upload/x/{fileId}", accept: ["*/*"], maxBytes: 100 },
    };
    const e = thrown(() => buildRequest(meta, { fileId: "f", uploadType: "resumable", media: { mimeType: "text/plain", text: "x" } }));
    expect(e.details).toEqual({ param: "uploadType", reason: "transport-owned" });
  });

  it("sends nothing for a declared transport-owned name the input leaves out", () => {
    expect(buildRequest(declaring, { fileId: "f" }).url).toBe("https://www.googleapis.com/drive/v3/files/f/permissions");
  });

  it("keeps the generated alt input on downloadable methods", () => {
    expect(buildRequest(filesGet, { fileId: "f", alt: "media" }).url).toBe("https://www.googleapis.com/drive/v3/files/f?alt=media");
  });
});

describe("query params", () => {
  it("repeats array values for repeated params and stringifies scalars", () => {
    const req = buildRequest(messagesGet, {
      userId: "me",
      id: "m1",
      format: "metadata",
      metadataHeaders: ["From", "Subject"],
      maxResults: 5,
    });
    expect(req.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=metadata&metadataHeaders=From&metadataHeaders=Subject&maxResults=5",
    );
  });

  it("serializes booleans and skips undefined values", () => {
    const req = buildRequest(filesGet, { fileId: "f", supportsAllDrives: false, alt: undefined });
    expect(req.url).toBe("https://www.googleapis.com/drive/v3/files/f?supportsAllDrives=false");
  });

  it("rejects an array for a param that is not repeated", () => {
    const e = thrown(() => buildRequest(filesGet, { fileId: "f", alt: ["json", "media"] }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "alt", reason: "not-repeated" });
  });

  it("rejects an object query value", () => {
    const e = thrown(() => buildRequest(filesGet, { fileId: "f", alt: { x: 1 } }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "alt", reason: "not-scalar" });
  });

  it("never sends account or media as params, even if a method declared them", () => {
    const meta: MethodMeta = {
      ...filesGet,
      queryParams: [...filesGet.queryParams, { name: "account", repeated: false }, { name: "media", repeated: false }],
    };
    const req = buildRequest(meta, { fileId: "f", account: "work", alt: "json" });
    expect(req.url).toBe("https://www.googleapis.com/drive/v3/files/f?alt=json");
    expect(req.url).not.toContain("account");
  });

  it("ignores input keys the method does not declare", () => {
    const req = buildRequest(filesGet, { fileId: "f", uploadType: "resumable", fields: "*" });
    expect(req.url).toBe("https://www.googleapis.com/drive/v3/files/f");
  });
});

describe("headers and body", () => {
  it("sends requestBody as JSON and the bearer token as Authorization", () => {
    const req = buildRequest(
      permissionsCreate,
      { fileId: "f1", sendNotificationEmail: false, requestBody: { type: "anyone", role: "reader" }, account: "a@fake.test" },
      { accessToken: "ya29.test-token" },
    );
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://www.googleapis.com/drive/v3/files/f1/permissions?sendNotificationEmail=false");
    expect(req.headers.authorization).toBe("Bearer ya29.test-token");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body).toBe(JSON.stringify({ type: "anyone", role: "reader" }));
  });

  it("has no Authorization header without a token and no body without requestBody", () => {
    const req = buildRequest(filesGet, { fileId: "f" });
    expect(req.headers.authorization).toBeUndefined();
    expect(req.body).toBeUndefined();
  });

  it("rejects a requestBody for a method that takes none", () => {
    const e = thrown(() => buildRequest(filesGet, { fileId: "f", requestBody: {} }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "requestBody", reason: "not-accepted" });
  });

  it("rejects a non-object input", () => {
    expect(thrown(() => buildRequest(filesGet, null)).code).toBe("GWS_INVALID_INPUT");
    expect(thrown(() => buildRequest(filesGet, ["x"])).code).toBe("GWS_INVALID_INPUT");
  });
});

describe("describeRequest", () => {
  it("returns the plan view without the Authorization header", () => {
    const req = buildRequest(
      permissionsCreate,
      { fileId: "f1", sendNotificationEmail: true, requestBody: { type: "anyone", role: "reader" } },
      { accessToken: "ya29.secret-token-value" },
    );
    const plan = describeRequest(req);
    expect(plan).toEqual({
      method: "POST",
      url: "https://www.googleapis.com/drive/v3/files/f1/permissions",
      query: { sendNotificationEmail: "true" },
      body: { type: "anyone", role: "reader" },
    });
    expect(JSON.stringify(plan)).not.toContain("secret-token-value");
  });

  it("groups repeated query values into arrays", () => {
    const plan = describeRequest(buildRequest(messagesGet, { userId: "me", id: "m", metadataHeaders: ["A", "B"] }));
    expect(plan.query).toEqual({ metadataHeaders: ["A", "B"] });
    expect(plan.body).toBeUndefined();
  });
});
