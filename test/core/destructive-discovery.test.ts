import { describe, expect, it } from "vitest";
import docsDiscovery from "../../discovery/docs.v1.json?raw";
import formsDiscovery from "../../discovery/forms.v1.json?raw";
import groupsSettingsDiscovery from "../../discovery/groupssettings.v1.json?raw";
import slidesDiscovery from "../../discovery/slides.v1.json?raw";
import tagManagerDiscovery from "../../discovery/tagmanager.v2.json?raw";
import { DELETING_REQUEST_KINDS, TAGMANAGER_DELETING_STATUSES, isDestructive } from "../../src/core/destructive";
import { generatedFns } from "../../src/sdk/generated/index";

/** The pinned Discovery doc of each batchUpdate method whose request kinds are checked for deletes. */
const DISCOVERY: Readonly<Record<string, string>> = {
  "docs.documents.batchUpdate": docsDiscovery,
  "slides.presentations.batchUpdate": slidesDiscovery,
  "forms.forms.batchUpdate": formsDiscovery,
};

/** Kinds named `delete*` that remove only formatting, not content, so they are deliberately not flagged. */
const FORMATTING_ONLY: Readonly<Record<string, string>> = {
  deleteParagraphBullets: "removes the bullets of the paragraphs; their text stays",
};

type Json = Record<string, unknown>;

function child(node: unknown, key: string, where: string): Json {
  const value = typeof node === "object" && node !== null ? (node as Json)[key] : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Discovery has no object at ${where}.${key}`);
  return value as Json;
}

function ref(node: Json, where: string): string {
  const target = node.$ref;
  if (typeof target !== "string") throw new Error(`Discovery has no $ref at ${where}`);
  return target;
}

/** The request kinds a batchUpdate method accepts: the properties of its `requests` item schema. */
function requestKinds(fn: string): string[] {
  const raw = DISCOVERY[fn];
  if (raw === undefined) throw new Error(`no pinned Discovery doc for ${fn}`);
  const doc = JSON.parse(raw) as unknown;
  const [, resource, method] = fn.split(".");
  if (resource === undefined || method === undefined) throw new Error(`unexpected method name ${fn}`);
  const request = child(child(child(child(doc, "resources", fn), resource, fn), "methods", fn), method, fn);
  const schemas = child(doc, "schemas", fn);
  const bodySchema = child(schemas, ref(child(request, "request", fn), `${fn}.request`), fn);
  const items = child(child(child(bodySchema, "properties", fn), "requests", fn), "items", fn);
  const kinds = Object.keys(child(child(schemas, ref(items, `${fn}.requests.items`), fn), "properties", fn));
  if (kinds.length === 0) throw new Error(`no request kinds for ${fn}`);
  return kinds;
}

const single = (kind: string) => ({ requestBody: { requests: [{ [kind]: {} }] } });

const deleteKinds = Object.keys(DISCOVERY).flatMap((fn) => requestKinds(fn).filter((k) => k.startsWith("delete")).map((k) => [fn, k] as const));

describe("deleting request kinds against the pinned Discovery docs", () => {
  it("checks every method that has a list of deleting kinds", () => {
    expect(Object.keys(DELETING_REQUEST_KINDS).sort()).toEqual(Object.keys(DISCOVERY).sort());
  });

  it.each(deleteKinds.filter(([, kind]) => !(kind in FORMATTING_ONLY)))("%s flags %s alone as a delete", (fn, kind) => {
    expect(isDestructive(fn, single(kind))).toEqual({ destructive: true, reason: "delete" });
  });

  it.each(deleteKinds.filter(([, kind]) => kind in FORMATTING_ONLY))("%s leaves the formatting-only %s unflagged", (fn, kind) => {
    expect(isDestructive(fn, single(kind)).destructive).toBe(false);
  });

  it("lists only formatting-only exceptions that Discovery still has", () => {
    const known = new Set(deleteKinds.map(([, kind]) => kind));
    expect(Object.keys(FORMATTING_ONLY).filter((kind) => !known.has(kind))).toEqual([]);
  });

  it.each(Object.entries(DELETING_REQUEST_KINDS))("every kind listed for %s exists in Discovery", (fn, kinds) => {
    const known = new Set(requestKinds(fn));
    expect(kinds.filter((kind) => !known.has(kind))).toEqual([]);
  });
});

/** The generated SDK, which is built from the pinned Discovery docs: one entry per supported method. */
const byService = (service: string) => generatedFns.filter((fn) => fn.service === service);
const named = (name: string) => {
  const fn = generatedFns.find((f) => f.name === name);
  if (fn === undefined) throw new Error(`the generated SDK has no ${name}`);
  return fn;
};
const reasonOf = (name: string) => isDestructive(name);

describe("destructive classes of the marketing, Groups and Tag Manager services", () => {
  it("never flags a read", () => {
    expect(generatedFns.filter((fn) => fn.effect === "read" && isDestructive(fn.name).destructive).map((fn) => fn.name)).toEqual([]);
  });

  it("flags all 78 Google Ads mutates, and every other Ads write, as able to spend money", () => {
    const ads = byService("ads");
    const mutates = ads.filter((fn) => fn.name.endsWith(".mutate"));
    expect(mutates).toHaveLength(78);
    for (const fn of mutates) expect(fn.effect, fn.name).toBe("write");
    const writes = ads.filter((fn) => fn.effect === "write");
    expect(writes.map((fn) => [fn.name, reasonOf(fn.name)])).toEqual(writes.map((fn) => [fn.name, { destructive: true, reason: "spend" }]));
    expect(reasonOf("googleads.customers.googleAds.search").destructive).toBe(false);
    expect(reasonOf("googleads.customers.googleAds.searchStream").destructive).toBe(false);
  });

  it("flags a Search Console sitemap delete, and treats a sitemap submit as a plain write", () => {
    expect(reasonOf("webmasters.sitemaps.delete")).toEqual({ destructive: true, reason: "delete" });
    expect(named("webmasters.sitemaps.submit").effect).toBe("write");
    expect(reasonOf("webmasters.sitemaps.submit")).toEqual({ destructive: false });
  });

  it("flags every Analytics settings delete", () => {
    const deletes = byService("analyticsadmin").filter((fn) => fn.method?.httpMethod === "DELETE");
    expect(deletes).toHaveLength(8);
    expect(deletes.map((fn) => [fn.name, reasonOf(fn.name)])).toEqual(deletes.map((fn) => [fn.name, { destructive: true, reason: "delete" }]));
    expect(reasonOf("analyticsadmin.properties.delete")).toEqual({ destructive: true, reason: "delete" });
    expect(reasonOf("analyticsadmin.accounts.delete")).toEqual({ destructive: true, reason: "delete" });
  });

  it("flags a group delete and a member removal, and every other Groups delete", () => {
    expect(reasonOf(named("directory.groups.delete").name)).toEqual({ destructive: true, reason: "delete" });
    expect(reasonOf(named("directory.members.delete").name)).toEqual({ destructive: true, reason: "delete" });
    const deletes = byService("groups").filter((fn) => fn.method?.httpMethod === "DELETE");
    expect(deletes).toHaveLength(3);
    expect(deletes.map((fn) => [fn.name, reasonOf(fn.name).destructive])).toEqual(deletes.map((fn) => [fn.name, true]));
  });

  it("flags a Tag Manager version publish, container and workspace deletes, and user permission changes", () => {
    expect(reasonOf(named("tagmanager.accounts.containers.versions.publish").name)).toEqual({ destructive: true, reason: "publish" });
    expect(reasonOf(named("tagmanager.accounts.containers.delete").name)).toEqual({ destructive: true, reason: "delete" });
    expect(reasonOf(named("tagmanager.accounts.containers.workspaces.delete").name)).toEqual({ destructive: true, reason: "delete" });
    const permissions = byService("tagmanager").filter((fn) => fn.name.startsWith("tagmanager.accounts.user_permissions.") && fn.effect === "write");
    expect(permissions.map((fn) => fn.name).sort()).toEqual([
      "tagmanager.accounts.user_permissions.create",
      "tagmanager.accounts.user_permissions.delete",
      "tagmanager.accounts.user_permissions.update",
    ]);
    for (const fn of permissions) expect(reasonOf(fn.name), fn.name).toEqual({ destructive: true, reason: "permission-change" });
  });

  it("treats every Tag Manager create, update and delete as a write, and flags every delete", () => {
    const changes = byService("tagmanager").filter((fn) => /\.(create|update|delete)$/.test(fn.name));
    expect(changes).toHaveLength(44);
    for (const fn of changes) expect(fn.effect, fn.name).toBe("write");
    const deletes = changes.filter((fn) => fn.name.endsWith(".delete"));
    for (const fn of deletes) expect(reasonOf(fn.name).destructive, fn.name).toBe(true);
  });
});

describe("Tag Manager bulk updates against the pinned Discovery doc", () => {
  const doc = JSON.parse(tagManagerDiscovery) as unknown;
  const schemas = child(doc, "schemas", "tagmanager");
  const workspaces = child(
    child(child(child(child(child(doc, "resources", "tagmanager"), "accounts", "r"), "resources", "r"), "containers", "r"), "resources", "r"),
    "workspaces",
    "r",
  );
  const bulkUpdate = child(child(workspaces, "methods", "workspaces"), "bulk_update", "workspaces");
  const changeStatus = child(child(child(schemas, "Entity", "schemas"), "properties", "Entity"), "changeStatus", "Entity");
  const statuses = changeStatus.enum as string[];
  const descriptions = changeStatus.enumDescriptions as string[];
  /** Statuses Discovery describes as removing the entity from the workspace. */
  const deleting = statuses.filter((_, i) => /delet|remov/i.test(descriptions[i] ?? ""));
  const fn = "tagmanager.accounts.containers.workspaces.bulk_update";
  const change = (status: string) => ({ path: "accounts/1/containers/2/workspaces/3", requestBody: { changes: [{ tag: { tagId: "7" }, changeStatus: status }] } });

  it("takes a ProposedChange whose changes carry an Entity changeStatus", () => {
    expect(ref(child(bulkUpdate, "request", "bulk_update"), "bulk_update.request")).toBe("ProposedChange");
    const items = child(child(child(child(schemas, "ProposedChange", "schemas"), "properties", "ProposedChange"), "changes", "changes"), "items", "changes");
    expect(ref(items, "ProposedChange.changes.items")).toBe("Entity");
    expect(statuses.length).toBeGreaterThan(2);
  });

  it("lists exactly the deleting statuses Discovery describes", () => {
    expect([...TAGMANAGER_DELETING_STATUSES].sort()).toEqual([...deleting].sort());
  });

  it.each(statuses)("flags a change with status %s only when it deletes", (status) => {
    expect(isDestructive(fn, change(status))).toEqual(deleting.includes(status) ? { destructive: true, reason: "delete" } : { destructive: false });
  });

  it("flags a deleting change among others, in any case or field spelling", () => {
    const body = { changes: [{ trigger: { triggerId: "1" }, changeStatus: "updated" }, { variable: { variableId: "2" }, change_status: "DELETED" }] };
    expect(isDestructive(fn, { path: "accounts/1/containers/2/workspaces/3", requestBody: body })).toEqual({ destructive: true, reason: "delete" });
  });
});

describe("Tag Manager calls aimed at user permissions through the path", () => {
  it.each([
    ["tagmanager.accounts.update", "accounts/1/user_permissions/9"],
    ["tagmanager.accounts.containers.workspaces.tags.update", "accounts/1/user_permissions/9"],
    ["tagmanager.accounts.containers.versions.publish", "accounts/1/user_permissions/9"],
    ["tagmanager.accounts.containers.workspaces.tags.delete", "accounts/1/user_permissions/9"],
    ["tagmanager.accounts.update", "accounts/1/User%5Fpermissions/9"],
    ["tagmanager.accounts.update", "accounts/1/USER_PERMISSIONS/9"],
  ])("flags %s on %s as a permission change", (fn, path) => {
    expect(named(fn).effect).toBe("write");
    expect(isDestructive(fn, { path, requestBody: { emailAddress: "x@example.com", accountAccess: { permission: "admin" } } })).toEqual({
      destructive: true,
      reason: "permission-change",
    });
  });

  it("flags a create whose parent is a user permission", () => {
    expect(isDestructive("tagmanager.accounts.containers.workspaces.tags.create", { parent: "accounts/1/user_permissions/9", requestBody: {} })).toEqual({
      destructive: true,
      reason: "permission-change",
    });
  });

  it("leaves reads of user permissions and writes elsewhere alone", () => {
    expect(isDestructive("tagmanager.accounts.user_permissions.get", { path: "accounts/1/user_permissions/9" })).toEqual({ destructive: false });
    expect(isDestructive("tagmanager.accounts.user_permissions.list", { parent: "accounts/1" })).toEqual({ destructive: false });
    expect(isDestructive("tagmanager.accounts.update", { path: "accounts/1", requestBody: {} })).toEqual({ destructive: false });
    expect(isDestructive("tagmanager.accounts.containers.workspaces.tags.update", { path: "accounts/1/containers/2/workspaces/3/tags/user_permissions_tag" })).toEqual({
      destructive: false,
    });
  });
});

describe("writes of the new services that remove, relink or cannot be undone", () => {
  it.each([
    ["tagmanager.accounts.containers.destinations.link", "delete"],
    ["tagmanager.accounts.containers.move_tag_id", "delete"],
    ["tagmanager.accounts.containers.combine", "delete"],
    ["tagmanager.accounts.containers.environments.reauthorize", "publish"],
    ["analyticsadmin.properties.customDimensions.archive", "delete"],
    ["analyticsadmin.properties.customMetrics.archive", "delete"],
    ["analyticsadmin.properties.updateDataRetentionSettings", "delete"],
  ])("flags %s as %s", (fn, reason) => {
    expect(named(fn).effect).toBe("write");
    expect(isDestructive(fn)).toEqual({ destructive: true, reason });
  });

  it("flags every Tag Manager revert as a delete", () => {
    const reverts = byService("tagmanager").filter((fn) => fn.name.endsWith(".revert"));
    expect(reverts).toHaveLength(9);
    for (const fn of reverts) expect(isDestructive(fn.name), fn.name).toEqual({ destructive: true, reason: "delete" });
  });

  it("keeps group member changes as plain writes", () => {
    for (const fn of ["directory.members.insert", "directory.members.update", "directory.members.patch"]) {
      expect(named(fn).effect).toBe("write");
      expect(isDestructive(fn, { groupKey: "g", memberKey: "m", requestBody: { email: "x@example.com", role: "MEMBER" } }), fn).toEqual({ destructive: false });
    }
  });
});

describe("Groups settings that open a group, against the pinned Discovery doc", () => {
  const schemas = child(JSON.parse(groupsSettingsDiscovery) as unknown, "schemas", "groupssettings");
  const properties = child(child(schemas, "Groups", "schemas"), "properties", "Groups");
  /** Every (setting, value) pair whose documented value lets anyone in. */
  const anyone = Object.entries(properties).flatMap(([field, prop]) => {
    const description = typeof (prop as Json).description === "string" ? ((prop as Json).description as string) : "";
    return [...new Set(description.match(/\bANYONE_[A-Z_]+/g) ?? [])]
      .filter(() => field.startsWith("whoCan"))
      .map((value) => [field, value] as const);
  });
  const writes = ["groupsSettings.groups.patch", "groupsSettings.groups.update"];

  it("finds the anyone values Discovery documents", () => {
    expect(anyone.map(([field]) => field).sort()).toEqual(["whoCanContactOwner", "whoCanDiscoverGroup", "whoCanJoin", "whoCanPostMessage", "whoCanViewGroup"]);
  });

  it.each(writes.flatMap((fn) => anyone.map(([field, value]) => [fn, field, value] as const)))("%s flags %s = %s as a public share", (fn, field, value) => {
    expect(isDestructive(fn, { groupUniqueId: "g@example.com", requestBody: { [field]: value } })).toEqual({ destructive: true, reason: "public-share" });
  });

  it.each(writes)("%s flags outside members as a public share, and leaves private settings alone", (fn) => {
    expect(isDestructive(fn, { groupUniqueId: "g", requestBody: { allowExternalMembers: "true" } })).toEqual({ destructive: true, reason: "public-share" });
    expect(isDestructive(fn, { groupUniqueId: "g", requestBody: { allowExternalMembers: "false", whoCanJoin: "INVITED_CAN_JOIN" } })).toEqual({
      destructive: false,
    });
    expect(isDestructive(fn, { groupUniqueId: "g", requestBody: { whoCanViewGroup: "ALL_MEMBERS_CAN_VIEW" } })).toEqual({ destructive: false });
  });
});
