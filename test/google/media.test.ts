import { afterEach, describe, expect, it, vi } from "vitest";
import type { MethodMeta } from "../../src/contracts";
import { GwsError } from "../../src/errors";
import {
  SIMPLE_UPLOAD_MAX_BYTES,
  base64ToBytes,
  bytesToBase64,
  mediaResult,
  wantsMediaDownload,
} from "../../src/google/media";
import { buildRequest, describeRequest } from "../../src/google/request";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

const filesCreate: MethodMeta = {
  id: "drive.files.create",
  service: "drive",
  httpMethod: "POST",
  rootUrl: "https://www.googleapis.com/",
  servicePath: "drive/v3/",
  path: "files",
  pathParams: [],
  queryParams: [{ name: "supportsAllDrives", repeated: false }],
  requestBody: true,
  mediaUpload: {
    multipartPath: "/upload/drive/v3/files",
    simplePath: "/upload/drive/v3/files",
    accept: ["*/*"],
    maxBytes: 5497558138880,
  },
  mediaDownload: false,
  scopes: [DRIVE_SCOPE],
  effect: "write",
};

const filesUpdate: MethodMeta = {
  ...filesCreate,
  id: "drive.files.update",
  httpMethod: "PATCH",
  path: "files/{fileId}",
  pathParams: [{ name: "fileId", reserved: false }],
  mediaUpload: {
    multipartPath: "/upload/drive/v3/files/{fileId}",
    simplePath: "/upload/drive/v3/files/{fileId}",
    accept: ["*/*"],
    maxBytes: 5497558138880,
  },
};

const filesGet: MethodMeta = {
  ...filesCreate,
  id: "drive.files.get",
  httpMethod: "GET",
  path: "files/{fileId}",
  pathParams: [{ name: "fileId", reserved: false }],
  queryParams: [{ name: "alt", repeated: false }],
  requestBody: false,
  mediaUpload: undefined,
  mediaDownload: true,
  effect: "read",
};

const filesExport: MethodMeta = {
  ...filesGet,
  id: "drive.files.export",
  path: "files/{fileId}/export",
  queryParams: [{ name: "mimeType", repeated: false }],
};

const dec = new TextDecoder();

function bodyBytes(body: string | Uint8Array | undefined): Uint8Array {
  if (body === undefined) throw new Error("expected a body");
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

function thrown(fn: () => unknown): GwsError {
  try {
    fn();
  } catch (e) {
    if (e instanceof GwsError) return e;
    throw e;
  }
  throw new Error("expected a GwsError");
}

describe("multipart upload", () => {
  it("frames metadata and media byte-exactly with the given boundary", () => {
    const req = buildRequest(
      filesCreate,
      { requestBody: { name: "notes.txt" }, media: { mimeType: "text/plain", text: "hello\r\nworld" } },
      { accessToken: "ya29.t", boundary: "BOUNDARY" },
    );
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart");
    expect(req.headers["content-type"]).toBe("multipart/related; boundary=BOUNDARY");
    expect(req.headers.authorization).toBe("Bearer ya29.t");
    expect(dec.decode(bodyBytes(req.body))).toBe(
      "--BOUNDARY\r\n" +
        "Content-Type: application/json; charset=UTF-8\r\n" +
        "\r\n" +
        '{"name":"notes.txt"}\r\n' +
        "--BOUNDARY\r\n" +
        "Content-Type: text/plain\r\n" +
        "\r\n" +
        "hello\r\nworld\r\n" +
        "--BOUNDARY--",
    );
  });

  it("keeps binary media bytes intact", () => {
    const bytes = Uint8Array.from([0, 1, 2, 13, 10, 45, 45, 127, 128, 254, 255]);
    const req = buildRequest(
      filesCreate,
      { requestBody: {}, media: { mimeType: "application/octet-stream", dataBase64: bytesToBase64(bytes) } },
      { boundary: "B" },
    );
    const body = bodyBytes(req.body);
    const head = new TextEncoder().encode(
      "--B\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n--B\r\nContent-Type: application/octet-stream\r\n\r\n",
    );
    expect(body.subarray(0, head.length)).toEqual(head);
    expect(body.subarray(head.length, head.length + bytes.length)).toEqual(bytes);
    expect(dec.decode(body.subarray(head.length + bytes.length))).toBe("\r\n--B--");
  });

  it("generates a fresh random boundary by default", () => {
    const input = { requestBody: {}, media: { mimeType: "text/plain", text: "x" } };
    const a = buildRequest(filesCreate, input).headers["content-type"];
    const b = buildRequest(filesCreate, input).headers["content-type"];
    expect(a).toMatch(/^multipart\/related; boundary=[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("expands path params in the upload path and keeps declared query params", () => {
    const req = buildRequest(
      filesUpdate,
      { fileId: "f 1", supportsAllDrives: true, requestBody: {}, media: { mimeType: "text/plain", text: "x" } },
      { boundary: "B" },
    );
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe("https://www.googleapis.com/upload/drive/v3/files/f%201?uploadType=multipart&supportsAllDrives=true");
  });
});

describe("simple upload", () => {
  it("sends media alone with uploadType=media on the simple path", () => {
    const req = buildRequest(filesCreate, { media: { mimeType: "text/csv", text: "a,b\n1,2\n" } });
    expect(req.url).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=media");
    expect(req.headers["content-type"]).toBe("text/csv");
    expect(dec.decode(bodyBytes(req.body))).toBe("a,b\n1,2\n");
  });
});

describe("upload limits and validation", () => {
  it("rejects media larger than the method maximum", () => {
    const meta: MethodMeta = { ...filesCreate, mediaUpload: { ...filesCreate.mediaUpload!, maxBytes: 10 } };
    const e = thrown(() => buildRequest(meta, { media: { mimeType: "text/plain", text: "12345678901" } }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "media", reason: "too-large", bytes: 11, max: 10 });
  });

  it("accepts media exactly at the method maximum", () => {
    const meta: MethodMeta = { ...filesCreate, mediaUpload: { ...filesCreate.mediaUpload!, maxBytes: 10 } };
    expect(() => buildRequest(meta, { media: { mimeType: "text/plain", text: "1234567890" } })).not.toThrow();
  });

  it("rejects media that only a resumable upload could carry", () => {
    const big = bytesToBase64(new Uint8Array(SIMPLE_UPLOAD_MAX_BYTES + 1));
    const e = thrown(() => buildRequest(filesCreate, { media: { mimeType: "application/octet-stream", dataBase64: big } }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "media", reason: "resumable-only", bytes: SIMPLE_UPLOAD_MAX_BYTES + 1, max: SIMPLE_UPLOAD_MAX_BYTES });
  });

  describe("size is checked before decoding", () => {
    afterEach(() => vi.restoreAllMocks());
    const small: MethodMeta = { ...filesCreate, mediaUpload: { ...filesCreate.mediaUpload!, maxBytes: 10 } };

    it("rejects oversized base64 from its encoded length without decoding it", () => {
      const atob = vi.spyOn(globalThis, "atob");
      const e = thrown(() => buildRequest(small, { media: { mimeType: "text/plain", dataBase64: "QUJD".repeat(4) } }));
      expect(e.details).toEqual({ param: "media", reason: "too-large", bytes: 12, max: 10 });
      expect(atob).not.toHaveBeenCalled();
    });

    it("rejects base64 beyond the simple-upload limit without decoding it", () => {
      const atob = vi.spyOn(globalThis, "atob");
      const big = "A".repeat(Math.ceil(((SIMPLE_UPLOAD_MAX_BYTES + 1) * 4) / 3));
      const e = thrown(() => buildRequest(filesCreate, { media: { mimeType: "application/octet-stream", dataBase64: big } }));
      expect(e.details).toEqual({ param: "media", reason: "resumable-only", bytes: SIMPLE_UPLOAD_MAX_BYTES + 1, max: SIMPLE_UPLOAD_MAX_BYTES });
      expect(atob).not.toHaveBeenCalled();
    });

    it("rejects oversized text from its UTF-8 length without encoding it", () => {
      const encode = vi.spyOn(TextEncoder.prototype, "encode");
      const e = thrown(() => buildRequest(small, { media: { mimeType: "text/plain", text: "\u00e9\u{1F600}\u4e2dab" } }));
      expect(e.details).toEqual({ param: "media", reason: "too-large", bytes: 11, max: 10 });
      expect(encode).not.toHaveBeenCalled();
    });

    it("computes exact sizes, so padded base64 and multi-byte text at the limit still pass", () => {
      expect(buildRequest(small, { media: { mimeType: "text/plain", dataBase64: "MTIzNDU2Nzg5MA==" } }).plan.body).toEqual({
        media: { mimeType: "text/plain", bytes: 10 },
      });
      expect(buildRequest(small, { media: { mimeType: "text/plain", text: "\u{1F600}\u4e2d\u00e9a" } }).plan.body).toEqual({
        media: { mimeType: "text/plain", bytes: 10 },
      });
      // A lone surrogate encodes as U+FFFD (3 bytes).
      expect(buildRequest(small, { media: { mimeType: "text/plain", text: "\uD8001234567" } }).plan.body).toEqual({
        media: { mimeType: "text/plain", bytes: 10 },
      });
    });
  });

  it("rejects media for a method without media upload", () => {
    const e = thrown(() => buildRequest(filesGet, { fileId: "f", media: { mimeType: "text/plain", text: "x" } }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "media", reason: "not-accepted" });
  });

  it.each(["text/plain\r\nX-Injected: 1", "text/plain\nX: 1", "text", "", "text/plain; charset=\"a\r\n\"", "a/b c"])(
    "rejects the media mimeType %j so it cannot inject headers",
    (mimeType) => {
      const e = thrown(() => buildRequest(filesCreate, { requestBody: {}, media: { mimeType, text: "x" } }));
      expect(e.code).toBe("GWS_INVALID_INPUT");
      expect(e.details).toEqual({ param: "media", reason: "bad-mime-type" });
    },
  );

  it.each([
    "text/plain\r\n;a=b",
    "text/plain\r\n\r\n;a=b",
    "text/plain\u000b;a=b",
    "text/plain\u000c;a=b",
    "text/plain\u2028;a=b",
    "text/plain\u2029;a=b",
    "text/plain\u00a0;a=b",
    "text/plain;\r\na=b",
    'text/plain; a="x\u000by"',
    'text/plain; a="x\u2028y"',
    'text/plain; a="x\u00a0y"',
  ])("rejects the mimeType %j whose whitespace is not a space or tab", (mimeType) => {
    const e = thrown(() => buildRequest(filesCreate, { requestBody: {}, media: { mimeType, text: "x" } }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "media", reason: "bad-mime-type" });
  });

  it.each(["text/plain ; a=b", "text/plain\t;\ta=b", 'text/plain; a="x y\tz"'])("accepts the mimeType %j with spaces or tabs", (mimeType) => {
    expect(() => buildRequest(filesCreate, { media: { mimeType, text: "x" } })).not.toThrow();
  });

  it("accepts a mimeType with parameters", () => {
    const req = buildRequest(filesCreate, { media: { mimeType: 'text/plain; charset="utf-8"', text: "x" } });
    expect(req.headers["content-type"]).toBe('text/plain; charset="utf-8"');
  });

  it("rejects a mimeType outside the method's accept list", () => {
    const meta: MethodMeta = { ...filesCreate, mediaUpload: { ...filesCreate.mediaUpload!, accept: ["image/*", "application/pdf"] } };
    const e = thrown(() => buildRequest(meta, { media: { mimeType: "text/plain", text: "x" } }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details).toEqual({ param: "media", reason: "mime-type-not-accepted" });
    expect(() => buildRequest(meta, { media: { mimeType: "image/png", text: "x" } })).not.toThrow();
    expect(() => buildRequest(meta, { media: { mimeType: "Application/PDF", text: "x" } })).not.toThrow();
  });

  it.each([
    [{ mimeType: "text/plain" }],
    [{ mimeType: "text/plain", text: "a", dataBase64: "YQ==" }],
    [{ mimeType: "text/plain", dataBase64: "not base64!" }],
    [{ mimeType: "text/plain", dataBase64: "abcde" }],
    [{ text: "x" }],
    ["just a string"],
  ])("rejects the malformed media input %j", (media) => {
    const e = thrown(() => buildRequest(filesCreate, { media }));
    expect(e.code).toBe("GWS_INVALID_INPUT");
    expect(e.details?.param).toBe("media");
  });

  it("shows media as {mimeType, bytes} in the plan view, never the bytes", () => {
    const req = buildRequest(
      filesCreate,
      { requestBody: { name: "n" }, media: { mimeType: "text/plain", dataBase64: bytesToBase64(new TextEncoder().encode("SECRET-BYTES")) } },
      { accessToken: "ya29.plan-token" },
    );
    const plan = describeRequest(req);
    expect(plan).toEqual({
      method: "POST",
      url: "https://www.googleapis.com/upload/drive/v3/files",
      query: { uploadType: "multipart" },
      body: { metadata: { name: "n" }, media: { mimeType: "text/plain", bytes: 12 } },
    });
    const text = JSON.stringify(plan);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain(bytesToBase64(new TextEncoder().encode("SECRET-BYTES")));
    expect(text).not.toContain("plan-token");
  });

  it("shows a simple upload in the plan view without metadata", () => {
    const plan = describeRequest(buildRequest(filesCreate, { media: { mimeType: "text/plain", text: "abc" } }));
    expect(plan.body).toEqual({ media: { mimeType: "text/plain", bytes: 3 } });
  });
});

describe("download", () => {
  it("turns bytes into {mimeType, sizeBytes, dataBase64}", () => {
    const bytes = Uint8Array.from([37, 80, 68, 70, 0, 255]);
    const out = mediaResult(bytes, "application/pdf; charset=binary");
    expect(out).toEqual({ mimeType: "application/pdf", sizeBytes: 6, dataBase64: bytesToBase64(bytes) });
    expect(base64ToBytes(out.dataBase64)).toEqual(bytes);
  });

  it("defaults the mimeType when the response has none", () => {
    expect(mediaResult(new Uint8Array(0), null)).toEqual({ mimeType: "application/octet-stream", sizeBytes: 0, dataBase64: "" });
  });

  it("decides media responses from alt=media or a media-only method", () => {
    expect(wantsMediaDownload(filesGet, { alt: "media" })).toBe(true);
    expect(wantsMediaDownload(filesGet, { alt: "json" })).toBe(false);
    expect(wantsMediaDownload(filesGet, {})).toBe(false);
    expect(wantsMediaDownload(filesExport, { mimeType: "application/pdf" })).toBe(true);
    expect(wantsMediaDownload(filesCreate, { alt: "media" })).toBe(false);
  });
});

describe("base64 helpers", () => {
  it("match btoa for small inputs", () => {
    for (const s of ["", "f", "fo", "foo", "foob", "fooba", "foobar"]) {
      const bytes = new TextEncoder().encode(s);
      expect(bytesToBase64(bytes)).toBe(btoa(s));
      expect(dec.decode(base64ToBytes(btoa(s)))).toBe(s);
    }
  });

  it("round-trip large binary input across chunk boundaries", () => {
    const bytes = new Uint8Array(200_003);
    for (let i = 0; i < bytes.length; i += 65_536) crypto.getRandomValues(bytes.subarray(i, i + 65_536));
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("accepts the URL-safe alphabet and missing padding", () => {
    expect(base64ToBytes("-_8")).toEqual(Uint8Array.from([251, 255]));
    expect(base64ToBytes("+/8=")).toEqual(Uint8Array.from([251, 255]));
  });

  it("rejects invalid base64", () => {
    expect(() => base64ToBytes("a b")).toThrow(GwsError);
    expect(() => base64ToBytes("abcde")).toThrow(GwsError);
    expect(() => base64ToBytes("ab=c")).toThrow(GwsError);
  });
});
