import { googleError, randomToken } from "../oauth";
import { fakeKey, type JsonValue } from "../store";
import type { FakeContext, FakeRoute, SeedPresets } from "./index";

// ---------- model ----------

/**
 * A presentation's content is the content of its Drive file: JSON, base64-encoded, at
 * `drive:blob:<email>:<id>` (Google Docs Editors files are never downloadable from Drive, so this is not
 * observable as file bytes). Keeping it there gives Drive semantics for free: `drive.files.copy` copies the
 * slides and `drive.files.delete` deletes them. When a `drive:file` record exists its name is the title,
 * as in Google; without one (the default seed) the presentation is reachable through Slides only.
 */
interface SlidesContent {
  [key: string]: JsonValue;
  kind: "fake#presentation";
  title: string;
  locale: string;
  revision: number;
  slides: SlideRecord[];
}

interface SlideRecord {
  [key: string]: JsonValue;
  objectId: string;
  /** Text boxes, in z-order. */
  elements: Array<{ objectId: string; text: string }>;
}

const PRESENTATION_MIME = "application/vnd.google-apps.presentation";
/** Object ids that requests may set: Google's rule. */
const OBJECT_ID_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_\-:]{4,49}$/;
const PRESENTATION_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

const driveFileKey = (email: string, id: string) => fakeKey("drive", "file", email, id);
const driveBlobKey = (email: string, id: string) => fakeKey("drive", "blob", email, id);

const revisionId = (c: SlidesContent) => `rev-${c.revision}`;

// ---------- encoding ----------

function encode(content: SlidesContent): string {
  let binary = "";
  for (const b of new TextEncoder().encode(JSON.stringify(content))) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decode(blob: string): SlidesContent | undefined {
  try {
    const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
    const v = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SlidesContent> | null;
    return v?.kind === "fake#presentation" && Array.isArray(v.slides) ? (v as SlidesContent) : undefined;
  } catch {
    return undefined;
  }
}

// ---------- rendering ----------

const EMU = (magnitude: number) => ({ magnitude, unit: "EMU" });

/** Google's text elements: per paragraph a marker, then its run, with UTF-16 indexes (a zero start is omitted). */
function textElements(text: string): JsonValue[] {
  const out: JsonValue[] = [];
  let at = 0;
  for (const para of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const end = at + para.length;
    const range: Record<string, JsonValue> = at === 0 ? { endIndex: end } : { startIndex: at, endIndex: end };
    out.push({ ...range, paragraphMarker: { style: {} } }, { ...range, textRun: { content: para, style: {} } });
    at = end;
  }
  return out;
}

function renderSlide(slide: SlideRecord): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { objectId: slide.objectId, pageType: "SLIDE" };
  if (slide.elements.length > 0) {
    out.pageElements = slide.elements.map((e, i) => ({
      objectId: e.objectId,
      size: { width: EMU(7620000), height: EMU(1000000) },
      transform: { scaleX: 1, scaleY: 1, translateX: 762000, translateY: 500000 + i * 1200000, unit: "EMU" },
      shape: { shapeType: "TEXT_BOX", ...(e.text === "" ? {} : { text: { textElements: textElements(e.text) } }) },
    }));
  }
  return out;
}

function render(id: string, c: SlidesContent): Record<string, JsonValue> {
  return {
    presentationId: id,
    pageSize: { width: EMU(9144000), height: EMU(5143500) },
    slides: c.slides.map(renderSlide),
    title: c.title,
    locale: c.locale,
    revisionId: revisionId(c),
  };
}

// ---------- errors ----------

function notFound(id: string): Response {
  const message = "Requested entity was not found.";
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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------- state ----------

/** The presentation behind `id`, or undefined when there is none (or the Drive file is of another type). */
async function load(ctx: FakeContext, id: string): Promise<SlidesContent | undefined> {
  const file = await ctx.store.get<{ [key: string]: JsonValue }>(driveFileKey(ctx.email, id));
  if (file && file.mimeType !== PRESENTATION_MIME) return undefined;
  const blob = await ctx.store.get(driveBlobKey(ctx.email, id));
  const content = typeof blob === "string" ? decode(blob) : undefined;
  if (content && typeof file?.name === "string") content.title = file.name;
  return content;
}

function driveFile(id: string, name: string, time: string): { [key: string]: JsonValue } {
  return {
    kind: "drive#file",
    id,
    name,
    mimeType: PRESENTATION_MIME,
    parents: ["root"],
    trashed: false,
    starred: false,
    createdTime: time,
    modifiedTime: time,
    version: "1",
    webViewLink: `https://docs.google.com/presentation/d/${id}/edit`,
  };
}

// ---------- handlers ----------

const idOf = (ctx: FakeContext) => decodeURIComponent(ctx.match[1] ?? "");

/** Google uses `title` and `presentationId` from the body and ignores any other content. */
async function createPresentation(ctx: FakeContext): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  if (body.title !== undefined && typeof body.title !== "string") return badRequest("Invalid value at 'presentation.title'");
  let id = `1${randomToken(32)}`;
  if (body.presentationId !== undefined) {
    if (typeof body.presentationId !== "string" || !PRESENTATION_ID_RE.test(body.presentationId)) {
      return badRequest("Invalid value at 'presentation.presentation_id'");
    }
    id = body.presentationId;
    const taken = (await ctx.store.get(driveFileKey(ctx.email, id))) ?? (await ctx.store.get(driveBlobKey(ctx.email, id)));
    if (taken !== undefined) return googleError(409, `A presentation with id ${id} already exists.`, "ALREADY_EXISTS");
  }
  const title = typeof body.title === "string" && body.title !== "" ? body.title : "Untitled presentation";
  const content: SlidesContent = { kind: "fake#presentation", title, locale: "en", revision: 1, slides: [{ objectId: "p", elements: [] }] };
  await ctx.store.put(driveBlobKey(ctx.email, id), encode(content));
  // A presentation is a Drive file: Drive lists, copies, exports and deletes it through the shared keys.
  await ctx.store.put(driveFileKey(ctx.email, id), driveFile(id, title, new Date(ctx.now()).toISOString()));
  return Response.json(render(id, content));
}

async function getPresentation(ctx: FakeContext): Promise<Response> {
  const id = idOf(ctx);
  const content = await load(ctx, id);
  return content ? Response.json(render(id, content)) : notFound(id);
}

const allObjectIds = (c: SlidesContent) => new Set(c.slides.flatMap((s) => [s.objectId, ...s.elements.map((e) => e.objectId)]));

type Applied = { reply: JsonValue } | { error: string };

function replaceAllText(c: SlidesContent, arg: unknown, at: string): Applied {
  if (!isObject(arg) || !isObject(arg.containsText)) return { error: `${at}.containsText is required.` };
  const { text, matchCase, searchByRegex } = arg.containsText;
  if (typeof text !== "string" || text === "") return { error: `${at}.containsText.text must be a non-empty string.` };
  if (matchCase !== undefined && typeof matchCase !== "boolean") return { error: `${at}.containsText.matchCase must be a boolean.` };
  if (searchByRegex === true) return { error: `${at}: the fake does not support searchByRegex.` };
  const replaceText = arg.replaceText ?? "";
  if (typeof replaceText !== "string") return { error: `${at}.replaceText must be a string.` };
  let slides = c.slides;
  if (arg.pageObjectIds !== undefined) {
    const ids = arg.pageObjectIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string" && c.slides.some((s) => s.objectId === x))) {
      return { error: `${at}.pageObjectIds must name slides of this presentation.` };
    }
    slides = c.slides.filter((s) => ids.includes(s.objectId));
  }
  // The search text is matched literally; the replacement is inserted as is (no `$&` patterns).
  const pattern = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase === true ? "g" : "gi");
  let occurrences = 0;
  for (const slide of slides) {
    for (const e of slide.elements) {
      e.text = e.text.replace(pattern, () => {
        occurrences++;
        return replaceText;
      });
    }
  }
  // Google omits a zero count.
  return { reply: { replaceAllText: occurrences > 0 ? { occurrencesChanged: occurrences } : {} } };
}

function createSlide(c: SlidesContent, arg: unknown, at: string): Applied {
  const a = isObject(arg) ? arg : {};
  let objectId = `g${randomToken(12)}`;
  if (a.objectId !== undefined) {
    if (typeof a.objectId !== "string" || !OBJECT_ID_RE.test(a.objectId)) return { error: `${at}.objectId is not a valid object id.` };
    if (allObjectIds(c).has(a.objectId)) return { error: `${at}: the object id ${a.objectId} is already in use.` };
    objectId = a.objectId;
  }
  const index = a.insertionIndex ?? c.slides.length;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > c.slides.length) {
    return { error: `${at}.insertionIndex must be between 0 and ${c.slides.length}.` };
  }
  const layout = a.slideLayoutReference;
  if (layout !== undefined) {
    if (!isObject(layout)) return { error: `${at}.slideLayoutReference must be an object.` };
    if (layout.layoutId !== undefined) return { error: `${at}: the layout ${String(layout.layoutId)} could not be found.` };
    if (layout.predefinedLayout !== undefined && typeof layout.predefinedLayout !== "string") {
      return { error: `${at}.slideLayoutReference.predefinedLayout must be a string.` };
    }
  }
  if (Array.isArray(a.placeholderIdMappings) && a.placeholderIdMappings.length > 0) {
    return { error: `${at}: the fake does not support placeholderIdMappings.` };
  }
  c.slides.splice(index, 0, { objectId, elements: [] });
  return { reply: { createSlide: { objectId } } };
}

function deleteObject(c: SlidesContent, arg: unknown, at: string): Applied {
  const objectId = isObject(arg) ? arg.objectId : undefined;
  if (typeof objectId !== "string") return { error: `${at}.objectId is required.` };
  const slideAt = c.slides.findIndex((s) => s.objectId === objectId);
  if (slideAt >= 0) {
    c.slides.splice(slideAt, 1);
    return { reply: {} };
  }
  for (const slide of c.slides) {
    const elementAt = slide.elements.findIndex((e) => e.objectId === objectId);
    if (elementAt >= 0) {
      slide.elements.splice(elementAt, 1);
      return { reply: {} };
    }
  }
  return { error: `${at}: the object (${objectId}) could not be found.` };
}

const KINDS: Record<string, (c: SlidesContent, arg: unknown, at: string) => Applied> = { replaceAllText, createSlide, deleteObject };

async function batchUpdate(ctx: FakeContext): Promise<Response> {
  const id = idOf(ctx);
  const content = await load(ctx, id);
  if (!content) return notFound(id);
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  const requests = body.requests;
  if (!Array.isArray(requests) || requests.length === 0) return badRequest("requests must be a non-empty list.");
  const required = isObject(body.writeControl) ? body.writeControl.requiredRevisionId : undefined;
  if (required !== undefined && required !== revisionId(content)) {
    return badRequest(`The revision ${String(required)} is not the latest revision of the presentation.`, "failedPrecondition");
  }
  // All or nothing, like Google: an invalid request leaves the presentation unchanged (`content` is a fresh copy).
  const replies: JsonValue[] = [];
  for (const [i, request] of requests.entries()) {
    const kinds = isObject(request) ? Object.keys(request) : [];
    const [kind] = kinds;
    const at = `Invalid requests[${i}]`;
    if (kinds.length !== 1 || kind === undefined) return badRequest(`${at}: set exactly one request kind.`);
    const apply = Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;
    if (!apply) return badRequest(`${at}: the fake supports replaceAllText, createSlide and deleteObject requests only, not ${kind}.`);
    const result = apply(content, (request as Record<string, unknown>)[kind], `${at}.${kind}`);
    if ("error" in result) return badRequest(result.error);
    replies.push(result.reply);
  }
  content.revision += 1;
  await ctx.store.put(driveBlobKey(ctx.email, id), encode(content));
  return Response.json({ presentationId: id, replies, writeControl: { requiredRevisionId: revisionId(content) } });
}

// ---------- routes ----------

const G = "https://www.googleapis.com/auth/";
const V1 = "^/slides\\.googleapis\\.com/v1/presentations";

/** Scopes per route: the Discovery `scopes` of the method (checked against the generated SDK in tests). */
const SCOPES = {
  create: [`${G}drive`, `${G}drive.file`, `${G}presentations`],
  read: [`${G}drive`, `${G}drive.file`, `${G}drive.readonly`, `${G}presentations`, `${G}presentations.readonly`],
  batchUpdate: [`${G}drive`, `${G}drive.file`, `${G}drive.readonly`, `${G}presentations`, `${G}spreadsheets`, `${G}spreadsheets.readonly`],
};

export const routes: FakeRoute[] = [
  { method: "POST", pattern: new RegExp(`${V1}$`), scopes: SCOPES.create, handle: createPresentation },
  { method: "POST", pattern: new RegExp(`${V1}/([^/]+):batchUpdate$`), scopes: SCOPES.batchUpdate, handle: batchUpdate },
  // `{+presentationId}`: the id is a reserved expansion in Discovery.
  { method: "GET", pattern: new RegExp(`${V1}/(.+)$`), scopes: SCOPES.read, handle: getPresentation },
];

// ---------- seed presets ----------

const SEED = "seed-slides-template";

const TEMPLATE: SlidesContent = {
  kind: "fake#presentation",
  title: "Certificate template",
  locale: "en",
  revision: 1,
  slides: [
    {
      objectId: "seed-slide-1",
      elements: [
        { objectId: "seed-title", text: "Certificate for {{name}}\n" },
        { objectId: "seed-body", text: "Awarded to {{name}} on {{date}}\n" },
      ],
    },
    { objectId: "seed-slide-2", elements: [{ objectId: "seed-footer", text: "Thank you, {{name}}!\n" }] },
  ],
};

const templateBlob = { key: `drive:blob:{email}:${SEED}`, value: encode(TEMPLATE) };

/**
 * `default`: the template with `{{name}}` placeholders, reachable through Slides only, so Drive listings of
 * the default seed stay as they are. `templates`: the same template registered as a Drive file, so
 * `drive.files.copy` can copy it (fill-a-template flows).
 */
export const presets: SeedPresets = {
  default: [templateBlob],
  templates: [templateBlob, { key: `drive:file:{email}:${SEED}`, value: driveFile(SEED, TEMPLATE.title, "2026-11-01T09:00:00.000Z") }],
};
