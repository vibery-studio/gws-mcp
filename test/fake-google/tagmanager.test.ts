import { describe, expect, it } from "vitest";
import accountsList from "../../fake-google/fixtures/tagmanager/accounts-list.json";
import containersList from "../../fake-google/fixtures/tagmanager/containers-list.json";
import tagsCreate from "../../fake-google/fixtures/tagmanager/tags-create.json";
import tagsList from "../../fake-google/fixtures/tagmanager/tags-list.json";
import triggersCreate from "../../fake-google/fixtures/tagmanager/triggers-create.json";
import triggersList from "../../fake-google/fixtures/tagmanager/triggers-list.json";
import userPermissionsList from "../../fake-google/fixtures/tagmanager/user-permissions-list.json";
import variablesCreate from "../../fake-google/fixtures/tagmanager/variables-create.json";
import variablesList from "../../fake-google/fixtures/tagmanager/variables-list.json";
import versionsPublish from "../../fake-google/fixtures/tagmanager/versions-publish.json";
import workspaceStatus from "../../fake-google/fixtures/tagmanager/workspace-status.json";
import workspacesCreate from "../../fake-google/fixtures/tagmanager/workspaces-create.json";
import workspacesCreateVersion from "../../fake-google/fixtures/tagmanager/workspaces-create-version.json";
import workspacesList from "../../fake-google/fixtures/tagmanager/workspaces-list.json";
import { DoStore } from "../../fake-google/src/do-store";
import { parseFixture } from "../../fake-google/src/fixtures";
import { routes } from "../../fake-google/src/routes/tagmanager";
import { G, account, api, callRoute, expectRouteScopes, json, memoryBackend, outputSchema, replay, send, type GoogleErrorBody } from "./support";

const T = `${G}tagmanager.`;
const READONLY = `${T}readonly`;
const EDIT = `${T}edit.containers`;
const VERSIONS = `${T}edit.containerversions`;
const PUBLISH = `${T}publish`;
const DELETE = `${T}delete.containers`;
const USERS = `${T}manage.users`;
const ALL = [READONLY, EDIT, VERSIONS, PUBLISH, DELETE, USERS];

const BASE = "/tagmanager.googleapis.com/tagmanager/v2";
const ACCOUNT = "accounts/6001001001";
const WEB = `${ACCOUNT}/containers/9001001`;
const SPARE = `${ACCOUNT}/containers/9001002`;
const WS = `${WEB}/workspaces/1`;
const url = (path: string) => `${BASE}/${path}`;

interface Entity {
  path: string;
  name: string;
  type: string;
  fingerprint: string;
  tagId?: string;
  triggerId?: string;
  variableId?: string;
  firingTriggerId?: string[];
}
interface Status {
  workspaceChange?: Array<{ changeStatus: string; tag?: Entity; trigger?: Entity; variable?: Entity }>;
}
interface Version {
  containerVersion: { containerVersionId: string; name?: string; description?: string; tag?: Entity[]; trigger?: Entity[]; variable?: Entity[] };
  newWorkspacePath?: string;
}

const status = (token: string, workspace = WS) => json<Status>(api(token, url(`${workspace}/status`)));
const create = (token: string, kind: "tags" | "triggers" | "variables", body: unknown, workspace = WS) => send(token, "POST", url(`${workspace}/${kind}`), body);

describe("scopes", () => {
  const CASES = [
    { fn: "tagmanager.accounts.list", method: "GET", path: url("accounts") },
    { fn: "tagmanager.accounts.containers.list", method: "GET", path: url(`${ACCOUNT}/containers`) },
    { fn: "tagmanager.accounts.containers.get", method: "GET", path: url(WEB) },
    { fn: "tagmanager.accounts.containers.delete", method: "DELETE", path: url(WEB) },
    { fn: "tagmanager.accounts.containers.workspaces.list", method: "GET", path: url(`${WEB}/workspaces`) },
    { fn: "tagmanager.accounts.containers.workspaces.get", method: "GET", path: url(WS) },
    { fn: "tagmanager.accounts.containers.workspaces.getStatus", method: "GET", path: url(`${WS}/status`) },
    { fn: "tagmanager.accounts.containers.workspaces.create", method: "POST", path: url(`${WEB}/workspaces`) },
    { fn: "tagmanager.accounts.containers.workspaces.create_version", method: "POST", path: url(`${WS}:create_version`) },
    { fn: "tagmanager.accounts.containers.workspaces.tags.list", method: "GET", path: url(`${WS}/tags`) },
    { fn: "tagmanager.accounts.containers.workspaces.tags.create", method: "POST", path: url(`${WS}/tags`) },
    { fn: "tagmanager.accounts.containers.workspaces.tags.update", method: "PUT", path: url(`${WS}/tags/1`) },
    { fn: "tagmanager.accounts.containers.workspaces.tags.delete", method: "DELETE", path: url(`${WS}/tags/1`) },
    { fn: "tagmanager.accounts.containers.workspaces.triggers.list", method: "GET", path: url(`${WS}/triggers`) },
    { fn: "tagmanager.accounts.containers.workspaces.triggers.create", method: "POST", path: url(`${WS}/triggers`) },
    { fn: "tagmanager.accounts.containers.workspaces.triggers.update", method: "PUT", path: url(`${WS}/triggers/1`) },
    { fn: "tagmanager.accounts.containers.workspaces.triggers.delete", method: "DELETE", path: url(`${WS}/triggers/1`) },
    { fn: "tagmanager.accounts.containers.workspaces.variables.list", method: "GET", path: url(`${WS}/variables`) },
    { fn: "tagmanager.accounts.containers.workspaces.variables.create", method: "POST", path: url(`${WS}/variables`) },
    { fn: "tagmanager.accounts.containers.workspaces.variables.update", method: "PUT", path: url(`${WS}/variables/1`) },
    { fn: "tagmanager.accounts.containers.workspaces.variables.delete", method: "DELETE", path: url(`${WS}/variables/1`) },
    { fn: "tagmanager.accounts.containers.versions.publish", method: "POST", path: url(`${WEB}/versions/1:publish`) },
    { fn: "tagmanager.accounts.user_permissions.list", method: "GET", path: url(`${ACCOUNT}/user_permissions`) },
    { fn: "tagmanager.accounts.user_permissions.update", method: "PUT", path: url(`${ACCOUNT}/user_permissions/1000000002`) },
  ] as const;

  it("requires exactly the Discovery scopes of each method", () => {
    expectRouteScopes(routes, CASES);
  });

  it("refuses each route for a token without any of its scopes", async () => {
    const { token } = await account([`${G}calendar.events`]);
    for (const c of CASES) {
      const res = await api(token, c.path, { method: c.method });
      expect(res.status, `${c.method} ${c.path}`).toBe(403);
      expect(((await res.json()) as GoogleErrorBody).error.details?.[0]?.reason).toBe("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    }
  });

  it("separates reading, editing, saving versions, publishing, deleting and managing users", async () => {
    const { token: ro } = await account([READONLY]);
    expect((await api(ro, url(`${WS}/tags`))).status).toBe(200);
    expect((await create(ro, "tags", { name: "x", type: "html" })).status).toBe(403);
    expect((await api(ro, url(`${ACCOUNT}/user_permissions`))).status).toBe(403);

    const { token: edit } = await account([EDIT]);
    expect((await create(edit, "tags", { name: "x", type: "html" })).status).toBe(200);
    expect((await send(edit, "POST", url(`${WS}:create_version`), {})).status).toBe(403);
    expect((await send(edit, "POST", url(`${WEB}/versions/1:publish`))).status).toBe(403);
    expect((await send(edit, "DELETE", url(SPARE))).status).toBe(403);

    const { token: users } = await account([USERS]);
    expect((await api(users, url(`${ACCOUNT}/user_permissions`))).status).toBe(200);
    expect((await api(users, url("accounts"))).status).toBe(403);

    const { token: del } = await account([DELETE]);
    expect((await send(del, "DELETE", url(SPARE))).status).toBe(204);
  });
});

describe("accounts, containers and workspaces", () => {
  it("lists the seeded account and its two containers with public GTM ids", async () => {
    const { token } = await account([READONLY]);
    const accounts = await json<{ account: Array<{ accountId: string; name: string; path: string }> }>(api(token, url("accounts")));
    expect(accounts.account).toMatchObject([{ accountId: "6001001001", name: "Example Company", path: ACCOUNT }]);
    expect(outputSchema("tagmanager.accounts.list").safeParse(accounts).success).toBe(true);

    const list = await json<{ container: Array<{ publicId: string; path: string; containerId: string }> }>(api(token, url(`${ACCOUNT}/containers`)));
    expect(list.container.map((c) => c.publicId)).toEqual(["GTM-AB12CD", "GTM-EF34GH"]);
    expect(list.container.every((c) => /^GTM-[A-Z0-9]+$/.test(c.publicId))).toBe(true);
    expect(outputSchema("tagmanager.accounts.containers.list").safeParse(list).success).toBe(true);

    const one = await json<{ publicId: string; usageContext: string[] }>(api(token, url(WEB)));
    expect(one).toMatchObject({ publicId: "GTM-AB12CD", usageContext: ["web"] });
    expect(outputSchema("tagmanager.accounts.containers.get").safeParse(one).success).toBe(true);
  });

  it("answers 404 for an unknown account, container or workspace", async () => {
    const { token } = await account([READONLY, EDIT, USERS]);
    for (const path of [`${ACCOUNT}x/containers`, `${ACCOUNT}/containers/1`, `${WEB}/workspaces/99`, `${WEB}/workspaces/99/status`, `${WEB}/workspaces/99/tags`, `accounts/1/user_permissions`]) {
      const res = await json<GoogleErrorBody>(api(token, url(path)), 404);
      expect(res.error.status, path).toBe("NOT_FOUND");
    }
    expect((await create(token, "tags", { name: "x", type: "html" }, `${WEB}/workspaces/99`)).status).toBe(404);
  });

  it("lists, gets and creates workspaces; a new one starts from the live version with nothing pending", async () => {
    const { token } = await account([READONLY, EDIT]);
    const list = await json<{ workspace: Array<{ workspaceId: string; name: string }> }>(api(token, url(`${WEB}/workspaces`)));
    expect(list.workspace.map((w) => w.workspaceId)).toEqual(["1"]);
    expect(outputSchema("tagmanager.accounts.containers.workspaces.list").safeParse(list).success).toBe(true);

    const made = await json<{ workspaceId: string; name: string; path: string }>(send(token, "POST", url(`${WEB}/workspaces`), { name: "Campaign", description: "Spring" }));
    expect(made).toMatchObject({ workspaceId: "2", name: "Campaign", path: `${WEB}/workspaces/2` });
    expect(outputSchema("tagmanager.accounts.containers.workspaces.create").safeParse(made).success).toBe(true);
    expect(await json(api(token, url(`${WEB}/workspaces/2`)))).toEqual(made);
    expect((await json<{ workspace: unknown[] }>(api(token, url(`${WEB}/workspaces`)))).workspace).toHaveLength(2);
    const tags = await json<{ tag: Entity[] }>(api(token, url(`${WEB}/workspaces/2/tags`)));
    expect(tags.tag.map((t) => t.name)).toEqual(["Page view pixel"]);
    expect(await status(token, `${WEB}/workspaces/2`)).toEqual({});

    expect((await send(token, "POST", url(`${WEB}/workspaces`), { name: "" })).status).toBe(400);
    expect((await send(token, "POST", url(`${WEB}/workspaces`), {})).status).toBe(400);
  });

  it("deletes a container with its workspaces, and the next read finds nothing", async () => {
    const { token } = await account([READONLY, DELETE]);
    expect((await send(token, "DELETE", url(WEB))).status).toBe(204);
    expect((await api(token, url(WEB))).status).toBe(404);
    expect((await api(token, url(WS))).status).toBe(404);
    expect((await api(token, url(`${WS}/tags`))).status).toBe(404);
    expect((await json<{ container: Array<{ publicId: string }> }>(api(token, url(`${ACCOUNT}/containers`)))).container.map((c) => c.publicId)).toEqual(["GTM-EF34GH"]);
    expect((await send(token, "DELETE", url(WEB))).status).toBe(404);
  });
});

describe("tags, triggers and variables", () => {
  it("lists the seeded entities with ids, paths and fingerprints", async () => {
    const { token } = await account([READONLY]);
    const tags = await json<{ tag: Entity[] }>(api(token, url(`${WS}/tags`)));
    expect(tags.tag).toMatchObject([{ name: "Page view pixel", type: "html", tagId: "1", path: `${WS}/tags/1`, firingTriggerId: ["1"] }]);
    expect(tags.tag[0]?.fingerprint).toMatch(/^\d+$/);
    expect(outputSchema("tagmanager.accounts.containers.workspaces.tags.list").safeParse(tags).success).toBe(true);
    const triggers = await json<{ trigger: Entity[] }>(api(token, url(`${WS}/triggers`)));
    expect(triggers.trigger).toMatchObject([{ name: "All pages", type: "pageview", triggerId: "1" }]);
    expect(outputSchema("tagmanager.accounts.containers.workspaces.triggers.list").safeParse(triggers).success).toBe(true);
    const variables = await json<{ variable: Entity[] }>(api(token, url(`${WS}/variables`)));
    expect(variables.variable).toMatchObject([{ name: "Page host", variableId: "1" }]);
    expect(outputSchema("tagmanager.accounts.containers.workspaces.variables.list").safeParse(variables).success).toBe(true);
  });

  it("makes each write visible on the next read: create, update, delete", async () => {
    const { token } = await account([READONLY, EDIT]);
    const made = await json<Entity>(
      create(token, "tags", {
        name: "Signup event",
        type: "html",
        parameter: [{ type: "template", key: "html", value: "<b>x</b>" }],
        firingTriggerId: ["1"],
        tagFiringOption: "oncePerLoad",
        tagId: "999",
        path: "ignored",
      }),
    );
    expect(made).toMatchObject({ tagId: "2", path: `${WS}/tags/2`, name: "Signup event" });
    expect(outputSchema("tagmanager.accounts.containers.workspaces.tags.create").safeParse(made).success).toBe(true);
    expect((await json<{ tag: Entity[] }>(api(token, url(`${WS}/tags`)))).tag.map((t) => t.name)).toEqual(["Page view pixel", "Signup event"]);

    const updated = await json<Entity>(send(token, "PUT", url(`${WS}/tags/2`), { name: "Signup event v2", type: "html", firingTriggerId: ["1"] }));
    expect(updated).toMatchObject({ tagId: "2", name: "Signup event v2" });
    expect(updated.fingerprint).not.toBe(made.fingerprint);
    expect((await json<{ tag: Entity[] }>(api(token, url(`${WS}/tags`)))).tag.map((t) => t.name)).toEqual(["Page view pixel", "Signup event v2"]);

    expect((await send(token, "DELETE", url(`${WS}/tags/2`))).status).toBe(204);
    expect((await json<{ tag: Entity[] }>(api(token, url(`${WS}/tags`)))).tag.map((t) => t.name)).toEqual(["Page view pixel"]);
    expect((await send(token, "DELETE", url(`${WS}/tags/2`))).status).toBe(404);
    expect((await send(token, "PUT", url(`${WS}/tags/2`), { name: "x", type: "html" })).status).toBe(404);
  });

  it("never reuses the id of a deleted entity", async () => {
    const { token } = await account([EDIT]);
    const first = await json<Entity>(create(token, "variables", { name: "A", type: "c" }));
    expect((await send(token, "DELETE", url(`${WS}/variables/${first.variableId}`))).status).toBe(204);
    const second = await json<Entity>(create(token, "variables", { name: "B", type: "c" }));
    expect([first.variableId, second.variableId]).toEqual(["2", "3"]);
  });

  it("creates, updates and deletes triggers and variables", async () => {
    const { token } = await account([READONLY, EDIT]);
    const trigger = await json<Entity>(create(token, "triggers", { name: "Signup click", type: "click" }));
    expect(trigger).toMatchObject({ triggerId: "2", path: `${WS}/triggers/2` });
    expect(outputSchema("tagmanager.accounts.containers.workspaces.triggers.create").safeParse(trigger).success).toBe(true);
    expect((await json<Entity>(send(token, "PUT", url(`${WS}/triggers/2`), { name: "Signup click 2", type: "linkClick" }))).type).toBe("linkClick");
    expect((await json<{ trigger: Entity[] }>(api(token, url(`${WS}/triggers`)))).trigger.map((t) => t.name)).toEqual(["All pages", "Signup click 2"]);
    expect((await send(token, "DELETE", url(`${WS}/triggers/2`))).status).toBe(204);

    const variable = await json<Entity>(create(token, "variables", { name: "Plan", type: "c", parameter: [{ type: "template", key: "value", value: "pro" }] }));
    expect(variable).toMatchObject({ variableId: "2", path: `${WS}/variables/2` });
    expect(outputSchema("tagmanager.accounts.containers.workspaces.variables.create").safeParse(variable).success).toBe(true);
    expect((await json<Entity>(send(token, "PUT", url(`${WS}/variables/2`), { name: "Plan name", type: "c" }))).name).toBe("Plan name");
    expect((await json<{ variable: Entity[] }>(api(token, url(`${WS}/variables`)))).variable.map((v) => v.name)).toEqual(["Page host", "Plan name"]);
    expect((await send(token, "DELETE", url(`${WS}/variables/2`))).status).toBe(204);
    expect((await json<{ variable: Entity[] }>(api(token, url(`${WS}/variables`)))).variable.map((v) => v.name)).toEqual(["Page host"]);
  });

  it("rejects invalid bodies with 400 and changes nothing", async () => {
    const { token } = await account([READONLY, EDIT]);
    for (const [kind, body] of [
      ["tags", {}],
      ["tags", { name: "x" }],
      ["tags", { name: "x", type: "html", tagFiringOption: "always" }],
      ["tags", { name: "x", type: "html", firingTriggerId: ["404"] }],
      ["tags", { name: "x", type: "html", firingTriggerId: "1" }],
      ["triggers", { name: "x", type: "teleport" }],
      ["triggers", { type: "click" }],
      ["variables", { name: "", type: "c" }],
    ] as const) {
      const res = await json<GoogleErrorBody>(create(token, kind, body), 400);
      expect(res.error.status, JSON.stringify(body)).toBe("INVALID_ARGUMENT");
    }
    const bad = await send(token, "POST", url(`${WS}/tags`), undefined, { "content-type": "application/json" });
    expect(bad.status).toBe(400);
    expect((await json<{ tag: Entity[] }>(api(token, url(`${WS}/tags`)))).tag).toHaveLength(1);
  });

  it("refuses an update whose fingerprint is stale with 409", async () => {
    const { token } = await account([EDIT]);
    const current = (await json<{ tag: Entity[] }>(api(token, url(`${WS}/tags`)))).tag[0]!;
    const stale = await json<GoogleErrorBody>(send(token, "PUT", url(`${WS}/tags/1?fingerprint=1`), { name: "x", type: "html" }), 409);
    expect(stale.error.status).toBe("ALREADY_EXISTS");
    const ok = await send(token, "PUT", url(`${WS}/tags/1?fingerprint=${current.fingerprint}`), { name: "Renamed", type: "html", firingTriggerId: ["1"] });
    expect(ok.status).toBe(200);
  });

  it("pages a list with pageToken", async () => {
    const { token } = await account([READONLY, EDIT]);
    for (let i = 0; i < 101; i++) await create(token, "variables", { name: `v${i}`, type: "c" });
    const first = await json<{ variable: Entity[]; nextPageToken?: string }>(api(token, url(`${WS}/variables`)));
    expect(first.variable).toHaveLength(100);
    expect(first.nextPageToken).toBe("100");
    const next = await json<{ variable: Entity[]; nextPageToken?: string }>(api(token, url(`${WS}/variables?pageToken=${first.nextPageToken}`)));
    expect(next.variable).toHaveLength(2);
    expect(next.nextPageToken).toBeUndefined();
    expect((await api(token, url(`${WS}/variables?pageToken=abc`))).status).toBe(400);
  });
});

describe("workspace status", () => {
  it("is empty for a seeded workspace and reports added, updated and deleted entities", async () => {
    const { token } = await account([READONLY, EDIT]);
    expect(await status(token)).toEqual({});
    await create(token, "triggers", { name: "Signup click", type: "click" });
    await send(token, "PUT", url(`${WS}/tags/1`), { name: "Page view pixel 2", type: "html", firingTriggerId: ["1"] });
    await send(token, "DELETE", url(`${WS}/variables/1`));
    const changes = (await status(token)).workspaceChange ?? [];
    expect(changes.map((c) => [c.changeStatus, (c.tag ?? c.trigger ?? c.variable)?.name])).toEqual([
      ["updated", "Page view pixel 2"],
      ["added", "Signup click"],
      ["deleted", "Page host"],
    ]);
    expect(outputSchema("tagmanager.accounts.containers.workspaces.getStatus").safeParse({ workspaceChange: changes }).success).toBe(true);
  });

  it("drops a change that was undone by hand", async () => {
    const { token } = await account([READONLY, EDIT]);
    const made = await json<Entity>(create(token, "variables", { name: "Temp", type: "c" }));
    expect((await status(token)).workspaceChange).toHaveLength(1);
    await send(token, "DELETE", url(`${WS}/variables/${made.variableId}`));
    expect(await status(token)).toEqual({});
  });
});

describe("versions", () => {
  it("saves a version, opens a clean workspace on it and publishes it live", async () => {
    const { token } = await account([READONLY, EDIT, VERSIONS, PUBLISH]);
    await create(token, "tags", { name: "Signup event", type: "html", firingTriggerId: ["1"] });
    expect((await status(token)).workspaceChange).toHaveLength(1);

    const saved = await json<Version>(send(token, "POST", url(`${WS}:create_version`), { name: "Add signup", notes: "Track signups" }));
    expect(saved.containerVersion).toMatchObject({ containerVersionId: "2", name: "Add signup", description: "Track signups" });
    expect(saved.containerVersion.tag?.map((t) => t.name)).toEqual(["Page view pixel", "Signup event"]);
    expect(saved.newWorkspacePath).toBe(`${WEB}/workspaces/2`);
    expect(outputSchema("tagmanager.accounts.containers.workspaces.create_version").safeParse(saved).success).toBe(true);

    // The saved workspace is gone; the new one has no pending changes and the same content.
    expect((await api(token, url(WS))).status).toBe(404);
    expect(await status(token, saved.newWorkspacePath)).toEqual({});
    expect((await json<{ tag: Entity[] }>(api(token, url(`${saved.newWorkspacePath}/tags`)))).tag).toHaveLength(2);

    const published = await json<Version>(send(token, "POST", url(`${WEB}/versions/2:publish`)));
    expect(published.containerVersion.containerVersionId).toBe("2");
    expect(outputSchema("tagmanager.accounts.containers.versions.publish").safeParse(published).success).toBe(true);
    expect(await status(token, saved.newWorkspacePath)).toEqual({});

    // A workspace opened now starts from the version that is live.
    const later = await json<{ workspaceId: string }>(send(token, "POST", url(`${WEB}/workspaces`), { name: "Next" }));
    const tags = await json<{ tag: Entity[] }>(api(token, url(`${WEB}/workspaces/${later.workspaceId}/tags`)));
    expect(tags.tag.map((t) => t.name)).toEqual(["Page view pixel", "Signup event"]);
  });

  it("opens a workspace on the previous live version when only a version was saved, not published", async () => {
    const { token } = await account([READONLY, EDIT, VERSIONS]);
    await create(token, "tags", { name: "Unpublished", type: "html" });
    await send(token, "POST", url(`${WS}:create_version`), {});
    const later = await json<{ workspaceId: string }>(send(token, "POST", url(`${WEB}/workspaces`), { name: "Next" }));
    const tags = await json<{ tag: Entity[] }>(api(token, url(`${WEB}/workspaces/${later.workspaceId}/tags`)));
    expect(tags.tag.map((t) => t.name)).toEqual(["Page view pixel"]);
  });

  it("answers 404 for a version that does not exist and 409 for a stale fingerprint", async () => {
    const { token } = await account([PUBLISH]);
    expect((await send(token, "POST", url(`${WEB}/versions/9:publish`))).status).toBe(404);
    const stale = await json<GoogleErrorBody>(send(token, "POST", url(`${WEB}/versions/1:publish?fingerprint=1`)), 409);
    expect(stale.error.status).toBe("ALREADY_EXISTS");
    expect((await send(token, "POST", url(`${SPARE}/versions/1:publish`))).status).toBe(404);
  });

  it("rejects a version name that is not a string", async () => {
    const { token } = await account([VERSIONS]);
    expect((await send(token, "POST", url(`${WS}:create_version`), { name: 1 })).status).toBe(400);
  });
});

describe("user permissions", () => {
  interface Permission {
    path: string;
    emailAddress: string;
    accountAccess: { permission: string };
    containerAccess?: Array<{ containerId: string; permission: string }>;
  }

  it("lists the seeded users and shows an update on the next read", async () => {
    const { email, token } = await account([USERS]);
    const list = await json<{ userPermission: Permission[] }>(api(token, url(`${ACCOUNT}/user_permissions`)));
    expect(list.userPermission.map((p) => [p.emailAddress, p.accountAccess.permission])).toEqual([
      [email, "admin"],
      ["dana@fake.test", "user"],
    ]);
    expect(outputSchema("tagmanager.accounts.user_permissions.list").safeParse(list).success).toBe(true);

    const updated = await json<Permission>(
      send(token, "PUT", url(`${ACCOUNT}/user_permissions/1000000002`), {
        emailAddress: "dana@fake.test",
        accountAccess: { permission: "user" },
        containerAccess: [{ containerId: "9001001", permission: "publish" }],
      }),
    );
    expect(updated.containerAccess).toEqual([{ containerId: "9001001", permission: "publish" }]);
    expect(outputSchema("tagmanager.accounts.user_permissions.update").safeParse(updated).success).toBe(true);
    const after = await json<{ userPermission: Permission[] }>(api(token, url(`${ACCOUNT}/user_permissions`)));
    expect(after.userPermission.find((p) => p.emailAddress === "dana@fake.test")?.containerAccess).toEqual([{ containerId: "9001001", permission: "publish" }]);
  });

  it("rejects a bad level, a bad container, another address, and an unknown permission id", async () => {
    const { token } = await account([USERS]);
    const put = (path: string, body: unknown) => send(token, "PUT", url(`${ACCOUNT}/user_permissions/${path}`), body);
    expect((await put("1000000002", { accountAccess: { permission: "owner" } })).status).toBe(400);
    expect((await put("1000000002", {})).status).toBe(400);
    expect((await put("1000000002", { accountAccess: { permission: "user" }, containerAccess: [{ containerId: "9001001", permission: "root" }] })).status).toBe(400);
    expect((await put("1000000002", { accountAccess: { permission: "user" }, containerAccess: [{ containerId: "404", permission: "read" }] })).status).toBe(400);
    expect((await put("1000000002", { accountAccess: { permission: "user" }, containerAccess: "all" })).status).toBe(400);
    expect((await put("1000000002", { emailAddress: "someone@fake.test", accountAccess: { permission: "user" } })).status).toBe(400);
    expect((await put("404", { accountAccess: { permission: "user" } })).status).toBe(404);
    const list = await json<{ userPermission: Permission[] }>(api(token, url(`${ACCOUNT}/user_permissions`)));
    expect(list.userPermission.find((p) => p.emailAddress === "dana@fake.test")?.accountAccess.permission).toBe("user");
  });
});

describe("account isolation", () => {
  it("keeps each account's workspace changes to itself", async () => {
    const one = await account([READONLY, EDIT]);
    const two = await account([READONLY]);
    await create(one.token, "tags", { name: "Only mine", type: "html" });
    expect((await json<{ tag: Entity[] }>(api(two.token, url(`${WS}/tags`)))).tag).toHaveLength(1);
  });
});

describe("durable store", () => {
  it("keeps a created tag and its pending change, with small chunks", async () => {
    const store = new DoStore(memoryBackend(), { chunkChars: 64 });
    await store.put("tagmanager:workspace:do@fake.test:1/2/3", { workspaceId: "3", name: "W" });
    await store.put("tagmanager:baseline:do@fake.test:1/2/3", {});
    expect((await callRoute(routes, store, "POST", "/tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/workspaces/3/tags", { name: "n".repeat(200), type: "html" })).status).toBe(200);
    const list = await json<{ tag: Entity[] }>(callRoute(routes, store, "GET", "/tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/workspaces/3/tags"));
    expect(list.tag).toHaveLength(1);
    const changes = await json<Status>(callRoute(routes, store, "GET", "/tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/workspaces/3/status"));
    expect(changes.workspaceChange?.[0]?.changeStatus).toBe("added");
  });
});

describe("fixtures", () => {
  it("are what the fake serves for a seeded account, replayed in order", async () => {
    const { email, token } = await account(ALL);
    const steps: Array<[ReturnType<typeof parseFixture>, unknown?]> = [
      [parseFixture(accountsList)],
      [parseFixture(containersList)],
      [parseFixture(workspacesList)],
      [parseFixture(tagsList)],
      [parseFixture(triggersList)],
      [parseFixture(variablesList)],
      [parseFixture(triggersCreate), { name: "Signup click", type: "click" }],
      [parseFixture(variablesCreate), { name: "Plan", type: "c", parameter: [{ type: "template", key: "value", value: "pro" }] }],
      [parseFixture(tagsCreate), { name: "Signup event", type: "html", parameter: [{ type: "template", key: "html", value: "<b>signup</b>" }], firingTriggerId: ["2"] }],
      [parseFixture(workspaceStatus)],
      [parseFixture(userPermissionsList)],
      [parseFixture(workspacesCreateVersion), { name: "Add signup", notes: "Track signups" }],
      [parseFixture(versionsPublish)],
      [parseFixture(workspacesCreate), { name: "Next campaign", description: "Spring" }],
    ];
    for (const [fx, body] of steps) {
      expect(await replay(token, email, fx, body), fx.id).toEqual(fx.response.body);
    }
  });
});
