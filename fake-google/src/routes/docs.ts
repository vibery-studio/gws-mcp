import { googleError, randomToken } from "../oauth";
import { fakeKey, type JsonValue } from "../store";
import type { FakeContext, FakeRoute, SeedPresets } from "./index";

// ---------- model ----------

/**
 * Stored at `docs:document:<email>:<id>`. The text is the whole body: one string that always ends with a
 * newline, as in Google Docs. Index 1 is its first character.
 */
interface DocumentRecord {
  [key: string]: JsonValue;
  documentId: string;
  title: string;
  text: string;
  revision: number;
}

const DOC_MIME = "application/vnd.google-apps.document";

const documentKey = (email: string, id: string) => fakeKey("docs", "document", email, id);
const driveFileKey = (email: string, id: string) => fakeKey("drive", "file", email, id);

const revisionId = (rec: DocumentRecord) => `rev-${rec.revision}`;

/** The document as the API returns it: the paragraphs of the text with their start and end indexes. */
function render(rec: DocumentRecord): Record<string, JsonValue> {
  const content: JsonValue[] = [
    {
      endIndex: 1,
      sectionBreak: { sectionStyle: { columnSeparatorStyle: "NONE", contentDirection: "LEFT_TO_RIGHT", sectionType: "CONTINUOUS" } },
    },
  ];
  let at = 1;
  for (const line of rec.text.slice(0, -1).split("\n")) {
    const end = at + line.length + 1;
    content.push({
      startIndex: at,
      endIndex: end,
      paragraph: {
        elements: [{ startIndex: at, endIndex: end, textRun: { content: `${line}\n`, textStyle: {} } }],
        paragraphStyle: { namedStyleType: "NORMAL_TEXT", direction: "LEFT_TO_RIGHT" },
      },
    });
    at = end;
  }
  return {
    documentId: rec.documentId,
    title: rec.title,
    body: { content },
    documentStyle: {},
    revisionId: revisionId(rec),
    suggestionsViewMode: "SUGGESTIONS_INLINE",
  };
}

// ---------- errors ----------

function notFound(id: string): Response {
  const message = `Requested entity was not found.`;
  return googleError(404, message, "NOT_FOUND", { errors: [{ message: `${message} (${id})`, domain: "global", reason: "notFound" }] });
}

function badRequest(message: string, reason = "badRequest"): Response {
  return googleError(400, message, "INVALID_ARGUMENT", { errors: [{ message, domain: "global", reason }] });
}

async function readJsonObject(req: Request): Promise<Record<string, unknown> | undefined> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ---------- handlers ----------

const idOf = (ctx: FakeContext) => decodeURIComponent(ctx.match[1] ?? "");

async function createDocument(ctx: FakeContext): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  if (body.title !== undefined && typeof body.title !== "string") return badRequest("Invalid value at 'document.title'");
  const title = typeof body.title === "string" && body.title !== "" ? body.title : "Untitled document";
  const id = `1${randomToken(32)}`;
  const rec: DocumentRecord = { documentId: id, title, text: "\n", revision: 1 };
  await ctx.store.put(documentKey(ctx.email, id), rec);
  // A document is also a Drive file: Drive export and listing see it through the shared key convention.
  const now = new Date(ctx.now()).toISOString();
  await ctx.store.put(driveFileKey(ctx.email, id), {
    kind: "drive#file",
    id,
    name: title,
    mimeType: DOC_MIME,
    parents: ["root"],
    trashed: false,
    starred: false,
    createdTime: now,
    modifiedTime: now,
    version: "1",
    webViewLink: `https://docs.google.com/document/d/${id}/edit`,
  });
  return Response.json(render(rec));
}

async function getDocument(ctx: FakeContext): Promise<Response> {
  const rec = await ctx.store.get<DocumentRecord>(documentKey(ctx.email, idOf(ctx)));
  return rec ? Response.json(render(rec)) : notFound(idOf(ctx));
}

/** Applies one `insertText` request to `text`, or returns the reason it is invalid. */
function insertText(text: string, request: unknown): { text: string } | { error: string } {
  const insert = (request as { insertText?: { text?: unknown; location?: { index?: unknown }; endOfSegmentLocation?: unknown } } | null)?.insertText;
  if (!insert || typeof insert !== "object") return { error: "The fake supports insertText requests only." };
  if (typeof insert.text !== "string" || insert.text === "") return { error: "insertText.text must be a non-empty string." };
  if (insert.endOfSegmentLocation !== undefined && insert.location === undefined) {
    return { text: `${text.slice(0, -1)}${insert.text}\n` };
  }
  const index = insert.location?.index;
  if (insert.location === undefined || insert.endOfSegmentLocation !== undefined) return { error: "insertText needs exactly one of location and endOfSegmentLocation." };
  // The final newline cannot be inserted before or after; the last valid index is the one before it.
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > text.length) {
    return { error: `Invalid requests[0].insertText: index ${String(index)} must be between 1 and ${text.length}.` };
  }
  return { text: `${text.slice(0, index - 1)}${insert.text}${text.slice(index - 1)}` };
}

async function batchUpdate(ctx: FakeContext): Promise<Response> {
  const id = idOf(ctx);
  const rec = await ctx.store.get<DocumentRecord>(documentKey(ctx.email, id));
  if (!rec) return notFound(id);
  const body = await readJsonObject(ctx.req);
  const requests = body?.requests;
  if (!Array.isArray(requests) || requests.length === 0) return badRequest("requests must be a non-empty list.");
  let text = rec.text;
  // All or nothing, like Google: an invalid request leaves the document unchanged.
  for (const request of requests) {
    const result = insertText(text, request);
    if ("error" in result) return badRequest(result.error, "invalidArgument");
    text = result.text;
  }
  rec.text = text;
  rec.revision += 1;
  await ctx.store.put(documentKey(ctx.email, id), rec);
  return Response.json({ documentId: id, replies: requests.map(() => ({})), writeControl: { requiredRevisionId: revisionId(rec) } });
}

// ---------- routes ----------

const G = "https://www.googleapis.com/auth/";
const V1 = "^/docs\\.googleapis\\.com/v1/documents";

/** Scopes per route: the Discovery `scopes` of the method (checked against the generated SDK in tests). */
const SCOPES = {
  write: [`${G}documents`, `${G}drive`, `${G}drive.file`],
  read: [`${G}documents`, `${G}documents.readonly`, `${G}drive`, `${G}drive.file`, `${G}drive.readonly`],
};

export const routes: FakeRoute[] = [
  { method: "POST", pattern: new RegExp(`${V1}$`), scopes: SCOPES.write, handle: createDocument },
  { method: "POST", pattern: new RegExp(`${V1}/([^/]+):batchUpdate$`), scopes: SCOPES.write, handle: batchUpdate },
  { method: "GET", pattern: new RegExp(`${V1}/([^/]+)$`), scopes: SCOPES.read, handle: getDocument },
];

// ---------- seed preset ----------

/** The Drive preset registers a file with this id; the document behind it lives here. */
export const presets: SeedPresets = {
  default: [
    {
      key: "docs:document:{email}:seed-doc-notes",
      value: { documentId: "seed-doc-notes", title: "Meeting notes", text: "Agenda\nShip the helpers\n", revision: 1 },
    },
  ],
};
