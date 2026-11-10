import { googleError, randomToken } from "../oauth";
import { fakeKey, type JsonValue } from "../store";
import type { FakeContext, FakeRoute, SeedPresets } from "./index";

// ---------- model ----------

interface FormInfo {
  [key: string]: JsonValue;
  title: string;
  documentTitle: string;
}

/** Stored at `forms:form:<email>:<id>`. Items are kept as the API returns them. */
interface FormRecord {
  [key: string]: JsonValue;
  formId: string;
  info: FormInfo;
  items: JsonValue[];
  revision: number;
  published: boolean;
  emailCollectionType: "DO_NOT_COLLECT" | "VERIFIED" | "RESPONDER_INPUT";
}

/** Stored at `forms:response:<email>:<formId>/<responseId>`: the FormResponse as the API returns it. */
interface ResponseRecord {
  [key: string]: JsonValue;
  responseId: string;
  formId: string;
  lastSubmittedTime: string;
}

/** Google returns at most this many responses per page when pageSize is unset or zero. */
const MAX_PAGE = 5000;

const formKey = (email: string, id: string) => fakeKey("forms", "form", email, id);
const responsePrefix = (email: string, formId: string) => `forms:response:${email}:${formId}/`;

const revisionId = (rec: FormRecord) => String(rec.revision).padStart(8, "0");

function render(rec: FormRecord): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { formId: rec.formId, info: rec.info, settings: { emailCollectionType: rec.emailCollectionType } };
  if (rec.items.length > 0) out.items = rec.items;
  out.revisionId = revisionId(rec);
  out.responderUri = `https://docs.google.com/forms/d/e/${rec.formId}/viewform`;
  out.publishSettings = { publishState: { isPublished: rec.published, isAcceptingResponses: rec.published } };
  return out;
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

// ---------- handlers ----------

const idOf = (ctx: FakeContext) => decodeURIComponent(ctx.match[1] ?? "");

/** Google copies only `info.title` and `info.documentTitle` on create; any other field is refused. */
async function createForm(ctx: FakeContext): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  const unpublished = ctx.url.searchParams.get("unpublished");
  if (unpublished !== null && unpublished !== "true" && unpublished !== "false") {
    return badRequest(`Invalid value at 'unpublished' (TYPE_BOOL), "${unpublished}"`);
  }
  const extra = Object.keys(body).filter((k) => k !== "info");
  if (extra.length > 0) return badRequest(`Only info.title and info.documentTitle can be set on create; got ${extra.join(", ")}.`);
  const info = body.info;
  if (!isObject(info)) return badRequest("info.title is required.");
  const extraInfo = Object.keys(info).filter((k) => k !== "title" && k !== "documentTitle");
  if (extraInfo.length > 0) return badRequest(`Only info.title and info.documentTitle can be set on create; got info.${extraInfo.join(", info.")}.`);
  if (typeof info.title !== "string") return badRequest("info.title is required.");
  if (info.documentTitle !== undefined && typeof info.documentTitle !== "string") return badRequest("Invalid value at 'form.info.document_title'");
  const documentTitle = typeof info.documentTitle === "string" && info.documentTitle !== "" ? info.documentTitle : info.title || "Untitled form";

  const rec: FormRecord = {
    formId: `1${randomToken(32)}`,
    info: { title: info.title, documentTitle },
    items: [],
    revision: 1,
    published: unpublished !== "true",
    emailCollectionType: "DO_NOT_COLLECT",
  };
  await ctx.store.put(formKey(ctx.email, rec.formId), rec);
  return Response.json(render(rec));
}

async function getForm(ctx: FakeContext): Promise<Response> {
  const rec = await ctx.store.get<FormRecord>(formKey(ctx.email, idOf(ctx)));
  return rec ? Response.json(render(rec)) : notFound(idOf(ctx));
}

const INFO_FIELDS = ["title", "description"] as const;

/** Applies one request to `rec` in place, or returns why it is invalid. */
function applyRequest(rec: FormRecord, request: unknown, i: number): string | undefined {
  const kinds = isObject(request) ? Object.keys(request) : [];
  const [kind] = kinds;
  if (kinds.length !== 1 || kind === undefined) return `requests[${i}] must set exactly one request kind.`;
  const arg = (request as Record<string, unknown>)[kind];

  if (kind === "updateFormInfo") {
    if (!isObject(arg) || !isObject(arg.info)) return `requests[${i}].updateFormInfo.info is required.`;
    const info = arg.info;
    if (typeof arg.updateMask !== "string" || arg.updateMask.trim() === "") return `requests[${i}].updateFormInfo.updateMask is required.`;
    const mask = arg.updateMask === "*" ? [...INFO_FIELDS] : arg.updateMask.split(",").map((f) => f.trim());
    for (const f of mask) {
      if (!(INFO_FIELDS as readonly string[]).includes(f)) return `requests[${i}].updateFormInfo.updateMask: field '${f}' cannot be updated.`;
      const value = info[f];
      if (value !== undefined && typeof value !== "string") return `requests[${i}].updateFormInfo.info.${f} must be a string.`;
      if (f === "title") rec.info.title = typeof value === "string" ? value : "";
      else if (typeof value === "string" && value !== "") rec.info.description = value;
      else delete rec.info.description;
    }
    return undefined;
  }

  if (kind === "deleteItem") {
    const index = isObject(arg) && isObject(arg.location) ? arg.location.index : undefined;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= rec.items.length) {
      return `requests[${i}].deleteItem.location.index must be between 0 and ${rec.items.length - 1}.`;
    }
    rec.items.splice(index, 1);
    return undefined;
  }

  return `requests[${i}]: the fake supports updateFormInfo and deleteItem requests only, not ${kind}.`;
}

async function batchUpdate(ctx: FakeContext): Promise<Response> {
  const id = idOf(ctx);
  const rec = await ctx.store.get<FormRecord>(formKey(ctx.email, id));
  if (!rec) return notFound(id);
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  const requests = body.requests;
  if (!Array.isArray(requests) || requests.length === 0) return badRequest("requests must be a non-empty list.");
  const required = isObject(body.writeControl) ? body.writeControl.requiredRevisionId : undefined;
  if (required !== undefined && required !== revisionId(rec)) {
    return badRequest(`The revision ${String(required)} is not the latest revision of the form.`, "failedPrecondition");
  }
  // All or nothing, like Google: an invalid request leaves the form unchanged (`rec` is a fresh copy).
  for (const [i, request] of requests.entries()) {
    const error = applyRequest(rec, request, i);
    if (error) return badRequest(error);
  }
  rec.revision += 1;
  await ctx.store.put(formKey(ctx.email, id), rec);
  const out: Record<string, JsonValue> = {};
  if (body.includeFormInResponse === true) out.form = render(rec);
  out.replies = requests.map(() => ({}));
  out.writeControl = { requiredRevisionId: revisionId(rec) };
  return Response.json(out);
}

/** `timestamp > T` or `timestamp >= T` (RFC 3339), the only filters Google supports. */
function parseFilter(filter: string): ((t: number) => boolean) | undefined {
  const m = /^\s*timestamp\s*(>=|>)\s*(\S+)\s*$/.exec(filter);
  const at = m?.[2] === undefined ? Number.NaN : Date.parse(m[2]);
  if (!m || Number.isNaN(at)) return undefined;
  return m[1] === ">=" ? (t) => t >= at : (t) => t > at;
}

async function listResponses(ctx: FakeContext): Promise<Response> {
  const id = idOf(ctx);
  if (!(await ctx.store.get(formKey(ctx.email, id)))) return notFound(id);
  const p = ctx.url.searchParams;
  const sizeRaw = p.get("pageSize");
  const size = sizeRaw === null ? 0 : Number(sizeRaw);
  if (!Number.isInteger(size) || size < 0) return badRequest(`Invalid value at 'page_size' (TYPE_INT32), "${sizeRaw ?? ""}"`);
  const tokenRaw = p.get("pageToken");
  if (tokenRaw !== null && !/^\d{1,9}$/.test(tokenRaw)) return badRequest("Invalid page token.");
  const offset = tokenRaw === null ? 0 : Number(tokenRaw);
  const filterRaw = p.get("filter");
  const filter = filterRaw === null ? () => true : parseFilter(filterRaw);
  if (!filter) return badRequest(`Unsupported filter: ${filterRaw ?? ""}`);

  const all = (await ctx.store.list<ResponseRecord>(responsePrefix(ctx.email, id)))
    .map(([, r]) => r)
    .filter((r) => filter(Date.parse(r.lastSubmittedTime)))
    .sort((a, b) => a.lastSubmittedTime.localeCompare(b.lastSubmittedTime) || a.responseId.localeCompare(b.responseId));
  const page = all.slice(offset, offset + Math.min(size === 0 ? MAX_PAGE : size, MAX_PAGE));
  // Google omits empty fields: a form without responses lists as `{}`.
  const body: Record<string, JsonValue> = {};
  if (page.length > 0) body.responses = page;
  if (offset + page.length < all.length) body.nextPageToken = String(offset + page.length);
  return Response.json(body);
}

// ---------- routes ----------

const G = "https://www.googleapis.com/auth/";
const V1 = "^/forms\\.googleapis\\.com/v1/forms";

/** Scopes per route: the Discovery `scopes` of the method (checked against the generated SDK in tests). */
const SCOPES = {
  write: [`${G}drive`, `${G}drive.file`, `${G}forms.body`],
  read: [`${G}drive`, `${G}drive.file`, `${G}drive.readonly`, `${G}forms.body`, `${G}forms.body.readonly`],
  responses: [`${G}drive`, `${G}drive.file`, `${G}forms.responses.readonly`],
};

export const routes: FakeRoute[] = [
  { method: "POST", pattern: new RegExp(`${V1}$`), scopes: SCOPES.write, handle: createForm },
  { method: "POST", pattern: new RegExp(`${V1}/([^/]+):batchUpdate$`), scopes: SCOPES.write, handle: batchUpdate },
  { method: "GET", pattern: new RegExp(`${V1}/([^/]+)/responses$`), scopes: SCOPES.responses, handle: listResponses },
  { method: "GET", pattern: new RegExp(`${V1}/([^/]+)$`), scopes: SCOPES.read, handle: getForm },
];

// ---------- seed preset ----------

const SEED_FORM = "seed-form-feedback";

function seedResponse(id: string, submitted: string, respondent: string, name: string, rating: string) {
  const text = (questionId: string, value: string) => ({ questionId, textAnswers: { answers: [{ value }] } });
  const value: ResponseRecord = {
    formId: SEED_FORM,
    responseId: id,
    createTime: submitted,
    lastSubmittedTime: submitted,
    respondentEmail: respondent,
    answers: { "q-name": text("q-name", name), "q-rating": text("q-rating", rating) },
  };
  return { key: `forms:response:{email}:${SEED_FORM}/${id}`, value };
}

/** A two-question feedback form with two responses (respondents use reserved-TLD addresses). */
export const presets: SeedPresets = {
  default: [
    {
      key: `forms:form:{email}:${SEED_FORM}`,
      value: {
        formId: SEED_FORM,
        info: { title: "Workshop feedback", documentTitle: "Workshop feedback", description: "Two questions, two minutes." },
        items: [
          { itemId: "seed-item-name", title: "Your name", questionItem: { question: { questionId: "q-name", required: true, textQuestion: {} } } },
          {
            itemId: "seed-item-rating",
            title: "How useful was it?",
            questionItem: {
              question: {
                questionId: "q-rating",
                choiceQuestion: { type: "RADIO", options: [{ value: "Very" }, { value: "Somewhat" }, { value: "Not really" }] },
              },
            },
          },
        ],
        revision: 1,
        published: true,
        emailCollectionType: "VERIFIED",
      },
    },
    seedResponse("seed-response-1", "2026-11-05T02:15:00.000Z", "dana@fake.test", "Dana", "Very"),
    seedResponse("seed-response-2", "2026-11-06T09:30:00.000Z", "erin@fake.test", "Erin", "Somewhat"),
  ],
};
