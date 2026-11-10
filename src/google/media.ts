import type { MethodMeta } from "../contracts";
import { GwsError } from "../errors";

/** Media as returned by downloads: the shape of the generated `MediaContent` output. */
export interface MediaResult {
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
}

/**
 * Google serves simple and multipart uploads up to 5 MB; anything larger needs the resumable protocol,
 * which this layer does not implement.
 */
export const SIMPLE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

export interface UploadBody {
  /** Upload path template relative to `rootUrl`, without the leading "/". */
  pathTemplate: string;
  uploadType: "multipart" | "media";
  contentType: string;
  body: Uint8Array;
  media: { mimeType: string; bytes: number };
}

const enc = new TextEncoder();

function invalid(reason: string, extra: Record<string, unknown> = {}): GwsError {
  return new GwsError("GWS_INVALID_INPUT", `invalid media: ${reason}`, { details: { param: "media", reason, ...extra } });
}

// ---------- base64 without Node Buffer ----------

/** Multiple of 3, so per-chunk encodings concatenate without inner padding. */
const B64_CHUNK = 3 * 4096;

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    out += btoa(String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK)));
  }
  return out;
}

const B64_RE = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** Decodes standard or URL-safe base64, padding optional. Throws GWS_INVALID_INPUT on anything else. */
export function base64ToBytes(text: string): Uint8Array {
  const bare = text.replace(/=+$/, "");
  if (!B64_RE.test(text) || bare.length % 4 === 1) throw invalid("bad-base64");
  const normal = bare.replace(/-/g, "+").replace(/_/g, "/");
  let bin: string;
  try {
    bin = atob(normal + "=".repeat((4 - (normal.length % 4)) % 4));
  } catch {
    throw invalid("bad-base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- upload ----------

const TOKEN = "[A-Za-z0-9!#$&^_.+-]+";
/** HTTP quoted-string text: tab, space and visible ASCII except the quote and the backslash. */
const QUOTED = '"[\\t\\x20\\x21\\x23-\\x5b\\x5d-\\x7e]*"';
/**
 * `type/subtype` plus optional `; name=value` parameters. The only whitespace allowed is space and tab (HTTP OWS),
 * so no CR, LF, vertical tab, Unicode line separator or NBSP can end or fold the header the mimeType lands in.
 */
const MIME_RE = new RegExp(`^${TOKEN}/${TOKEN}(?:[ \\t]*;[ \\t]*${TOKEN}=(?:${TOKEN}|${QUOTED}))*$`);

function baseType(mimeType: string): string {
  return (mimeType.split(";")[0] ?? "").trim().toLowerCase();
}

function accepts(accept: readonly string[], mimeType: string): boolean {
  const [type] = baseType(mimeType).split("/");
  return accept.some((a) => {
    const p = a.toLowerCase();
    return p === "*/*" || p === baseType(mimeType) || (p.endsWith("/*") && p.slice(0, -2) === type);
  });
}

/** Decoded size of base64 text from its length alone (padding stripped), without decoding it. */
function base64DecodedLength(text: string): number {
  let bare = text.length;
  while (bare > 0 && text.charCodeAt(bare - 1) === 0x3d /* = */) bare--;
  return Math.floor((bare * 3) / 4);
}

/** UTF-8 length of `text` as TextEncoder would encode it (a lone surrogate becomes U+FFFD, 3 bytes), without encoding it. */
function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Throws unless `bytes` fits both the method's maximum and the simple-upload limit. */
function checkSize(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes) throw invalid("too-large", { bytes, max: maxBytes });
  if (bytes > SIMPLE_UPLOAD_MAX_BYTES) throw invalid("resumable-only", { bytes, max: SIMPLE_UPLOAD_MAX_BYTES });
}

/** Validates the media input and checks its size from the encoded form before allocating the decoded bytes. */
function parseMediaInput(value: unknown, maxBytes: number): { mimeType: string; bytes: Uint8Array } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("not-object");
  const { mimeType, dataBase64, text } = value as Record<string, unknown>;
  if (typeof mimeType !== "string") throw invalid("bad-mime-type");
  if (!MIME_RE.test(mimeType)) throw invalid("bad-mime-type");
  const hasData = typeof dataBase64 === "string";
  const hasText = typeof text === "string";
  if (hasData === hasText) throw invalid("need-data-or-text");
  if (hasData) {
    checkSize(base64DecodedLength(dataBase64 as string), maxBytes);
    return { mimeType, bytes: base64ToBytes(dataBase64 as string) };
  }
  checkSize(utf8Length(text as string), maxBytes);
  return { mimeType, bytes: enc.encode(text as string) };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function randomBoundary(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds an upload: `multipart/related` (JSON metadata part, then the media part) when metadata is
 * present, else a simple `uploadType=media` body. Enforces the method's limits and accept list.
 */
export function buildUpload(meta: MethodMeta, mediaInput: unknown, metadata: unknown, boundary?: string): UploadBody {
  const upload = meta.mediaUpload;
  if (!upload) throw invalid("not-accepted");
  const { mimeType, bytes } = parseMediaInput(mediaInput, upload.maxBytes);
  if (!accepts(upload.accept, mimeType)) throw invalid("mime-type-not-accepted");
  checkSize(bytes.length, upload.maxBytes);
  const media = { mimeType, bytes: bytes.length };

  if (metadata === undefined) {
    return { pathTemplate: upload.simplePath.replace(/^\//, ""), uploadType: "media", contentType: mimeType, body: bytes, media };
  }
  const b = boundary ?? randomBoundary();
  const body = concat([
    enc.encode(
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${b}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ),
    bytes,
    enc.encode(`\r\n--${b}--`),
  ]);
  return {
    pathTemplate: upload.multipartPath.replace(/^\//, ""),
    uploadType: "multipart",
    contentType: `multipart/related; boundary=${b}`,
    body,
    media,
  };
}

// ---------- download ----------

/**
 * True when the response is media rather than JSON: `alt=media` on a downloadable method, or a downloadable
 * method without an `alt` parameter (the generator adds `alt` only to methods that also return JSON, so a
 * method without it, such as `drive.files.export`, always returns media).
 */
export function wantsMediaDownload(meta: MethodMeta, input: Record<string, unknown>): boolean {
  if (!meta.mediaDownload) return false;
  const hasAlt = meta.queryParams.some((p) => p.name === "alt");
  return hasAlt ? input.alt === "media" : true;
}

/** Media result for a downloaded body; the caller reads the body under its size cap. */
export function mediaResult(bytes: Uint8Array, contentType: string | null): MediaResult {
  const mimeType = baseType(contentType ?? "") || "application/octet-stream";
  return { mimeType, sizeBytes: bytes.length, dataBase64: bytesToBase64(bytes) };
}
