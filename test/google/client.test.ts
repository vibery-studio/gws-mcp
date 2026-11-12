import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import type { MethodMeta } from "../../src/contracts";
import { GwsError } from "../../src/errors";
import { callGoogle } from "../../src/google/client";
import { generatedFns } from "../../src/sdk/generated/index";
import { bytesToBase64 } from "../../src/google/media";
import { googleOAuth } from "../../src/google/oauth";
import { createTransport, type Transport } from "../../src/google/transport";
import { authorizeAtFake } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const GMAIL_RO = "https://www.googleapis.com/auth/gmail.readonly";

const filesCreate: MethodMeta = {
  id: "drive.files.create",
  service: "drive",
  httpMethod: "POST",
  rootUrl: "https://www.googleapis.com/",
  servicePath: "drive/v3/",
  path: "files",
  pathParams: [],
  queryParams: [],
  requestBody: true,
  mediaUpload: {
    multipartPath: "/upload/drive/v3/files",
    simplePath: "/upload/drive/v3/files",
    accept: ["*/*"],
    maxBytes: 5497558138880,
  },
  mediaDownload: false,
  scopes: [DRIVE_FILE],
  effect: "write",
};

const filesGet: MethodMeta = {
  id: "drive.files.get",
  service: "drive",
  httpMethod: "GET",
  rootUrl: "https://www.googleapis.com/",
  servicePath: "drive/v3/",
  path: "files/{fileId}",
  pathParams: [{ name: "fileId", reserved: false }],
  queryParams: [{ name: "alt", repeated: false }],
  requestBody: false,
  mediaDownload: true,
  scopes: [DRIVE_FILE],
  effect: "read",
};

const filesDelete: MethodMeta = {
  ...filesGet,
  id: "drive.files.delete",
  httpMethod: "DELETE",
  queryParams: [],
  mediaDownload: false,
  effect: "write",
};

const transport = createTransport(env, loadConfig(env));
const MAX = 1_000_000;

/** A fresh fake account and a real fake access token for it, minted through the OAuth code exchange. */
async function account(scopes: string[]): Promise<{ email: string; accessToken: string }> {
  const email = uniqueEmail("client");
  await fake.seed({ accounts: [{ email, sub: `sub-${crypto.randomUUID()}` }] });
  const tokens = await googleOAuth(env, transport).exchangeCode(await authorizeAtFake({ email, scopes }));
  return { email, accessToken: tokens.accessToken };
}

async function rejection(p: Promise<unknown>): Promise<GwsError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof GwsError) return e;
    throw e;
  }
  throw new Error("expected a GwsError");
}

describe("callGoogle end to end against the fake", () => {
  it("uploads media with drive.files.create, then files.get alt=media returns the same bytes", async () => {
    const { accessToken } = await account([DRIVE_FILE]);
    const bytes = Uint8Array.from([0, 1, 2, 3, 13, 10, 45, 45, 200, 255]);
    const created = (await callGoogle(
      filesCreate,
      { requestBody: { name: "bytes.bin" }, media: { mimeType: "application/octet-stream", dataBase64: bytesToBase64(bytes) } },
      { accessToken, transport, maxResponseBytes: MAX },
    )) as { id: string; name: string; mimeType: string };
    expect(created).toMatchObject({ kind: "drive#file", name: "bytes.bin", mimeType: "application/octet-stream" });

    const media = await callGoogle(filesGet, { fileId: created.id, alt: "media" }, { accessToken, transport, maxResponseBytes: MAX });
    expect(media).toEqual({ mimeType: "application/octet-stream", sizeBytes: bytes.length, dataBase64: bytesToBase64(bytes) });

    const meta = await callGoogle(filesGet, { fileId: created.id }, { accessToken, transport, maxResponseBytes: MAX });
    expect(meta).toEqual({ kind: "drive#file", id: created.id, name: "bytes.bin", mimeType: "application/octet-stream" });
  });

  it("returns {} for an empty success body", async () => {
    const { accessToken } = await account([DRIVE_FILE]);
    const created = (await callGoogle(filesCreate, { requestBody: { name: "gone" } }, { accessToken, transport, maxResponseBytes: MAX })) as { id: string };
    expect(await callGoogle(filesDelete, { fileId: created.id }, { accessToken, transport, maxResponseBytes: MAX })).toEqual({});
  });

  it("maps an upstream 404 to GWS_UPSTREAM_ERROR", async () => {
    const { accessToken } = await account([DRIVE_FILE]);
    const e = await rejection(callGoogle(filesGet, { fileId: "missing-file" }, { accessToken, transport, maxResponseBytes: MAX }));
    expect(e.code).toBe("GWS_UPSTREAM_ERROR");
    expect(e.details).toEqual({ status: 404, reason: "notFound", googleStatus: "NOT_FOUND" });
  });

  it("maps a token without the method's scope to GWS_SCOPE_MISSING", async () => {
    const { accessToken } = await account([GMAIL_RO]);
    const e = await rejection(callGoogle(filesGet, { fileId: "x" }, { accessToken, transport, maxResponseBytes: MAX }));
    expect(e.code).toBe("GWS_SCOPE_MISSING");
  });

  it("passes an injected fault through the error map unchanged", async () => {
    const { email, accessToken } = await account([DRIVE_FILE]);
    await fake.fault({
      email,
      method: "GET",
      pathRegex: "^/www\\.googleapis\\.com/drive/v3/files/",
      times: 1,
      response: {
        status: 500,
        body: {
          error: {
            code: 500,
            message: "Internal error with private detail",
            status: "INTERNAL",
            details: [{ "@type": "type.googleapis.com/google.rpc.RequestInfo", requestId: "fault-req-1" }],
            errors: [{ reason: "backendError", message: "private detail" }],
          },
        },
      },
    });
    const e = await rejection(callGoogle(filesGet, { fileId: "x" }, { accessToken, transport, maxResponseBytes: MAX }));
    expect(e.code).toBe("GWS_UPSTREAM_ERROR");
    expect(e.details).toEqual({ status: 500, reason: "backendError", googleStatus: "INTERNAL", requestId: "fault-req-1" });
    expect(e.message).not.toContain("private");
  });
});

describe("callGoogle never sends a path value that names a sibling route", () => {
  it("refuses drive.files.delete with fileId \"trash\", so the fake's trash is not emptied", async () => {
    const DRIVE = "https://www.googleapis.com/auth/drive";
    const email = uniqueEmail("collide");
    await fake.seed({ accounts: [{ email, sub: `sub-${crypto.randomUUID()}`, preset: "default" }] });
    const { accessToken } = await googleOAuth(env, transport).exchangeCode(await authorizeAtFake({ email, scopes: [DRIVE] }));
    const filesDeleteMeta = generatedFns.find((f) => f.name === "drive.files.delete")?.method;
    if (!filesDeleteMeta) throw new Error("no generated drive.files.delete");
    const trashed = async () =>
      Object.entries((await fake.state(email)).resources)
        .filter(([k, v]) => k.startsWith(`drive:file:${email}:`) && (v as { trashed?: boolean }).trashed === true)
        .map(([k]) => k);
    const before = await trashed();
    expect(before.length).toBeGreaterThan(0);

    const e = await rejection(callGoogle(filesDeleteMeta, { fileId: "trash" }, { accessToken, transport, maxResponseBytes: MAX }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "fileId", reason: "path-collides-with-route" });
    expect(await trashed()).toEqual(before);
  });
});

/** A body of `chunks` chunks of `size` bytes that counts how many chunks the reader actually pulled. */
function countingBody(chunks: number, size: number): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled >= chunks) return controller.close();
        pulled++;
        controller.enqueue(new Uint8Array(size).fill(0x20));
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled };
}

describe("callGoogle response size cap", () => {
  const stub = (res: () => Response): Transport => async () => res();

  it("stops reading a success body once it passes maxResponseBytes", async () => {
    const body = countingBody(1000, 1024);
    const e = await rejection(
      callGoogle(filesGet, { fileId: "x" }, { accessToken: "t", maxResponseBytes: 4096, transport: stub(() => new Response(body.stream)) }),
    );
    expect(e.code).toBe("GWS_RESPONSE_TOO_LARGE");
    expect(e.details).toMatchObject({ scope: "call", status: 200, max: 4096 });
    expect(body.pulled()).toBeLessThanOrEqual(8);
  });

  it("stops reading an error body once it passes maxResponseBytes", async () => {
    const body = countingBody(1000, 1024);
    const e = await rejection(
      callGoogle(filesGet, { fileId: "x" }, {
        accessToken: "t",
        maxResponseBytes: 4096,
        transport: stub(() => new Response(body.stream, { status: 500 })),
      }),
    );
    expect(e.code).toBe("GWS_RESPONSE_TOO_LARGE");
    expect(e.details).toMatchObject({ scope: "call", status: 500, max: 4096 });
    expect(body.pulled()).toBeLessThanOrEqual(8);
  });

  it("stops reading a media download once it passes maxResponseBytes", async () => {
    const body = countingBody(1000, 1024);
    const e = await rejection(
      callGoogle(filesGet, { fileId: "x", alt: "media" }, {
        accessToken: "t",
        maxResponseBytes: 4096,
        transport: stub(() => new Response(body.stream, { headers: { "content-type": "application/pdf" } })),
      }),
    );
    expect(e.code).toBe("GWS_RESPONSE_TOO_LARGE");
    expect(body.pulled()).toBeLessThanOrEqual(8);
  });

  it("refuses a declared Content-Length over the cap before reading the body", async () => {
    const body = countingBody(1000, 1024);
    const e = await rejection(
      callGoogle(filesGet, { fileId: "x" }, {
        accessToken: "t",
        maxResponseBytes: 4096,
        transport: stub(() => new Response(body.stream, { headers: { "content-length": "1024000" } })),
      }),
    );
    expect(e.code).toBe("GWS_RESPONSE_TOO_LARGE");
    expect(e.details).toEqual({ scope: "call", status: 200, bytes: 1024000, max: 4096 });
    expect(body.pulled()).toBe(0);
  });

  it("returns a body exactly at the cap", async () => {
    const text = JSON.stringify({ id: "x", pad: "y".repeat(100) });
    const out = await callGoogle(filesGet, { fileId: "x" }, {
      accessToken: "t",
      maxResponseBytes: new TextEncoder().encode(text).length,
      transport: stub(() => new Response(text)),
    });
    expect(out).toEqual(JSON.parse(text));
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses the maxResponseBytes %s", async (maxResponseBytes) => {
    const e = await rejection(callGoogle(filesGet, { fileId: "x" }, { accessToken: "t", maxResponseBytes, transport: stub(() => Response.json({})) }));
    expect(e.code).toBe("GWS_INTERNAL");
  });
});

describe("callGoogle response handling", () => {
  const stub = (res: () => Response): Transport => async () => res();

  it("rejects a non-JSON success body as GWS_RESPONSE_SHAPE", async () => {
    const e = await rejection(callGoogle(filesGet, { fileId: "x" }, { accessToken: "t", transport: stub(() => new Response("<html>")), maxResponseBytes: MAX }));
    expect(e.code).toBe("GWS_RESPONSE_SHAPE");
    expect(e.details).toEqual({ status: 200 });
  });

  it("treats a redirect as an upstream error instead of following it", async () => {
    const e = await rejection(
      callGoogle(filesGet, { fileId: "x" }, {
        accessToken: "t",
        maxResponseBytes: MAX,
        transport: stub(() => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })),
      }),
    );
    expect(e.code).toBe("GWS_UPSTREAM_ERROR");
    expect(e.details).toEqual({ status: 302 });
  });

  it("maps a thrown network error to GWS_UPSTREAM_ERROR without its message and calls once", async () => {
    let calls = 0;
    const e = await rejection(
      callGoogle(filesCreate, { requestBody: {} }, {
        accessToken: "t",
        maxResponseBytes: MAX,
        transport: async () => {
          calls++;
          throw new TypeError("connect ECONNREFUSED secret-host");
        },
      }),
    );
    expect(calls).toBe(1);
    expect(e.code).toBe("GWS_UPSTREAM_ERROR");
    expect(e.message).not.toContain("secret-host");
  });

  it("lets a GwsError from the transport through unchanged", async () => {
    const original = new GwsError("GWS_INTERNAL", "upstream host not allowed");
    const e = await rejection(
      callGoogle(filesGet, { fileId: "x" }, {
        accessToken: "t",
        maxResponseBytes: MAX,
        transport: async () => {
          throw original;
        },
      }),
    );
    expect(e).toBe(original);
  });

  it("sends the bearer token and never follows redirects", async () => {
    let seen: RequestInit | undefined;
    await callGoogle(filesGet, { fileId: "x" }, {
      accessToken: "ya29.abc",
      maxResponseBytes: MAX,
      transport: async (_url, init) => {
        seen = init;
        return Response.json({ id: "x" });
      },
    });
    expect(new Headers(seen?.headers).get("authorization")).toBe("Bearer ya29.abc");
    expect(seen?.redirect).toBe("manual");
  });

  it("requires an access token", async () => {
    const e = await rejection(callGoogle(filesGet, { fileId: "x" }, { accessToken: "", transport: stub(() => Response.json({})), maxResponseBytes: MAX }));
    expect(e.code).toBe("GWS_INTERNAL");
  });
});

describe("callGoogle: Google Ads headers", () => {
  const listCustomers = generatedFns.find((f) => f.name === "googleads.customers.listAccessibleCustomers")?.method;
  const ads = { developerToken: "FAKE-dev-token-client-test", loginCustomerId: "5550001111" };

  function capture(): { transport: Transport; headers: Headers[] } {
    const headers: Headers[] = [];
    return { headers, transport: async (_url, init) => (headers.push(new Headers(init?.headers)), Response.json({})) };
  }

  it("adds developer-token and login-customer-id to a Google Ads request", async () => {
    if (!listCustomers) throw new Error("no Ads method");
    const c = capture();
    await callGoogle(listCustomers, {}, { accessToken: "t", transport: c.transport, maxResponseBytes: MAX, ads });
    expect([c.headers[0]?.get("developer-token"), c.headers[0]?.get("login-customer-id")]).toEqual([ads.developerToken, ads.loginCustomerId]);
    const noLogin = capture();
    await callGoogle(listCustomers, {}, { accessToken: "t", transport: noLogin.transport, maxResponseBytes: MAX, ads: { developerToken: ads.developerToken } });
    expect(noLogin.headers[0]?.has("login-customer-id")).toBe(false);
  });

  it("never adds them to a request for another host, even when given", async () => {
    const c = capture();
    await callGoogle(filesGet, { fileId: "x" }, { accessToken: "t", transport: c.transport, maxResponseBytes: MAX, ads });
    expect([c.headers[0]?.has("developer-token"), c.headers[0]?.has("login-customer-id")]).toEqual([false, false]);
  });

  it("refuses a Google Ads request without a developer token before sending it", async () => {
    if (!listCustomers) throw new Error("no Ads method");
    for (const given of [undefined, { developerToken: "" }]) {
      const c = capture();
      const e = await rejection(callGoogle(listCustomers, {}, { accessToken: "t", transport: c.transport, maxResponseBytes: MAX, ...(given ? { ads: given } : {}) }));
      expect(e.code).toBe("GWS_ADS_DEVELOPER_TOKEN_MISSING");
      expect(c.headers).toEqual([]);
    }
  });
});
