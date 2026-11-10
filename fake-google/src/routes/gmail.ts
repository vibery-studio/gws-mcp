import { b64urlEncode, googleError } from "../oauth";
import { fakeKey, type FakeStore, type JsonValue } from "../store";
import type { FakeContext, FakeRoute, SeedPresets } from "./index";

// ---------- MIME helpers (also used by the Drive multipart upload route) ----------

export interface MimeHeader {
  [key: string]: JsonValue;
  name: string;
  value: string;
}

const enc = new TextEncoder();
const utf8 = new TextDecoder();

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return s;
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Splits an RFC 822 / MIME entity into unfolded headers and the raw body bytes. */
export function parseEntity(bytes: Uint8Array): { headers: MimeHeader[]; body: Uint8Array } {
  let end = indexOf(bytes, enc.encode("\r\n\r\n"));
  let sep = 4;
  if (end < 0) {
    end = indexOf(bytes, enc.encode("\n\n"));
    sep = 2;
  }
  const head = latin1(end < 0 ? bytes : bytes.subarray(0, end));
  const body = end < 0 ? new Uint8Array(0) : bytes.subarray(end + sep);
  const headers: MimeHeader[] = [];
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return { headers, body };
}

export function headerValue(headers: readonly MimeHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** A Content-Type parameter (e.g. boundary, name), quoted or not. */
export function headerParam(value: string | undefined, param: string): string | undefined {
  if (!value) return undefined;
  const m = new RegExp(`;\\s*${param}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value);
  return m ? (m[1] ?? m[2]) : undefined;
}

export function baseMimeType(value: string | undefined): string {
  return (value?.split(";")[0] ?? "").trim().toLowerCase();
}

/** Body parts of a multipart entity body, binary-safe. */
export function splitMultipart(body: Uint8Array, boundary: string): Uint8Array[] {
  const delim = enc.encode(`--${boundary}`);
  const next = enc.encode(`\r\n--${boundary}`);
  const parts: Uint8Array[] = [];
  let at = indexOf(body, delim);
  if (at < 0) return parts;
  at += delim.length;
  while (at < body.length) {
    if (body[at] === 45 && body[at + 1] === 45) break; // closing "--"
    const lineEnd = indexOf(body, enc.encode("\r\n"), at);
    if (lineEnd < 0) break;
    const start = lineEnd + 2;
    const end = indexOf(body, next, start);
    if (end < 0) break;
    parts.push(body.subarray(start, end));
    at = end + next.length;
  }
  return parts;
}

function decodeTransfer(body: Uint8Array, encoding: string | undefined): Uint8Array {
  const e = encoding?.trim().toLowerCase();
  if (e === "base64") {
    try {
      return Uint8Array.from(atob(latin1(body).replace(/[^A-Za-z0-9+/=]/g, "")), (c) => c.charCodeAt(0));
    } catch {
      return body;
    }
  }
  if (e === "quoted-printable") {
    const text = latin1(body)
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Uint8Array.from(text, (c) => c.charCodeAt(0));
  }
  return body;
}

/** Decodes Gmail's base64url `raw` (standard alphabet tolerated). */
function decodeRaw(raw: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(raw)) return undefined;
  const bare = raw.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (bare.length % 4 === 1) return undefined;
  try {
    return Uint8Array.from(atob(bare + "=".repeat((4 - (bare.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

// ---------- message model ----------

/** Stored at `gmail:message:<email>:<id>`. `raw` is the base64url RFC 822 message, as Gmail keeps it. */
interface MessageRecord {
  [key: string]: JsonValue;
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: string;
  historyId: string;
  raw: string;
}

/** Stored at `gmail:label:<email>:<id>`. */
interface LabelRecord {
  [key: string]: JsonValue;
  id: string;
  name: string;
}

const messageKey = (email: string, id: string) => fakeKey("gmail", "message", email, id);
const messagePrefix = (email: string) => `gmail:message:${email}:`;

interface MessagePart {
  [key: string]: JsonValue;
  partId: string;
  mimeType: string;
  filename: string;
  headers: MimeHeader[];
  body: { size: number; data?: string };
}

function payloadOf(bytes: Uint8Array, partId: string, depth: number): MessagePart {
  const { headers, body } = parseEntity(bytes);
  const contentType = headerValue(headers, "content-type");
  const mimeType = baseMimeType(contentType) || "text/plain";
  const filename = headerParam(headerValue(headers, "content-disposition"), "filename") ?? headerParam(contentType, "name") ?? "";
  const part: MessagePart = { partId, mimeType, filename, headers, body: { size: 0 } };
  const boundary = headerParam(contentType, "boundary");
  if (mimeType.startsWith("multipart/") && boundary && depth < 4) {
    part.parts = splitMultipart(body, boundary).map((p, i) => payloadOf(p, partId === "" ? String(i) : `${partId}.${i}`, depth + 1));
  } else {
    const data = decodeTransfer(body, headerValue(headers, "content-transfer-encoding"));
    part.body = data.length > 0 ? { size: data.length, data: b64urlEncode(data) } : { size: 0 };
  }
  return part;
}

function firstText(part: MessagePart): string | undefined {
  if (part.mimeType === "text/plain" && part.body.data) {
    const bytes = decodeRaw(part.body.data);
    return bytes ? utf8.decode(bytes) : undefined;
  }
  for (const child of (part.parts as MessagePart[] | undefined) ?? []) {
    const t = firstText(child);
    if (t !== undefined) return t;
  }
  return undefined;
}

function view(rec: MessageRecord, format: string, metadataHeaders: string[]): Record<string, JsonValue> {
  const bytes = decodeRaw(rec.raw) ?? new Uint8Array(0);
  const payload = payloadOf(bytes, "", 0);
  const base: Record<string, JsonValue> = {
    id: rec.id,
    threadId: rec.threadId,
    labelIds: rec.labelIds,
    snippet: (firstText(payload) ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    sizeEstimate: bytes.length,
    historyId: rec.historyId,
    internalDate: rec.internalDate,
  };
  if (format === "full") base.payload = payload;
  if (format === "raw") base.raw = rec.raw;
  if (format === "metadata") {
    const wanted = new Set(metadataHeaders.map((h) => h.toLowerCase()));
    const headers = wanted.size === 0 ? payload.headers : payload.headers.filter((h) => wanted.has(h.name.toLowerCase()));
    base.payload = { mimeType: payload.mimeType, headers };
  }
  return base;
}

function subjectOf(rec: MessageRecord): string {
  return headerValue(parseEntity(decodeRaw(rec.raw) ?? new Uint8Array(0)).headers, "subject") ?? "";
}

// ---------- responses ----------

const json = (body: JsonValue, status = 200) => Response.json(body, { status });

function notFound(): Response {
  const message = "Requested entity was not found.";
  return googleError(404, message, "NOT_FOUND", { errors: [{ message, domain: "global", reason: "notFound" }] });
}

function invalidArgument(message: string): Response {
  return googleError(400, message, "INVALID_ARGUMENT", { errors: [{ message, domain: "global", reason: "invalidArgument" }] });
}

/** `userId` must be "me" or the token owner, as for a non-delegated Gmail client. */
function checkUser(ctx: FakeContext): Response | undefined {
  const userId = decodeURIComponent(ctx.match[1] ?? "");
  if (userId === "me" || userId.toLowerCase() === ctx.email.toLowerCase()) return undefined;
  const message = `Delegation denied for ${ctx.email}`;
  return googleError(403, message, "PERMISSION_DENIED", { errors: [{ message, domain: "global", reason: "forbidden" }] });
}

async function messages(store: FakeStore, email: string): Promise<MessageRecord[]> {
  return (await store.list<MessageRecord>(messagePrefix(email))).map(([, m]) => m);
}

function newMessageId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const v: unknown = await req.json();
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ---------- routes ----------

const MAIL = "https://mail.google.com/";
const G = "https://www.googleapis.com/auth/";
const USERS = "^/gmail\\.googleapis\\.com/gmail/v1/users/([^/]+)";
const SYSTEM_LABELS = ["INBOX", "SENT", "TRASH", "SPAM", "DRAFT", "UNREAD", "STARRED", "IMPORTANT", "CHAT"];
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

async function listMessages(ctx: FakeContext): Promise<Response> {
  const denied = checkUser(ctx);
  if (denied) return denied;
  const p = ctx.url.searchParams;
  const maxRaw = p.get("maxResults");
  const max = maxRaw === null ? DEFAULT_PAGE : Number(maxRaw);
  if (!Number.isInteger(max) || max < 1) return invalidArgument("Invalid maxResults");
  const tokenRaw = p.get("pageToken");
  if (tokenRaw !== null && !/^\d{1,9}$/.test(tokenRaw)) return invalidArgument("Invalid pageToken");
  const offset = tokenRaw === null ? 0 : Number(tokenRaw);

  const withSpamTrash = p.get("includeSpamTrash") === "true";
  const labelIds = p.getAll("labelIds");
  const q = (p.get("q") ?? "").trim().replace(/^subject:/i, "").replace(/^"(.*)"$/, "$1").toLowerCase();
  const all = (await messages(ctx.store, ctx.email))
    .filter((m) => withSpamTrash || !m.labelIds.some((l) => l === "TRASH" || l === "SPAM"))
    .filter((m) => labelIds.every((l) => m.labelIds.includes(l)))
    .filter((m) => q === "" || subjectOf(m).toLowerCase().includes(q))
    .sort((a, b) => Number(b.internalDate) - Number(a.internalDate) || (a.id < b.id ? 1 : -1));
  const page = all.slice(offset, offset + Math.min(max, MAX_PAGE));
  const body: Record<string, JsonValue> = {};
  if (page.length > 0) body.messages = page.map((m) => ({ id: m.id, threadId: m.threadId }));
  const next = offset + page.length;
  if (page.length > 0 && next < all.length) body.nextPageToken = String(next);
  body.resultSizeEstimate = all.length;
  return json(body);
}

async function getMessage(ctx: FakeContext): Promise<Response> {
  const denied = checkUser(ctx);
  if (denied) return denied;
  const rec = await ctx.store.get<MessageRecord>(messageKey(ctx.email, decodeURIComponent(ctx.match[2] ?? "")));
  if (!rec) return notFound();
  const format = ctx.url.searchParams.get("format") ?? "full";
  if (!["minimal", "full", "raw", "metadata"].includes(format)) return invalidArgument(`Invalid format: ${format}`);
  return json(view(rec, format, ctx.url.searchParams.getAll("metadataHeaders")));
}

async function sendMessage(ctx: FakeContext): Promise<Response> {
  const denied = checkUser(ctx);
  if (denied) return denied;
  const body = await readJsonBody(ctx.req);
  if (!body || typeof body.raw !== "string" || body.raw === "") {
    return invalidArgument("'raw' RFC822 payload message string or uploading message via /upload/* URL required");
  }
  const bytes = decodeRaw(body.raw);
  if (!bytes) return invalidArgument("Invalid value for ByteString");
  const { headers } = parseEntity(bytes);
  const to = headerValue(headers, "to") ?? "";
  if (!to && !headerValue(headers, "cc") && !headerValue(headers, "bcc")) return invalidArgument("Recipient address required");

  const existing = await messages(ctx.store, ctx.email);
  const id = newMessageId();
  const rec: MessageRecord = {
    id,
    threadId: typeof body.threadId === "string" && body.threadId ? body.threadId : id,
    labelIds: ["SENT"],
    internalDate: String(ctx.now()),
    historyId: String(Math.max(1000, ...existing.map((m) => Number(m.historyId) || 0)) + 1),
    raw: b64urlEncode(bytes),
    // Recorded so tests can observe what was sent without decoding the message.
    to,
    subject: headerValue(headers, "subject") ?? "",
  };
  await ctx.store.put(messageKey(ctx.email, id), rec);
  return json({ id: rec.id, threadId: rec.threadId, labelIds: rec.labelIds });
}

async function deleteMessage(ctx: FakeContext): Promise<Response> {
  const denied = checkUser(ctx);
  if (denied) return denied;
  const deleted = await ctx.store.delete(messageKey(ctx.email, decodeURIComponent(ctx.match[2] ?? "")));
  return deleted ? new Response(null, { status: 204 }) : notFound();
}

async function trashMessage(ctx: FakeContext): Promise<Response> {
  const denied = checkUser(ctx);
  if (denied) return denied;
  const key = messageKey(ctx.email, decodeURIComponent(ctx.match[2] ?? ""));
  const rec = await ctx.store.get<MessageRecord>(key);
  if (!rec) return notFound();
  if (!rec.labelIds.includes("TRASH")) rec.labelIds = [...rec.labelIds.filter((l) => l !== "INBOX"), "TRASH"];
  await ctx.store.put(key, rec);
  return json({ id: rec.id, threadId: rec.threadId, labelIds: rec.labelIds });
}

async function listLabels(ctx: FakeContext): Promise<Response> {
  const denied = checkUser(ctx);
  if (denied) return denied;
  const user = (await ctx.store.list<LabelRecord>(`gmail:label:${ctx.email}:`)).map(([, l]) => ({
    id: l.id,
    name: l.name,
    type: "user",
    messageListVisibility: "show",
    labelListVisibility: "labelShow",
  }));
  return json({ labels: [...SYSTEM_LABELS.map((id) => ({ id, name: id, type: "system" })), ...user] });
}

async function getProfile(ctx: FakeContext): Promise<Response> {
  const denied = checkUser(ctx);
  if (denied) return denied;
  const all = await messages(ctx.store, ctx.email);
  return json({
    emailAddress: ctx.email,
    messagesTotal: all.length,
    threadsTotal: new Set(all.map((m) => m.threadId)).size,
    historyId: String(Math.max(1000, ...all.map((m) => Number(m.historyId) || 0))),
  });
}

/** Scopes per route: the Discovery `scopes` of the method (checked against the generated SDK in tests). */
export const routes: FakeRoute[] = [
  {
    method: "GET",
    pattern: new RegExp(`${USERS}/messages$`),
    scopes: [MAIL, `${G}gmail.metadata`, `${G}gmail.modify`, `${G}gmail.readonly`],
    handle: listMessages,
  },
  {
    method: "POST",
    pattern: new RegExp(`${USERS}/messages/send$`),
    scopes: [MAIL, `${G}gmail.addons.current.action.compose`, `${G}gmail.compose`, `${G}gmail.modify`, `${G}gmail.send`],
    handle: sendMessage,
  },
  {
    method: "POST",
    pattern: new RegExp(`${USERS}/messages/([^/]+)/trash$`),
    scopes: [MAIL, `${G}gmail.modify`],
    handle: trashMessage,
  },
  {
    method: "GET",
    pattern: new RegExp(`${USERS}/messages/([^/]+)$`),
    scopes: [
      MAIL,
      `${G}gmail.addons.current.message.action`,
      `${G}gmail.addons.current.message.metadata`,
      `${G}gmail.addons.current.message.readonly`,
      `${G}gmail.metadata`,
      `${G}gmail.modify`,
      `${G}gmail.readonly`,
    ],
    handle: getMessage,
  },
  {
    method: "DELETE",
    pattern: new RegExp(`${USERS}/messages/([^/]+)$`),
    scopes: [MAIL],
    handle: deleteMessage,
  },
  {
    method: "GET",
    pattern: new RegExp(`${USERS}/labels$`),
    scopes: [MAIL, `${G}gmail.labels`, `${G}gmail.metadata`, `${G}gmail.modify`, `${G}gmail.readonly`],
    handle: listLabels,
  },
  {
    method: "GET",
    pattern: new RegExp(`${USERS}/profile$`),
    scopes: [MAIL, `${G}gmail.compose`, `${G}gmail.metadata`, `${G}gmail.modify`, `${G}gmail.readonly`],
    handle: getProfile,
  },
];

// ---------- seed preset ----------

function seedMessage(id: string, internalDate: string, historyId: string, labelIds: string[], rfc822: string): { key: string; value: MessageRecord } {
  return {
    key: `gmail:message:{email}:${id}`,
    value: { id, threadId: `t-${id}`, labelIds, internalDate, historyId, raw: b64urlEncode(enc.encode(rfc822)) },
  };
}

const CRLF = "\r\n";
const SEED_MESSAGES = [
  seedMessage(
    "m-seed-welcome",
    "1793523600000",
    "1001",
    ["INBOX", "UNREAD"],
    [
      'From: "Fake Google" <no-reply@fake.test>',
      "To: me@fake.test",
      "Subject: Welcome to the fake mailbox",
      "Date: Sun, 01 Nov 2026 09:00:00 +0000",
      "Message-ID: <m-seed-welcome@fake.test>",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      "Hello! This mailbox is served by the fake Google.",
    ].join(CRLF),
  ),
  seedMessage(
    "m-seed-invoice",
    "1793610000000",
    "1002",
    ["INBOX"],
    [
      "From: billing@vendor.example",
      "To: me@fake.test",
      "Subject: Invoice 2026-10",
      "Date: Mon, 02 Nov 2026 09:00:00 +0000",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="seed-boundary"',
      "",
      "--seed-boundary",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      "Your October invoice is attached.",
      "--seed-boundary",
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQKJWZha2UK",
      "--seed-boundary--",
      "",
    ].join(CRLF),
  ),
  seedMessage(
    "m-seed-report",
    "1793696400000",
    "1003",
    ["INBOX", "IMPORTANT"],
    [
      "From: team@work.example",
      "To: me@fake.test",
      "Subject: Weekly report",
      "Date: Tue, 03 Nov 2026 09:00:00 +0000",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      "Shipped the compat layer. Next: the dispatcher.",
    ].join(CRLF),
  ),
];

export const presets: SeedPresets = {
  default: [...SEED_MESSAGES, { key: "gmail:label:{email}:Label_1", value: { id: "Label_1", name: "Projects" } }],
};

