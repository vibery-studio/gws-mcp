import { GwsError } from "../../errors";
import { base64ToBytes, bytesToBase64 } from "../../google/media";

/** Gmail refuses messages above 25 MB, counted on the encoded message. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

const MAX_ASCII_SUBJECT = 900;
const LINE = 76;
const CRLF = "\r\n";
const enc = new TextEncoder();

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  dataBase64: string;
}

export interface MimeInput {
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments: MimeAttachment[];
}

export interface MimeOptions {
  /** The Date header; the current time when omitted. */
  date?: Date;
  /** Source of boundary candidates; a candidate that occurs in the content is discarded. */
  boundary?: () => string;
}

function invalid(reason: string, extra: Record<string, unknown> = {}): GwsError {
  return new GwsError("GWS_INVALID_INPUT", `invalid mail: ${reason}`, { details: { reason, ...extra } });
}

// ---------- header safety ----------

/** Any control character except tab: CR and LF end a header line, NUL and the rest corrupt it. */
const CONTROL = /[\u0000-\u0008\u000A-\u001F\u007F]/;

function assertNoControl(what: string, value: string): void {
  if (CONTROL.test(value)) throw invalid(`${what} contains a control character`, { field: what });
}

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const ADDRESS = new RegExp(`^[A-Za-z0-9.!#$%&'*+/=?^_\`{|}~-]+@${LABEL}(?:\\.${LABEL})*$`);
const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

function addressList(what: string, list: readonly string[]): string {
  for (const a of list) {
    assertNoControl(what, a);
    if (a.length > 254 || !ADDRESS.test(a)) throw invalid(`${what} must hold bare addresses like user@example.com`, { field: what });
  }
  return list.join(", ");
}

// ---------- RFC 2047 / RFC 2231 ----------

const MAX_WORD_BYTES = 45; // 45 bytes -> 60 base64 characters; "=?UTF-8?B?" and "?=" bring a word to 72.

/**
 * An RFC 2047 header value: ASCII as is, anything else as folded `=?UTF-8?B?...?=` words that never split a
 * character. Rejects control characters first, so the value can never end its header line.
 */
export function encodeSubject(subject: string): string {
  assertNoControl("subject", subject);
  if (/^[\x20-\x7e\t]*$/.test(subject)) {
    if (subject.length > MAX_ASCII_SUBJECT) throw invalid("subject is too long", { field: "subject" });
    return subject;
  }
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (chunk.length > 0) words.push(`=?UTF-8?B?${bytesToBase64(Uint8Array.from(chunk))}?=`);
    chunk = [];
  };
  for (const ch of subject) {
    const bytes = enc.encode(ch);
    if (chunk.length + bytes.length > MAX_WORD_BYTES) flush();
    chunk.push(...bytes);
  }
  flush();
  return words.join(`${CRLF} `);
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `filename="x"` for plain names; plus `filename*=UTF-8''...` when the name needs quoting or is not ASCII. */
function filenameParams(filename: string): { name: string; disposition: string } {
  assertNoControl("filename", filename);
  if (filename.includes("\t")) throw invalid("filename contains a control character", { field: "filename" });
  if (filename === "" || filename.length > 255) throw invalid("filename must be 1 to 255 characters", { field: "filename" });
  const plain = /^[\x20-\x7e]*$/.test(filename) && !/["\\]/.test(filename);
  if (plain) return { name: `name="${filename}"`, disposition: `filename="${filename}"` };
  const fallback = Array.from(filename, (c) => (/^[\x20-\x7e]$/.test(c) && c !== '"' && c !== "\\" ? c : "_")).join("");
  return { name: `name="${fallback}"`, disposition: `filename="${fallback}"; filename*=UTF-8''${percentEncode(filename)}` };
}

// ---------- structure ----------

function wrap(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += LINE) lines.push(b64.slice(i, i + LINE));
  return lines.join(CRLF);
}

function leaf(headers: string[], bytes: Uint8Array): string {
  return [...headers, "Content-Transfer-Encoding: base64", "", wrap(bytesToBase64(bytes))].join(CRLF);
}

function randomBoundary(): string {
  return `gws_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const BOUNDARY = /^[A-Za-z0-9'()+_,./:=?-]{1,70}$/;
const BOUNDARY_ATTEMPTS = 32;

/** A boundary that occurs nowhere in `parts`, so no part can end the multipart early. */
function pickBoundary(parts: readonly string[], next: () => string): string {
  for (let i = 0; i < BOUNDARY_ATTEMPTS; i++) {
    const b = next();
    if (BOUNDARY.test(b) && !parts.some((p) => p.includes(b))) return b;
  }
  throw new GwsError("GWS_INTERNAL", "could not pick a mail boundary");
}

/** One multipart entity: its Content-Type value and its body. */
function multipart(subtype: string, parts: string[], next: () => string): { contentType: string; body: string } {
  const b = pickBoundary(parts, next);
  const body = parts.map((p) => `--${b}${CRLF}${p}${CRLF}`).join("") + `--${b}--${CRLF}`;
  return { contentType: `multipart/${subtype}; boundary="${b}"`, body };
}

/** Upper bound of the encoded size of base64 text of `length` characters, from its length alone. */
function encodedEstimate(length: number): number {
  return Math.ceil((length * (LINE + 2)) / LINE);
}

/**
 * Builds an RFC 5322 message (CRLF line ends, ASCII only) with a multipart/mixed body, base64 attachments and
 * an RFC 2047 subject. Throws GWS_INVALID_INPUT for control characters in any header value, a recipient that is
 * not a bare address, a mime type with parameters, bad base64 or a message above the 25 MB limit.
 */
export function buildMime(input: MimeInput, opts: MimeOptions = {}): string {
  const next = opts.boundary ?? randomBoundary;
  if (input.to.length === 0) throw invalid("at least one recipient is required", { field: "to" });
  if (input.text === undefined && input.html === undefined) throw invalid("a text or html body is required", { field: "body" });

  const headerLines = ["MIME-Version: 1.0", `Date: ${(opts.date ?? new Date()).toUTCString().replace(/ GMT$/, " +0000")}`];
  headerLines.push(`To: ${addressList("to", input.to)}`);
  if (input.cc !== undefined && input.cc.length > 0) headerLines.push(`Cc: ${addressList("cc", input.cc)}`);
  headerLines.push(`Subject: ${encodeSubject(input.subject)}`);

  // Size first, from the lengths alone, so an oversized attachment is never decoded.
  let estimate = 0;
  for (const a of input.attachments) estimate += encodedEstimate(a.dataBase64.length);
  estimate += encodedEstimate(Math.ceil(((input.text?.length ?? 0) + (input.html?.length ?? 0)) * 1.4));
  if (estimate > MAX_MESSAGE_BYTES) throw invalid("the message is larger than 25 MB", { max: MAX_MESSAGE_BYTES });

  const textPart = (type: "plain" | "html", body: string) =>
    leaf([`Content-Type: text/${type}; charset="UTF-8"`], enc.encode(body));
  const bodies: string[] = [];
  if (input.text !== undefined) bodies.push(textPart("plain", input.text));
  if (input.html !== undefined) bodies.push(textPart("html", input.html));

  const parts: string[] = [];
  if (bodies.length === 1 && bodies[0] !== undefined) parts.push(bodies[0]);
  else {
    const alt = multipart("alternative", bodies, next);
    parts.push(`Content-Type: ${alt.contentType}${CRLF}${CRLF}${alt.body}`);
  }
  for (const a of input.attachments) {
    assertNoControl("mimeType", a.mimeType);
    if (!MIME_TYPE.test(a.mimeType)) throw invalid("mimeType must be type/subtype without parameters", { field: "mimeType" });
    const { name, disposition } = filenameParams(a.filename);
    parts.push(
      leaf([`Content-Type: ${a.mimeType}; ${name}`, `Content-Disposition: attachment; ${disposition}`], base64ToBytes(a.dataBase64)),
    );
  }

  const mixed = multipart("mixed", parts, next);
  const message = [...headerLines, `Content-Type: ${mixed.contentType}`, "", ""].join(CRLF) + mixed.body;
  if (message.length > MAX_MESSAGE_BYTES) throw invalid("the message is larger than 25 MB", { max: MAX_MESSAGE_BYTES });
  return message;
}

/** The Gmail `raw` field: URL-safe base64 without padding. The message is ASCII, so each character is one byte. */
export function toRaw(message: string): string {
  return bytesToBase64(enc.encode(message)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
