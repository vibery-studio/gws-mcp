/**
 * Why a call is destructive: it deletes or empties data, exposes it publicly, hands it away, changes a live
 * website (publish), changes who has access (permission-change), or can spend money (spend).
 */
export type DestructiveReason =
  | "delete"
  | "trash"
  | "empty-trash"
  | "clear"
  | "public-share"
  | "owner-transfer"
  | "disconnect"
  | "publish"
  | "permission-change"
  | "spend";

/** Plain words for each reason, relayed to the person by the AI app. Typed over `DestructiveReason`: a new reason without words does not compile. */
export const DESTRUCTIVE_REASON_WORDS: Readonly<Record<DestructiveReason, string>> = {
  delete: "deletes something",
  trash: "moves something to the trash",
  "empty-trash": "permanently empties the trash",
  clear: "erases the contents",
  "public-share": "makes something visible to anyone",
  "owner-transfer": "hands ownership to someone else",
  disconnect: "disconnects a Google account",
  publish: "changes something that is live on a website",
  "permission-change": "changes who has access",
  spend: "spends money in Google Ads",
};

/** The reasons with their words, one per line fragment, for the execute tool description. */
export function describeDestructiveReasons(): string {
  return (Object.entries(DESTRUCTIVE_REASON_WORDS) as [DestructiveReason, string][]).map(([reason, words]) => `${reason} (${words})`).join(", ");
}

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
  ["access.remove", "delete"],
  // Publishing a Tag Manager version changes the tracking on a live website.
  ["tagmanager.accounts.containers.versions.publish", "publish"],
  // Tag Manager user permissions decide who can change or publish a container.
  ["tagmanager.accounts.user_permissions.create", "permission-change"],
  ["tagmanager.accounts.user_permissions.update", "permission-change"],
  ["tagmanager.accounts.user_permissions.delete", "permission-change"],
  // Re-authorizing an environment invalidates its current code, so the preview or staging snippets on a site stop working.
  ["tagmanager.accounts.containers.environments.reauthorize", "publish"],
  // Linking a destination, moving a tag id and combining containers each remove something from another container.
  ["tagmanager.accounts.containers.destinations.link", "delete"],
  ["tagmanager.accounts.containers.move_tag_id", "delete"],
  ["tagmanager.accounts.containers.combine", "delete"],
  // Archiving cannot be undone, and shortening retention drops older event data.
  ["analyticsadmin.properties.customDimensions.archive", "delete"],
  ["analyticsadmin.properties.customMetrics.archive", "delete"],
  ["analyticsadmin.properties.updateDataRetentionSettings", "delete"],
]);

/** Reverting a Tag Manager entity throws away its workspace changes, and removes it when the workspace added it. */
const TAGMANAGER_PREFIX = "tagmanager.";
const REVERT_SUFFIX = ".revert";

/** Every Google Ads mutate can change campaigns, budgets or bids, so each one can spend money. */
const ADS_PREFIX = "googleads.";
const ADS_MUTATE_SUFFIX = ".mutate";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !ArrayBuffer.isView(value) ? (value as Record<string, unknown>) : undefined;
}

/** Case-insensitive on purpose: flagging a value Google would reject anyway costs nothing. */
function equalsIgnoringCase(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.toLowerCase() === expected;
}

function isTrue(value: unknown): boolean {
  return value === true;
}

// ---- Field names in any spelling ------------------------------------------------------------------------

/**
 * A request kind or field name compared without case or underscores: Google's JSON parser also accepts the proto
 * field name (`pending_owner` for `pendingOwner`, `delete_object` for `deleteObject`), so every spelling must be read.
 */
const kindKey = (kind: string): string => kind.replace(/_/g, "").toLowerCase();

/** Each object's keys folded once (`kindKey`), each folded key holding the values of every spelling given. */
const folded = new WeakMap<object, ReadonlyMap<string, readonly unknown[]>>();

function foldedFields(record: Record<string, unknown>): ReadonlyMap<string, readonly unknown[]> {
  let map = folded.get(record);
  if (map === undefined) {
    const built = new Map<string, unknown[]>();
    for (const [k, v] of Object.entries(record)) {
      const key = kindKey(k);
      const list = built.get(key);
      if (list === undefined) built.set(key, [v]);
      else list.push(v);
    }
    map = built;
    folded.set(record, map);
  }
  return map;
}

/**
 * Every value found by following `names` from `value`, each name matched in any spelling. The one way rules read
 * input: no rule reads a key as written, so a snake_case spelling is never missed.
 */
function fieldPath(value: unknown, ...names: string[]): unknown[] {
  let current: unknown[] = [value];
  for (const name of names) {
    const key = kindKey(name);
    current = current.flatMap((v) => {
      const r = asRecord(v);
      return r === undefined ? [] : [...(foldedFields(r).get(key) ?? [])];
    });
  }
  return current;
}

/** All values of a record, under every spelling. */
function allValues(value: unknown): unknown[] {
  const r = asRecord(value);
  return r === undefined ? [] : [...foldedFields(r).values()].flat();
}

const DRIVE_PERMISSION_WRITES: ReadonlySet<string> = new Set(["drive.permissions.create", "drive.permissions.update", "drive.permissions.patch"]);
const DRIVE_PERMISSION_CHANGES: ReadonlySet<string> = new Set(["drive.permissions.update", "drive.permissions.patch"]);
const CALENDAR_ACL_WRITES: ReadonlySet<string> = new Set(["calendar.acl.insert", "calendar.acl.update", "calendar.acl.patch"]);
const CALENDAR_ACL_CHANGES: ReadonlySet<string> = new Set(["calendar.acl.update", "calendar.acl.patch"]);

/** The ids Drive gives the permission that shares a file with anyone (with the link, or discoverable). */
const DRIVE_ANYONE_PERMISSION_IDS: ReadonlySet<string> = new Set(["anyonewithlink", "anyone"]);
/** The lowest Drive role: setting it never widens access. */
const DRIVE_LOWEST_ROLE = "reader";

/**
 * Whether a Drive permission change raises what it allows: a role above reader (owner is handled as an owner
 * transfer), or discovery switched on.
 */
function raisesDriveAccess(args: unknown): boolean {
  const roles = fieldPath(args, "requestBody", "role");
  return roles.some((r) => typeof r === "string" && !equalsIgnoringCase(r, DRIVE_LOWEST_ROLE)) || fieldPath(args, "requestBody", "allowFileDiscovery").some(isTrue);
}

/**
 * A Drive permission change whose target permission must be looked up to tell whether it shares with anyone or a
 * domain: it raises access on a permission id that is not one of the fixed anyone ids. The dispatcher reads the
 * permission's type from Google and treats it as a public share when it is `anyone` or `domain`, or cannot be read.
 */
export function needsDrivePermissionLookup(fn: string, input?: unknown): boolean {
  if (!DRIVE_PERMISSION_CHANGES.has(fn) || isDestructive(fn, input).destructive || !raisesDriveAccess(input)) return false;
  return !fieldPath(input, "permissionId").some((id) => typeof id === "string" && DRIVE_ANYONE_PERMISSION_IDS.has(id.toLowerCase()));
}

/** A Drive permission that hands the file away (owner, pending owner) or opens it to anyone or to discovery. */
function drivePermission(fn: string, args: unknown): Destructiveness {
  if (
    fieldPath(args, "transferOwnership").some(isTrue) ||
    fieldPath(args, "requestBody", "pendingOwner").some(isTrue) ||
    fieldPath(args, "requestBody", "role").some((r) => equalsIgnoringCase(r, "owner"))
  ) {
    return { destructive: true, reason: "owner-transfer" };
  }
  if (fieldPath(args, "requestBody", "type").some((t) => equalsIgnoringCase(t, "anyone")) || fieldPath(args, "requestBody", "allowFileDiscovery").some(isTrue)) {
    return { destructive: true, reason: "public-share" };
  }
  // Raising the role of the existing anyone permission widens what everyone with the link can do.
  if (
    DRIVE_PERMISSION_CHANGES.has(fn) &&
    raisesDriveAccess(args) &&
    fieldPath(args, "permissionId").some((id) => typeof id === "string" && DRIVE_ANYONE_PERMISSION_IDS.has(id.toLowerCase()))
  ) {
    return { destructive: true, reason: "public-share" };
  }
  return { destructive: false };
}

/** A Calendar access rule for everyone (`default`) or a whole domain, by the rule id a change names. */
function isWideCalendarRule(ruleId: unknown): boolean {
  return typeof ruleId === "string" && (equalsIgnoringCase(ruleId, "default") || ruleId.toLowerCase().startsWith("domain:"));
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
  const replacements = fieldPath(request, "replaceText");
  return replacements.length === 0 || replacements.some((text) => text === "" || text === null);
}

/** Whether a batchUpdate body holds any request that removes content. */
function deletesInBatch(fn: string, args: unknown): boolean {
  const kinds = DELETING_KIND_KEYS.get(fn);
  const replaceErases = REPLACE_ALL_TEXT_METHODS.has(fn);
  if (!kinds && !replaceErases) return false;
  const requests = fieldPath(args, "requestBody", "requests").flatMap((r) => (Array.isArray(r) ? r : []));
  return requests.some((r) => {
    const record = asRecord(r);
    if (record === undefined) return false;
    return [...foldedFields(record)].some(([key, values]) => kinds?.has(key) === true || (replaceErases && key === REPLACE_ALL_TEXT && values.some(erasesMatches)));
  });
}

/** Publishing a form makes it visible to others, like a public share. Unpublishing is not flagged. */
function publishesForm(args: unknown): boolean {
  return fieldPath(args, "requestBody", "publishSettings", "publishState", "isPublished").some(isTrue);
}

const TASK_WRITES: ReadonlySet<string> = new Set(["tasks.tasks.patch", "tasks.tasks.update"]);

/** Tag Manager `bulk_update`: the `changeStatus` values of a change that removes an entity from the workspace. */
export const TAGMANAGER_DELETING_STATUSES: readonly string[] = ["deleted"];
const TAGMANAGER_BULK_UPDATE = "tagmanager.accounts.containers.workspaces.bulk_update";

/** Whether a `bulk_update` body holds a change whose status deletes its entity. */
function deletesInBulkUpdate(args: unknown): boolean {
  return fieldPath(args, "requestBody", "changes")
    .flatMap((changes) => (Array.isArray(changes) ? changes : []))
    .flatMap((change) => fieldPath(change, "changeStatus"))
    .some((status) => TAGMANAGER_DELETING_STATUSES.some((deleting) => equalsIgnoringCase(status, deleting)));
}

/** The Tag Manager path segment of user permissions. */
const USER_PERMISSIONS_SEGMENT = /(^|\/)user_permissions(\/|:|$)/;

/**
 * Whether a Tag Manager call's `path` or `parent` resolves into user permissions. Tag Manager methods take a
 * reserved `{+path}`. The request builder refuses a path that does not match the method's Discovery pattern, so
 * through the path only the user permission methods can reach one; this check stays as defense in depth, in case
 * a pattern is loosened. That covers the request path only, not resource names inside request bodies. Percent-
 * encoding and case are undone first, since Google may route `user%5Fpermissions` there too.
 */
function targetsUserPermissions(args: unknown): boolean {
  return [...fieldPath(args, "path"), ...fieldPath(args, "parent")].some((value) => {
    if (typeof value !== "string") return false;
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // A malformed escape is checked as written.
    }
    return USER_PERMISSIONS_SEGMENT.test(decoded.toLowerCase());
  });
}

/** Tag Manager reads of user permissions (`get`, `list`) only read; every other call into them changes access. */
function isTagManagerRead(fn: string): boolean {
  return fn.endsWith(".get") || fn.endsWith(".list");
}

/** Groups Settings writes, and the settings that open a group to people outside it. */
const GROUP_SETTINGS_WRITES: ReadonlySet<string> = new Set(["groupsSettings.groups.patch", "groupsSettings.groups.update"]);
/** A setting value granting something to anyone (`ANYONE_CAN_JOIN`, `ANYONE_CAN_VIEW` and the like). */
const ANYONE_VALUE = /^anyone_/i;

/** Whether a group settings body lets anyone join, view, discover, post or contact, or allows outside members. */
function opensGroup(args: unknown): boolean {
  const bodies = fieldPath(args, "requestBody");
  if (bodies.flatMap(allValues).some((v) => typeof v === "string" && ANYONE_VALUE.test(v))) return true;
  // Groups settings are text fields: "true" is how the setting is written.
  return fieldPath(args, "requestBody", "allowExternalMembers").some((v) => v === true || equalsIgnoringCase(v, "true"));
}

/** The calendar helper that shares with everyone when `public` is set. */
const CALENDAR_SHARE_HELPER = "calendar.share";

/**
 * The canonical destructive predicate for SDK calls. `input` is optional so name-only callers (search hints)
 * get the flags that do not depend on input; input-dependent cases (public share, ownership transfer,
 * trashing through an update) need the call's input. Every input field is read in any spelling (`fieldPath`).
 */
export function isDestructive(fn: string, input?: unknown): Destructiveness {
  if (fn.startsWith(TAGMANAGER_PREFIX) && !isTagManagerRead(fn) && targetsUserPermissions(input)) {
    return { destructive: true, reason: "permission-change" };
  }
  const named = BY_NAME.get(fn);
  if (named) return { destructive: true, reason: named };
  if (fn.startsWith(ADS_PREFIX) && fn.endsWith(ADS_MUTATE_SUFFIX)) return { destructive: true, reason: "spend" };
  if (fn.endsWith(".delete") || fn.endsWith(".batchDelete")) return { destructive: true, reason: "delete" };
  if (fn.endsWith(".trash")) return { destructive: true, reason: "trash" };
  if (fn.startsWith(TAGMANAGER_PREFIX) && fn.endsWith(REVERT_SUFFIX)) return { destructive: true, reason: "delete" };
  if (DRIVE_PERMISSION_WRITES.has(fn)) return drivePermission(fn, input);
  if (CALENDAR_ACL_WRITES.has(fn)) {
    // Scope "default" means everyone: the calendar becomes public. Changing the existing everyone or domain rule
    // widens or narrows what everyone (or the whole domain) sees, whatever the body says.
    if (fieldPath(input, "requestBody", "scope", "type").some((t) => equalsIgnoringCase(t, "default"))) return { destructive: true, reason: "public-share" };
    if (CALENDAR_ACL_CHANGES.has(fn) && fieldPath(input, "ruleId").some(isWideCalendarRule)) return { destructive: true, reason: "public-share" };
    return { destructive: false };
  }
  if (fn === CALENDAR_SHARE_HELPER && fieldPath(input, "public").some(isTrue)) return { destructive: true, reason: "public-share" };
  if (fn === "forms.forms.setPublishSettings" && publishesForm(input)) return { destructive: true, reason: "public-share" };
  if (fn === "drive.files.update" && fieldPath(input, "requestBody", "trashed").some(isTrue)) return { destructive: true, reason: "trash" };
  // A task marked deleted through an update is deleted.
  if (TASK_WRITES.has(fn) && fieldPath(input, "requestBody", "deleted").some(isTrue)) return { destructive: true, reason: "delete" };
  if (deletesInBatch(fn, input)) return { destructive: true, reason: "delete" };
  if (fn === TAGMANAGER_BULK_UPDATE && deletesInBulkUpdate(input)) return { destructive: true, reason: "delete" };
  // A group anyone can join or view, or one open to outside members, is a public share.
  if (GROUP_SETTINGS_WRITES.has(fn) && opensGroup(input)) return { destructive: true, reason: "public-share" };
  return { destructive: false };
}
