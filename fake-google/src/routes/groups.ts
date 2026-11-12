import { EMAIL_RE, fakeKey, type JsonValue } from "../store";
import { badRequest, conflict, forbidden, noContent, notFound, paginate, readJsonObject } from "./google-http";
import type { FakeContext, FakeRoute, SeedPresets } from "./index";

// ---------- model ----------

/** Stored at `groups:group:<email>:<groupId>`: the Directory group as the API returns it. */
interface GroupRecord {
  [key: string]: JsonValue;
  kind: string;
  id: string;
  email: string;
  name: string;
  directMembersCount: string;
  adminCreated: boolean;
}

/** Stored at `groups:member:<email>:<groupId>/<memberEmail>`. */
interface MemberRecord {
  [key: string]: JsonValue;
  kind: string;
  id: string;
  email: string;
  role: string;
  type: string;
  status: string;
}

type SettingsRecord = Record<string, JsonValue>;

const groupKey = (email: string, id: string) => fakeKey("groups", "group", email, id);
const groupPrefix = (email: string) => `groups:group:${email}:`;
const memberPrefix = (email: string, groupId: string) => `groups:member:${email}:${groupId}/`;
const settingsKey = (email: string, groupId: string) => fakeKey("groups", "settings", email, groupId);
const profileKey = (email: string) => fakeKey("groups", "account", email, "profile");

const ROLES = ["OWNER", "MANAGER", "MEMBER"] as const;
const MEMBER_TYPES = ["USER", "GROUP"];
const PAGE_DEFAULT = 200;
const PAGE_MAX = 200;

// ---------- errors and guards ----------

const NOT_AUTHORIZED = "Not Authorized to access this resource/api";

/** A consumer (non-Workspace) account has no Directory or Groups Settings access, whatever its scopes. */
async function consumerGuard(ctx: FakeContext): Promise<Response | undefined> {
  const profile = await ctx.store.get<{ type: string }>(profileKey(ctx.email));
  return profile?.type === "consumer" ? forbidden(NOT_AUTHORIZED, "notAuthorized") : undefined;
}

const noGroup = () => notFound("Resource Not Found: groupKey");

/** A group by id, or by email (case-insensitive). */
async function findGroup(ctx: FakeContext, key: string): Promise<GroupRecord | undefined> {
  const byId = await ctx.store.get<GroupRecord>(groupKey(ctx.email, key));
  if (byId) return byId;
  const wanted = key.toLowerCase();
  return (await ctx.store.list<GroupRecord>(groupPrefix(ctx.email))).map(([, g]) => g).find((g) => g.email === wanted);
}

async function members(ctx: FakeContext, groupId: string): Promise<Array<[string, MemberRecord]>> {
  return ctx.store.list<MemberRecord>(memberPrefix(ctx.email, groupId));
}

const roleRank = (role: string) => ROLES.indexOf(role as (typeof ROLES)[number]);

async function recount(ctx: FakeContext, group: GroupRecord): Promise<void> {
  group.directMembersCount = String((await members(ctx, group.id)).length);
  await ctx.store.put(groupKey(ctx.email, group.id), group);
}

/** `maxResults` 1..200 and a numeric `pageToken`, as Directory pages its lists. */
function directoryPage<T>(ctx: FakeContext, all: T[]): ReturnType<typeof paginate<T>> {
  const raw = ctx.url.searchParams.get("maxResults");
  if (raw !== null && (!/^\d{1,9}$/.test(raw) || Number(raw) < 1 || Number(raw) > PAGE_MAX)) return { error: `maxResults must be between 1 and ${PAGE_MAX}.` };
  return paginate(all, ctx.url.searchParams, "maxResults", PAGE_DEFAULT, PAGE_MAX);
}

// ---------- Directory: groups ----------

async function listGroups(ctx: FakeContext): Promise<Response> {
  const denied = await consumerGuard(ctx);
  if (denied) return denied;
  const p = ctx.url.searchParams;
  if (p.has("query")) return badRequest("The fake does not support the query option.");
  const order = p.get("sortOrder") ?? "ASCENDING";
  if ((p.has("orderBy") && p.get("orderBy") !== "email") || (order !== "ASCENDING" && order !== "DESCENDING")) {
    return badRequest("orderBy can be email, and sortOrder ASCENDING or DESCENDING.");
  }

  let all = (await ctx.store.list<GroupRecord>(groupPrefix(ctx.email))).map(([, g]) => g);
  const domain = p.get("domain")?.toLowerCase();
  if (domain) all = all.filter((g) => g.email.endsWith(`@${domain}`));
  const userKey = p.get("userKey")?.toLowerCase();
  if (userKey) {
    const keep: GroupRecord[] = [];
    for (const g of all) if ((await members(ctx, g.id)).some(([, m]) => m.email === userKey || m.id === p.get("userKey"))) keep.push(g);
    all = keep;
  }
  all.sort((a, b) => (order === "ASCENDING" ? 1 : -1) * a.email.localeCompare(b.email));

  const paged = directoryPage(ctx, all);
  if ("error" in paged) return badRequest(paged.error);
  const out: Record<string, JsonValue> = { kind: "admin#directory#groups" };
  if (paged.page.length > 0) out.groups = paged.page;
  if (paged.nextPageToken) out.nextPageToken = paged.nextPageToken;
  return Response.json(out);
}

async function getGroup(ctx: FakeContext): Promise<Response> {
  const denied = await consumerGuard(ctx);
  if (denied) return denied;
  const group = await findGroup(ctx, decodeURIComponent(ctx.match[1] ?? ""));
  return group ? Response.json(group) : noGroup();
}

// ---------- Directory: members ----------

async function listMembers(ctx: FakeContext): Promise<Response> {
  const denied = await consumerGuard(ctx);
  if (denied) return denied;
  const group = await findGroup(ctx, decodeURIComponent(ctx.match[1] ?? ""));
  if (!group) return noGroup();
  let all = (await members(ctx, group.id)).map(([, m]) => m);
  const roles = ctx.url.searchParams.get("roles");
  if (roles !== null) {
    const wanted = roles.split(",").map((r) => r.trim());
    if (!wanted.every((r) => (ROLES as readonly string[]).includes(r))) return badRequest("roles must be a comma-separated list of OWNER, MANAGER and MEMBER.");
    all = all.filter((m) => wanted.includes(m.role));
  }
  all.sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.email.localeCompare(b.email));
  const paged = directoryPage(ctx, all);
  if ("error" in paged) return badRequest(paged.error);
  const out: Record<string, JsonValue> = { kind: "admin#directory#members" };
  if (paged.page.length > 0) out.members = paged.page;
  if (paged.nextPageToken) out.nextPageToken = paged.nextPageToken;
  return Response.json(out);
}

/** A stable numeric id per member email (FNV-1a), so the same member always has the same id. */
function memberId(email: string): string {
  let h = 0x811c9dc5;
  for (const ch of email) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return `1080${String(h).padStart(10, "0")}`;
}

async function insertMember(ctx: FakeContext): Promise<Response> {
  const denied = await consumerGuard(ctx);
  if (denied) return denied;
  const group = await findGroup(ctx, decodeURIComponent(ctx.match[1] ?? ""));
  if (!group) return noGroup();
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  if (typeof body.email !== "string" || !EMAIL_RE.test(body.email)) return badRequest("Missing or invalid email.", "invalid");
  const role = body.role ?? "MEMBER";
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) return badRequest("role must be OWNER, MANAGER or MEMBER.", "invalid");
  const type = body.type ?? "USER";
  if (typeof type !== "string" || !MEMBER_TYPES.includes(type)) return badRequest("type must be USER or GROUP.", "invalid");

  const email = body.email.toLowerCase();
  const key = `${memberPrefix(ctx.email, group.id)}${email}`;
  if (await ctx.store.get(key)) return conflict("Member already exists.");
  const rec: MemberRecord = {
    kind: "admin#directory#member",
    id: memberId(email),
    email,
    role,
    type,
    status: "ACTIVE",
  };
  await ctx.store.put(key, rec);
  await recount(ctx, group);
  return Response.json(rec);
}

async function deleteMember(ctx: FakeContext): Promise<Response> {
  const denied = await consumerGuard(ctx);
  if (denied) return denied;
  const group = await findGroup(ctx, decodeURIComponent(ctx.match[1] ?? ""));
  if (!group) return noGroup();
  const memberKey = decodeURIComponent(ctx.match[2] ?? "");
  const found = (await members(ctx, group.id)).find(([, m]) => m.email === memberKey.toLowerCase() || m.id === memberKey);
  if (!found) return notFound("Resource Not Found: memberKey");
  await ctx.store.delete(found[0]);
  await recount(ctx, group);
  return noContent();
}

// ---------- Groups Settings ----------

const BOOLEAN = ["true", "false"];
const WHO_CAN_VIEW = ["ALL_IN_DOMAIN_CAN_VIEW", "ALL_MEMBERS_CAN_VIEW", "ALL_MANAGERS_CAN_VIEW", "ALL_OWNERS_CAN_VIEW"];

/** Settings a patch may change: free text, or the values Google documents. */
const SETTABLE: Record<string, string[] | "text"> = {
  name: "text",
  description: "text",
  whoCanJoin: ["ANYONE_CAN_JOIN", "ALL_IN_DOMAIN_CAN_JOIN", "INVITED_CAN_JOIN", "CAN_REQUEST_TO_JOIN"],
  whoCanViewMembership: WHO_CAN_VIEW,
  whoCanViewGroup: ["ANYONE_CAN_VIEW", ...WHO_CAN_VIEW],
  whoCanPostMessage: ["NONE_CAN_POST", "ALL_MANAGERS_CAN_POST", "ALL_MEMBERS_CAN_POST", "ALL_OWNERS_CAN_POST", "ALL_IN_DOMAIN_CAN_POST", "ANYONE_CAN_POST"],
  messageModerationLevel: ["MODERATE_ALL_MESSAGES", "MODERATE_NON_MEMBERS", "MODERATE_NEW_MEMBERS", "MODERATE_NONE"],
  allowExternalMembers: BOOLEAN,
  allowWebPosting: BOOLEAN,
  isArchived: BOOLEAN,
  archiveOnly: BOOLEAN,
  membersCanPostAsTheGroup: BOOLEAN,
  includeInGlobalAddressList: BOOLEAN,
};

async function groupSettings(ctx: FakeContext): Promise<{ group: GroupRecord; settings: SettingsRecord } | Response> {
  const group = await findGroup(ctx, decodeURIComponent(ctx.match[1] ?? ""));
  if (!group) return notFound("Resource Not Found: groupUniqueId");
  const settings = await ctx.store.get<SettingsRecord>(settingsKey(ctx.email, group.id));
  return { group, settings: settings ?? { kind: "groupsSettings#groups", email: group.email, name: group.name } };
}

async function getSettings(ctx: FakeContext): Promise<Response> {
  const denied = await consumerGuard(ctx);
  if (denied) return denied;
  const found = await groupSettings(ctx);
  return found instanceof Response ? found : Response.json(found.settings);
}

async function patchSettings(ctx: FakeContext): Promise<Response> {
  const denied = await consumerGuard(ctx);
  if (denied) return denied;
  const found = await groupSettings(ctx);
  if (found instanceof Response) return found;
  const body = await readJsonObject(ctx.req);
  if (!body) return badRequest("Invalid JSON payload received.");
  const next: SettingsRecord = { ...found.settings };
  for (const [k, v] of Object.entries(body)) {
    const rule = SETTABLE[k];
    if (rule === undefined) return badRequest(`Invalid Input: ${k} cannot be changed here.`, "invalid");
    const ok = typeof v === "string" && (rule === "text" || rule.includes(v));
    if (!ok) return badRequest(`Invalid Input: ${k}.`, "invalid");
    next[k] = v;
  }
  await ctx.store.put(settingsKey(ctx.email, found.group.id), next);
  return Response.json(next);
}

// ---------- routes ----------

const G = "https://www.googleapis.com/auth/admin.directory.group";
const DIRECTORY = "^/admin\\.googleapis\\.com/admin/directory/v1/groups";
const SETTINGS = "^/www\\.googleapis\\.com/groups/v1/groups/([^/]+)$";

/** Scopes per route: the Discovery `scopes` of the method (checked against the generated SDK in tests). */
const SCOPES = {
  groupRead: [G, `${G}.readonly`],
  memberWrite: [G, `${G}.member`],
  memberRead: [G, `${G}.member`, `${G}.member.readonly`, `${G}.readonly`],
  settings: ["https://www.googleapis.com/auth/apps.groups.settings"],
};

export const routes: FakeRoute[] = [
  { method: "GET", pattern: new RegExp(`${DIRECTORY}$`), scopes: SCOPES.groupRead, handle: listGroups },
  { method: "GET", pattern: new RegExp(`${DIRECTORY}/([^/]+)$`), scopes: SCOPES.groupRead, handle: getGroup },
  { method: "GET", pattern: new RegExp(`${DIRECTORY}/([^/]+)/members$`), scopes: SCOPES.memberRead, handle: listMembers },
  { method: "POST", pattern: new RegExp(`${DIRECTORY}/([^/]+)/members$`), scopes: SCOPES.memberWrite, handle: insertMember },
  { method: "DELETE", pattern: new RegExp(`${DIRECTORY}/([^/]+)/members/([^/]+)$`), scopes: SCOPES.memberWrite, handle: deleteMember },
  { method: "GET", pattern: new RegExp(SETTINGS), scopes: SCOPES.settings, handle: getSettings },
  { method: "PATCH", pattern: new RegExp(SETTINGS), scopes: SCOPES.settings, handle: patchSettings },
];

// ---------- seed presets ----------

const group = (id: string, email: string, name: string, description: string, count: number) => ({
  key: `groups:group:{email}:${id}`,
  value: { kind: "admin#directory#group", id, email, name, description, directMembersCount: String(count), adminCreated: true },
});

const member = (groupId: string, n: number, email: string, role: string) => ({
  key: `groups:member:{email}:${groupId}/${email}`,
  value: { kind: "admin#directory#member", id: `10800000000000${String(n).padStart(6, "0")}`, email, role, type: "USER", status: "ACTIVE" },
});

const settings = (id: string, email: string, name: string, description: string, whoCanJoin: string) => ({
  key: `groups:settings:{email}:${id}`,
  value: {
    kind: "groupsSettings#groups",
    email,
    name,
    description,
    whoCanJoin,
    whoCanViewMembership: "ALL_MEMBERS_CAN_VIEW",
    whoCanViewGroup: "ALL_MEMBERS_CAN_VIEW",
    whoCanPostMessage: "ALL_MEMBERS_CAN_POST",
    allowExternalMembers: "false",
    allowWebPosting: "true",
    isArchived: "true",
    archiveOnly: "false",
    messageModerationLevel: "MODERATE_NONE",
    membersCanPostAsTheGroup: "false",
    includeInGlobalAddressList: "true",
  },
});

/**
 * `default`: a Workspace account with two groups on `fake.test`: `team` (the account is its owner, plus two
 * members) and `eng` (two members). `consumer`: an account that Directory and Groups Settings refuse.
 */
export const presets: SeedPresets = {
  default: [
    group("seed-group-team", "team@fake.test", "Team", "Everyone on the team", 3),
    group("seed-group-eng", "eng@fake.test", "Engineering", "Engineering discussion", 2),
    member("seed-group-team", 1, "{email}", "OWNER"),
    member("seed-group-team", 2, "dana@fake.test", "MEMBER"),
    member("seed-group-team", 3, "erin@fake.test", "MEMBER"),
    member("seed-group-eng", 4, "erin@fake.test", "MANAGER"),
    member("seed-group-eng", 5, "frank@fake.test", "MEMBER"),
    settings("seed-group-team", "team@fake.test", "Team", "Everyone on the team", "INVITED_CAN_JOIN"),
    settings("seed-group-eng", "eng@fake.test", "Engineering", "Engineering discussion", "CAN_REQUEST_TO_JOIN"),
  ],
  consumer: [{ key: "groups:account:{email}:profile", value: { type: "consumer" } }],
};
