/** Why a call is destructive: it deletes or empties data, exposes it publicly, or hands it away. */
export type DestructiveReason = "delete" | "trash" | "empty-trash" | "clear" | "public-share" | "owner-transfer" | "disconnect";

export interface Destructiveness {
  destructive: boolean;
  reason?: DestructiveReason;
}

const BY_NAME: ReadonlyMap<string, DestructiveReason> = new Map([
  ["drive.files.emptyTrash", "empty-trash"],
  ["calendar.calendars.clear", "clear"],
  ["sheets.spreadsheets.values.clear", "clear"],
  ["sheets.spreadsheets.values.batchClear", "clear"],
  ["sheets.spreadsheets.values.batchClearByDataFilter", "clear"],
  ["tasks.tasks.clear", "clear"],
  ["calendar.calendars.transferOwnership", "owner-transfer"],
  ["accounts.disconnect", "disconnect"],
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Case-insensitive on purpose: flagging a value Google would reject anyway costs nothing. */
function equalsIgnoringCase(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.toLowerCase() === expected;
}

const DRIVE_PERMISSION_WRITES: ReadonlySet<string> = new Set(["drive.permissions.create", "drive.permissions.update"]);
const CALENDAR_ACL_WRITES: ReadonlySet<string> = new Set(["calendar.acl.insert", "calendar.acl.update", "calendar.acl.patch"]);

/** A Drive permission that hands the file away (owner, pending owner) or opens it to anyone or to discovery. */
function drivePermission(input: Record<string, unknown> | undefined): Destructiveness {
  const body = asRecord(input?.requestBody);
  if (input?.transferOwnership === true || body?.pendingOwner === true || equalsIgnoringCase(body?.role, "owner")) {
    return { destructive: true, reason: "owner-transfer" };
  }
  if (equalsIgnoringCase(body?.type, "anyone") || body?.allowFileDiscovery === true) return { destructive: true, reason: "public-share" };
  return { destructive: false };
}

/**
 * A request kind or field name compared without case or underscores: Google's JSON parser also accepts the proto
 * field name (`delete_object` for `deleteObject`), so either spelling must be flagged.
 */
const kindKey = (kind: string): string => kind.replace(/_/g, "").toLowerCase();

/** Every value stored under any spelling of `name`; more than one when the caller sent several spellings. */
function fieldValues(record: Record<string, unknown> | undefined, name: string): unknown[] {
  if (!record) return [];
  const key = kindKey(name);
  return Object.keys(record)
    .filter((k) => kindKey(k) === key)
    .map((k) => record[k]);
}

/**
 * Request kinds of the Docs, Slides and Forms batchUpdate methods that remove content or objects. Formatting
 * removals (paragraph bullets) are not destructive. Kinds are matched only for the method they belong to.
 */
export const DELETING_REQUEST_KINDS: Readonly<Record<string, readonly string[]>> = {
  "docs.documents.batchUpdate": [
    "deleteContentRange",
    "deletePositionedObject",
    "deleteTableRow",
    "deleteTableColumn",
    "deleteHeader",
    "deleteFooter",
    "deleteTab",
    "deleteNamedRange",
    "deleteComment",
    "deleteCommentReply",
    "deleteSuggestion",
    "deleteDropdownDefinition",
  ],
  "slides.presentations.batchUpdate": ["deleteObject", "deleteText", "deleteTableRow", "deleteTableColumn", "deleteComment", "deleteCommentReply"],
  "forms.forms.batchUpdate": ["deleteItem"],
};

const DELETING_KIND_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(DELETING_REQUEST_KINDS).map(([fn, kinds]) => [fn, new Set(kinds.map(kindKey))]),
);

/** batchUpdate methods with a `replaceAllText` request kind. */
const REPLACE_ALL_TEXT_METHODS: ReadonlySet<string> = new Set(["docs.documents.batchUpdate", "slides.presentations.batchUpdate"]);
const REPLACE_ALL_TEXT = kindKey("replaceAllText");

/** A `replaceAllText` with no replacement (missing, null or empty) erases every match. */
function erasesMatches(request: unknown): boolean {
  const replacements = fieldValues(asRecord(request), "replaceText");
  return replacements.length === 0 || replacements.some((text) => text === "" || text === null);
}

/** Whether a batchUpdate body holds any request that removes content. */
function deletesInBatch(fn: string, body: Record<string, unknown> | undefined): boolean {
  const kinds = DELETING_KIND_KEYS.get(fn);
  const replaceErases = REPLACE_ALL_TEXT_METHODS.has(fn);
  const requests = body?.requests;
  if ((!kinds && !replaceErases) || !Array.isArray(requests)) return false;
  return requests.some((r) =>
    Object.entries(asRecord(r) ?? {}).some(([kind, value]) => {
      const key = kindKey(kind);
      return kinds?.has(key) === true || (replaceErases && key === REPLACE_ALL_TEXT && erasesMatches(value));
    }),
  );
}

/** Publishing a form makes it visible to others, like a public share. Unpublishing is not flagged. */
function publishesForm(body: Record<string, unknown> | undefined): boolean {
  return fieldValues(body, "publishSettings")
    .flatMap((settings) => fieldValues(asRecord(settings), "publishState"))
    .flatMap((state) => fieldValues(asRecord(state), "isPublished"))
    .includes(true);
}

const TASK_WRITES: ReadonlySet<string> = new Set(["tasks.tasks.patch", "tasks.tasks.update"]);

/**
 * The canonical destructive predicate for SDK calls. `input` is optional so name-only callers (search hints)
 * get the flags that do not depend on input; input-dependent cases (public share, ownership transfer,
 * trashing through an update) need the call's input.
 */
export function isDestructive(fn: string, input?: unknown): Destructiveness {
  const named = BY_NAME.get(fn);
  if (named) return { destructive: true, reason: named };
  if (fn.endsWith(".delete") || fn.endsWith(".batchDelete")) return { destructive: true, reason: "delete" };
  if (fn.endsWith(".trash")) return { destructive: true, reason: "trash" };
  const args = asRecord(input);
  if (DRIVE_PERMISSION_WRITES.has(fn)) return drivePermission(args);
  const body = asRecord(args?.requestBody);
  // Calendar ACL scope "default" means everyone: the calendar becomes public.
  if (CALENDAR_ACL_WRITES.has(fn) && equalsIgnoringCase(asRecord(body?.scope)?.type, "default")) {
    return { destructive: true, reason: "public-share" };
  }
  if (fn === "forms.forms.setPublishSettings" && publishesForm(body)) return { destructive: true, reason: "public-share" };
  if (fn === "drive.files.update" && body?.trashed === true) return { destructive: true, reason: "trash" };
  // A task marked deleted through an update is deleted.
  if (TASK_WRITES.has(fn) && body?.deleted === true) return { destructive: true, reason: "delete" };
  if (deletesInBatch(fn, body)) return { destructive: true, reason: "delete" };
  return { destructive: false };
}
