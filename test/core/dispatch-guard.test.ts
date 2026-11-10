import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/config";
import { PENDING_TOKEN_PREFIX, type AuthProps, type CallCtx, type FnDef } from "../../src/contracts";
import { isDestructive } from "../../src/core/destructive";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { buildRegistry, getRegistry, type Registry } from "../../src/core/registry";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const store = openStore(env);
const baseConfig = loadConfig(env);
const pending = (ref: string) => `${PENDING_TOKEN_PREFIX}${ref}`;

async function driveAccount() {
  const email = uniqueEmail("disp-guard");
  const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}drive.file`], isDefault: true });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }] });
  const auth: AuthProps = { userId: seeded.userId, clientId: `client-${crypto.randomUUID()}` };
  await store.grants.add(auth.userId, auth.clientId, seeded.account.id);
  return { ...seeded, email, auth };
}

function session(auth: AuthProps, apply: boolean, registry?: Registry) {
  return createCallSession({
    ports: workersPorts(env),
    auth,
    apply,
    executeId: `x-${crypto.randomUUID()}`,
    config: baseConfig,
    ...(registry ? { registry } : {}),
  });
}

function valueOf(r: DispatchResult): unknown {
  if (!("ok" in r)) throw new Error(`expected a value result, got ${JSON.stringify(r)}`);
  return r.value;
}

async function driveFiles(email: string): Promise<Record<string, unknown>> {
  const { resources } = await fake.state(email);
  return Object.fromEntries(Object.entries(resources).filter(([k]) => k.startsWith(`drive:file:${email}:`)));
}

describe("write guard", () => {
  it("plans a write without apply: pending marker, POST plan step, no upstream request, unchanged state", async () => {
    const { auth, email } = await driveAccount();
    const stateBefore = await driveFiles(email);
    const logBefore = await fake.requests(email);
    const s = session(auth, false);

    const r = await s.dispatch("drive.files.create", { requestBody: { name: "planned.txt" } });

    expect(r).toEqual({ __gwsPending: "s1" });
    expect(s.plan).toHaveLength(1);
    const step = s.plan[0];
    expect(step).toMatchObject({ step: "s1", fn: "drive.files.create", account: email, effect: "write", destructive: false });
    expect(step?.request?.method).toBe("POST");
    expect(step?.request?.url).toBe("https://www.googleapis.com/drive/v3/files");
    expect(step?.request?.body).toEqual({ name: "planned.txt" });
    expect(step?.incomplete).toBeUndefined();
    expect(await fake.requests(email)).toEqual(logBefore);
    expect(await driveFiles(email)).toEqual(stateBefore);
    expect(s.calls).toMatchObject([{ seq: 1, fn: "drive.files.create", status: "planned", effect: "write" }]);
  });

  it("applies the write with apply:true and the file is observable at the fake", async () => {
    const { auth, email } = await driveAccount();
    const s = session(auth, true);
    const created = valueOf(await s.dispatch("drive.files.create", { requestBody: { name: "applied.txt" } })) as { id: string };
    expect(typeof created.id).toBe("string");
    const files = await driveFiles(email);
    expect((files[`drive:file:${email}:${created.id}`] as { name?: string } | undefined)?.name).toBe("applied.txt");
    expect(s.plan).toEqual([]);
    const posts = (await fake.requests(email)).filter((q) => q.method === "POST" && q.path === "/www.googleapis.com/drive/v3/files");
    expect(posts).toHaveLength(1);
  });

  it("still runs reads in a dry-run", async () => {
    const { auth } = await driveAccount();
    const list = valueOf(await session(auth, false).dispatch("drive.files.list", {})) as { files: unknown[] };
    expect(list.files.length).toBeGreaterThan(0);
  });

  it("flags delete and public share as destructive in the plan, but not a private share", async () => {
    const { auth, email } = await driveAccount();
    const s = session(auth, false);
    await s.dispatch("drive.files.delete", { fileId: "seed-file-readme" });
    await s.dispatch("drive.permissions.create", { fileId: "seed-file-readme", requestBody: { type: "anyone", role: "reader" } });
    await s.dispatch("drive.permissions.create", {
      fileId: "seed-file-readme",
      requestBody: { type: "user", role: "reader", emailAddress: "friend@fake.test" },
    });
    expect(s.plan.map((p) => [p.fn, p.destructive])).toEqual([
      ["drive.files.delete", true],
      ["drive.permissions.create", true],
      ["drive.permissions.create", false],
    ]);
    expect(s.plan[0]?.request?.method).toBe("DELETE");
    expect(s.destructive).toBe(true);
    expect(await fake.state(email).then((st) => st.resources[`drive:file:${email}:seed-file-readme`])).toBeDefined();
  });

  it("reports no destructive plan when only safe writes are planned", async () => {
    const { auth } = await driveAccount();
    const s = session(auth, false);
    await s.dispatch("drive.files.create", { requestBody: { name: "x" } });
    expect(s.destructive).toBe(false);
  });

  it("plans a write that depends on an unexecuted write as incomplete, with dependsOn", async () => {
    const { auth, email } = await driveAccount();
    const logBefore = await fake.requests(email);
    const s = session(auth, false);
    expect(await s.dispatch("drive.files.create", { requestBody: { name: "doc" } })).toEqual({ __gwsPending: "s1" });
    const r = await s.dispatch("drive.permissions.create", {
      fileId: pending("s1.id"),
      requestBody: { type: "user", role: "reader", emailAddress: "friend@fake.test" },
    });
    expect(r).toEqual({ __gwsPending: "s2" });
    expect(s.plan[1]).toMatchObject({ step: "s2", fn: "drive.permissions.create", effect: "write", incomplete: true, dependsOn: ["s1"] });
    expect(await fake.requests(email)).toEqual(logBefore);
  });

  it("finds a pending token embedded inside a longer string and in nested values", async () => {
    const { auth } = await driveAccount();
    const s = session(auth, false);
    await s.dispatch("drive.files.create", {
      requestBody: { name: `copy of ${pending("s3.name")}`, description: pending("s4.id") },
    });
    expect(s.plan[0]).toMatchObject({ incomplete: true, dependsOn: ["s3", "s4"] });
  });

  it("never executes a write whose input holds a pending token, even with apply:true", async () => {
    const { auth, email } = await driveAccount();
    const logBefore = await fake.requests(email);
    const s = session(auth, true);
    const r = await s.dispatch("drive.files.delete", { fileId: pending("s1.id") });
    expect(r).toEqual({ __gwsPending: "s1" });
    expect(s.plan[0]).toMatchObject({ incomplete: true, dependsOn: ["s1"], destructive: true });
    expect(await fake.requests(email)).toEqual(logBefore);
  });

  it("does not send a read whose input holds a pending token upstream", async () => {
    const { auth, email } = await driveAccount();
    const logBefore = await fake.requests(email);
    const s = session(auth, false);
    const r = await s.dispatch("drive.files.get", { fileId: pending("s1.id") });
    expect(r).toEqual({ __gwsPending: "s1" });
    expect(s.plan[0]).toMatchObject({ effect: "read", incomplete: true, dependsOn: ["s1"], note: "depends on unexecuted write" });
    expect(await fake.requests(email)).toEqual(logBefore);
    expect(s.calls[0]?.status).toBe("planned");
  });

  it("never runs a host fn whose input holds a pending token", async () => {
    let ran = false;
    const hostWrite: FnDef = {
      name: "test.hostWrite",
      service: "helpers",
      effect: "write",
      kind: "host",
      description: "",
      signature: "",
      tsDecl: "",
      example: "",
      tags: [],
      scopes: [],
      input: z.looseObject({}),
      output: z.unknown(),
      async run() {
        ran = true;
        return {};
      },
    };
    const s = session({ userId: "u_x", clientId: "c" }, true, buildRegistry([hostWrite]));
    expect(await s.dispatch("test.hostWrite", { id: pending("s1.id") })).toEqual({ __gwsPending: "s1" });
    expect(ran).toBe(false);
  });

  it("lets host fns plan steps and nest guarded calls through ctx", async () => {
    const { auth, email } = await driveAccount();
    const logBefore = await fake.requests(email);
    const helper: FnDef = {
      name: "test.share",
      service: "helpers",
      effect: "write",
      kind: "host",
      description: "",
      signature: "",
      tsDecl: "",
      example: "",
      tags: [],
      scopes: [],
      input: z.looseObject({}),
      output: z.unknown(),
      async run(_input, ctx: CallCtx) {
        const created = await ctx.call("drive.files.create", { requestBody: { name: "from helper" } });
        const own = ctx.planStep({ fn: "test.share", effect: "write", destructive: false, note: "helper step" });
        return { created, own };
      },
    };
    const s = session(auth, false, buildRegistry([...getRegistry().values(), helper]));
    const out = valueOf(await s.dispatch("test.share", {}));
    expect(out).toEqual({ created: { __gwsPending: "s1" }, own: "s2" });
    expect(s.plan.map((p) => p.step)).toEqual(["s1", "s2"]);
    expect(s.calls.map((c) => [c.fn, c.status])).toEqual([
      ["drive.files.create", "planned"],
      ["test.share", "planned"],
    ]);
    expect(await fake.requests(email)).toEqual(logBefore);
  });
});

describe("write guard covers every write verb", () => {
  it("plans a PATCH write in a dry-run and sends nothing upstream", async () => {
    const { auth, email } = await driveAccount();
    const logBefore = await fake.requests(email);
    const s = session(auth, false);
    const r = await s.dispatch("drive.files.update", { fileId: "seed-file-readme", requestBody: { trashed: true } });
    expect(r).toEqual({ __gwsPending: "s1" });
    expect(s.plan[0]).toMatchObject({ fn: "drive.files.update", effect: "write", destructive: true, request: { method: "PATCH" } });
    expect(await fake.requests(email)).toEqual(logBefore);
  });

  it("plans a PUT write in a dry-run and sends nothing upstream", async () => {
    const email = uniqueEmail("disp-guard-put");
    const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}spreadsheets`], isDefault: true });
    const auth: AuthProps = { userId: seeded.userId, clientId: `client-${crypto.randomUUID()}` };
    await store.grants.add(auth.userId, auth.clientId, seeded.account.id);
    const logBefore = await fake.requests(email);
    const s = session(auth, false);
    const r = await s.dispatch("sheets.spreadsheets.values.update", {
      spreadsheetId: "sheet-1",
      range: "A1",
      valueInputOption: "RAW",
      requestBody: { values: [["x"]] },
    });
    expect(r).toEqual({ __gwsPending: "s1" });
    expect(s.plan[0]).toMatchObject({ fn: "sheets.spreadsheets.values.update", effect: "write", request: { method: "PUT" } });
    expect(await fake.requests(email)).toEqual(logBefore);
  });
});

describe("pending tokens", () => {
  it("never executes a write with a pending token inside an array, even with apply:true", async () => {
    const { auth, email } = await driveAccount();
    const logBefore = await fake.requests(email);
    const s = session(auth, true);
    const r = await s.dispatch("drive.files.create", { requestBody: { name: "child", parents: [pending("s1.id")] } });
    expect(r).toEqual({ __gwsPending: "s1" });
    expect(s.plan[0]).toMatchObject({ incomplete: true, dependsOn: ["s1"] });
    expect(await fake.requests(email)).toEqual(logBefore);
  });

  it("never executes a write with a pending token in an object key, even with apply:true", async () => {
    const { auth, email } = await driveAccount();
    const logBefore = await fake.requests(email);
    const s = session(auth, true);
    const r = await s.dispatch("drive.files.create", { requestBody: { name: "tagged", appProperties: { [pending("s2")]: "v" } } });
    expect(r).toEqual({ __gwsPending: "s1" });
    expect(s.plan[0]).toMatchObject({ incomplete: true, dependsOn: ["s2"] });
    expect(await fake.requests(email)).toEqual(logBefore);
  });

  it("plans a pending token in a numeric or enum field as incomplete instead of failing validation", async () => {
    const { auth, email } = await driveAccount();
    const logBefore = await fake.requests(email);
    const s = session(auth, false);
    expect(await s.dispatch("drive.files.list", { pageSize: pending("s1.size") })).toEqual({ __gwsPending: "s1" });
    expect(await s.dispatch("drive.files.list", { corpus: pending("s2.corpus") })).toEqual({ __gwsPending: "s2" });
    expect(s.plan.map((p) => [p.fn, p.incomplete, p.dependsOn])).toEqual([
      ["drive.files.list", true, ["s1"]],
      ["drive.files.list", true, ["s2"]],
    ]);
    expect(await fake.requests(email)).toEqual(logBefore);
  });

  it("still reports unrelated invalid input when a pending token is present", async () => {
    const { auth } = await driveAccount();
    const s = session(auth, false);
    const r = await s.dispatch("drive.files.list", { pageSize: pending("s1.size"), corpus: "nobody" });
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_INVALID_INPUT");
    const issues = ("__gwsError" in r ? r.__gwsError.details?.issues : []) as Array<{ path: string }>;
    expect(issues.map((i) => i.path)).toEqual(["corpus"]);
    expect(s.plan).toEqual([]);
  });

  it("does not let a pending-token key hide an unrelated unknown key", async () => {
    const { auth } = await driveAccount();
    const s = session(auth, false);
    const r = await s.dispatch("drive.files.list", { pageSize: pending("s1.size"), notAParam: 1 });
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_INVALID_INPUT");
  });
});

describe("isDestructive", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["drive.files.delete", {}, true],
    ["gmail.users.messages.batchDelete", {}, true],
    ["gmail.users.messages.trash", {}, true],
    ["gmail.users.messages.untrash", {}, false],
    ["drive.files.emptyTrash", {}, true],
    ["calendar.calendars.clear", {}, true],
    ["sheets.spreadsheets.values.clear", {}, true],
    ["sheets.spreadsheets.values.batchClear", {}, true],
    ["drive.permissions.create", { requestBody: { type: "anyone", role: "reader" } }, true],
    ["drive.permissions.create", { requestBody: { type: "user", role: "owner" } }, true],
    ["drive.permissions.create", { requestBody: { type: "user", role: "writer" } }, false],
    ["drive.permissions.create", { requestBody: { type: "Anyone", role: "reader" } }, true],
    ["drive.permissions.create", { requestBody: { type: "ANYONE", role: "reader" } }, true],
    ["drive.permissions.create", { requestBody: { type: "domain", role: "reader", domain: "x.test", allowFileDiscovery: true } }, true],
    ["drive.permissions.create", { requestBody: { type: "domain", role: "reader", domain: "x.test", allowFileDiscovery: false } }, false],
    ["drive.permissions.create", { requestBody: { type: "user", role: "Owner" } }, true],
    ["drive.permissions.create", { transferOwnership: true, requestBody: { type: "user", role: "writer" } }, true],
    ["drive.permissions.create", { requestBody: { type: "user", role: "writer", pendingOwner: true } }, true],
    ["drive.permissions.update", { requestBody: { role: "owner" } }, true],
    ["drive.permissions.update", { requestBody: { role: "writer", pendingOwner: true } }, true],
    ["drive.permissions.update", { transferOwnership: true, requestBody: { role: "writer" } }, true],
    ["drive.permissions.update", { requestBody: { type: "anyone" } }, true],
    ["drive.permissions.update", { requestBody: { role: "reader", allowFileDiscovery: true } }, true],
    ["drive.permissions.update", { requestBody: { role: "commenter" } }, false],
    ["sheets.spreadsheets.values.batchClearByDataFilter", {}, true],
    ["calendar.calendars.transferOwnership", {}, true],
    ["calendar.acl.insert", { requestBody: { role: "reader", scope: { type: "default" } } }, true],
    ["calendar.acl.update", { requestBody: { role: "reader", scope: { type: "Default" } } }, true],
    ["calendar.acl.patch", { requestBody: { scope: { type: "default" } } }, true],
    ["calendar.acl.insert", { requestBody: { role: "reader", scope: { type: "user", value: "f@fake.test" } } }, false],
    ["drive.files.update", { requestBody: { trashed: true } }, true],
    ["drive.files.update", { requestBody: { trashed: false } }, false],
    ["accounts.disconnect", {}, true],
    ["drive.files.create", {}, false],
    ["drive.files.list", {}, false],
    ["tasks.tasks.delete", {}, true],
    ["tasks.tasklists.delete", {}, true],
    ["tasks.tasks.clear", {}, true],
    ["tasks.tasks.insert", {}, false],
    ["tasks.tasks.move", {}, false],
    ["tasks.tasklists.update", {}, false],
    ["forms.forms.create", {}, false],
    ["slides.presentations.create", {}, false],
    ["slides.presentations.batchUpdate", { requestBody: { requests: [{ replaceAllText: { replaceText: "x" } }] } }, false],
    ["slides.presentations.batchUpdate", { requestBody: { requests: [{ insertText: {} }, { deleteObject: { objectId: "s1" } }] } }, true],
    ["slides.presentations.batchUpdate", { requestBody: { requests: [{ deleteText: { objectId: "t1" } }] } }, true],
    ["slides.presentations.batchUpdate", { requestBody: { requests: [{ deleteTableRow: {} }] } }, true],
    ["slides.presentations.batchUpdate", { requestBody: { requests: [{ deleteTableColumn: {} }] } }, true],
    ["slides.presentations.batchUpdate", { requestBody: { requests: [{ deleteParagraphBullets: {} }] } }, false],
    ["slides.presentations.batchUpdate", { requestBody: { requests: [{ delete_object: { objectId: "s1" } }] } }, true],
    ["forms.forms.batchUpdate", { requestBody: { requests: [{ delete_item: {} }] } }, true],
    ["slides.presentations.batchUpdate", { requestBody: { requests: "deleteObject" } }, false],
    ["slides.presentations.batchUpdate", {}, false],
    ["forms.forms.batchUpdate", { requestBody: { requests: [{ createItem: {} }, { updateFormInfo: {} }] } }, false],
    ["forms.forms.batchUpdate", { requestBody: { requests: [{ createItem: {} }, { deleteItem: { location: { index: 0 } } }] } }, true],
    ["docs.documents.batchUpdate", { requestBody: { requests: [{ insertText: { text: "x" } }] } }, false],
    ["docs.documents.batchUpdate", { requestBody: { requests: [{ deleteContentRange: {} }] } }, true],
    ["docs.documents.batchUpdate", { requestBody: { requests: [{ deletePositionedObject: {} }] } }, true],
    ["docs.documents.batchUpdate", { requestBody: { requests: [{ deleteTableRow: {} }] } }, true],
    ["docs.documents.batchUpdate", { requestBody: { requests: [{ deleteTableColumn: {} }] } }, true],
    ["docs.documents.batchUpdate", { requestBody: { requests: [{ deleteTab: {} }] } }, true],
    ["docs.documents.batchUpdate", { requestBody: { requests: [{ deleteHeader: {} }] } }, true],
    ["docs.documents.batchUpdate", { requestBody: { requests: [{ deleteFooter: {} }] } }, true],
    ["docs.documents.batchUpdate", { requestBody: { requests: [{ deleteParagraphBullets: {} }] } }, false],
    // Marking a task deleted through an update is a delete.
    ["tasks.tasks.patch", { requestBody: { deleted: true } }, true],
    ["tasks.tasks.update", { requestBody: { deleted: true } }, true],
    ["tasks.tasks.patch", { requestBody: { deleted: false } }, false],
    ["tasks.tasks.update", { requestBody: { deleted: false, title: "x" } }, false],
    ["tasks.tasks.patch", { requestBody: { deleted: "true" } }, false],
    // Publishing a form makes it visible to others; unpublishing does not.
    ["forms.forms.setPublishSettings", { requestBody: { publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } } } }, true],
    ["forms.forms.setPublishSettings", { requestBody: { publish_settings: { publish_state: { is_published: true } } } }, true],
    ["forms.forms.setPublishSettings", { requestBody: { publishSettings: { publishState: { isPublished: false, isAcceptingResponses: false } } } }, false],
    ["forms.forms.setPublishSettings", { requestBody: { publishSettings: {} } }, false],
    ["forms.forms.setPublishSettings", {}, false],
    // Replacing every match with nothing erases it.
    ["slides.presentations.batchUpdate", { requestBody: { requests: [{ replaceAllText: { containsText: { text: "Q3" }, replaceText: "" } }] } }, true],
    ["slides.presentations.batchUpdate", { requestBody: { requests: [{ replaceAllText: { containsText: { text: "Q3" } } }] } }, true],
    ["slides.presentations.batchUpdate", { requestBody: { requests: [{ replaceAllText: { containsText: { text: "Q3" }, replaceText: null } }] } }, true],
    ["slides.presentations.batchUpdate", { requestBody: { requests: [{ replace_all_text: { contains_text: { text: "Q3" }, replace_text: "" } }] } }, true],
    ["slides.presentations.batchUpdate", { requestBody: { requests: [{ ReplaceAllText: { containsText: { text: "Q3" } } }] } }, true],
    ["slides.presentations.batchUpdate", { requestBody: { requests: [{ replace_all_text: { replace_text: "Q4" } }] } }, false],
    ["slides.presentations.batchUpdate", { requestBody: { requests: [{ replaceAllText: { replaceText: " " } }] } }, false],
    ["docs.documents.batchUpdate", { requestBody: { requests: [{ replaceAllText: { containsText: { text: "Q3" }, replaceText: "" } }] } }, true],
    ["docs.documents.batchUpdate", { requestBody: { requests: [{ insertText: { text: "x" } }, { replaceAllText: { containsText: { text: "Q3" } } }] } }, true],
    ["docs.documents.batchUpdate", { requestBody: { requests: [{ replaceAllText: { containsText: { text: "Q3" }, replaceText: "Q4" } }] } }, false],
    // replaceAllText is not a request kind of the Forms or Sheets batchUpdate.
    ["forms.forms.batchUpdate", { requestBody: { requests: [{ replaceAllText: { replaceText: "" } }] } }, false],
    ["sheets.spreadsheets.batchUpdate", { requestBody: { requests: [{ replaceAllText: { replaceText: "" } }] } }, false],
    // Request kinds are matched only on the method they belong to.
    ["sheets.spreadsheets.batchUpdate", { requestBody: { requests: [{ deleteObject: {} }] } }, false],
    ["forms.forms.batchUpdate", { requestBody: { requests: [{ deleteObject: {} }] } }, false],
  ];
  it.each(cases)("%s %j → %s", (fn, input, expected) => {
    expect(isDestructive(fn, input).destructive).toBe(expected);
  });

  it("gives a reason for destructive calls", () => {
    expect(isDestructive("drive.permissions.create", { requestBody: { type: "anyone" } }).reason).toBe("public-share");
    expect(isDestructive("drive.files.delete", {}).reason).toBe("delete");
    expect(isDestructive("sheets.spreadsheets.values.batchClearByDataFilter").reason).toBe("clear");
    expect(isDestructive("calendar.calendars.transferOwnership").reason).toBe("owner-transfer");
    expect(isDestructive("drive.permissions.update", { requestBody: { role: "owner" } }).reason).toBe("owner-transfer");
    expect(isDestructive("calendar.acl.insert", { requestBody: { scope: { type: "default" } } }).reason).toBe("public-share");
    expect(isDestructive("tasks.tasks.delete").reason).toBe("delete");
    expect(isDestructive("tasks.tasklists.delete").reason).toBe("delete");
    expect(isDestructive("tasks.tasks.clear").reason).toBe("clear");
    expect(isDestructive("forms.forms.batchUpdate", { requestBody: { requests: [{ deleteItem: {} }] } }).reason).toBe("delete");
    expect(isDestructive("slides.presentations.batchUpdate", { requestBody: { requests: [{ deleteText: {} }] } }).reason).toBe("delete");
    expect(isDestructive("docs.documents.batchUpdate", { requestBody: { requests: [{ deleteContentRange: {} }] } }).reason).toBe("delete");
    expect(isDestructive("tasks.tasks.patch", { requestBody: { deleted: true } }).reason).toBe("delete");
    expect(isDestructive("tasks.tasks.update", { requestBody: { deleted: true } }).reason).toBe("delete");
    const publish = { requestBody: { publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } } } };
    expect(isDestructive("forms.forms.setPublishSettings", publish).reason).toBe("public-share");
    const erase = { requestBody: { requests: [{ replaceAllText: { containsText: { text: "Q3" }, replaceText: "" } }] } };
    expect(isDestructive("slides.presentations.batchUpdate", erase).reason).toBe("delete");
    expect(isDestructive("docs.documents.batchUpdate", erase).reason).toBe("delete");
  });

  it("flags by name, without input, every generated delete and clear of Forms, Tasks and Slides", async () => {
    const { generatedFns } = await import("../../src/sdk/generated/index");
    const flagged = generatedFns
      .filter((f) => ["forms", "tasks", "slides"].includes(f.service) && isDestructive(f.name).destructive)
      .map((f) => f.name)
      .sort();
    expect(flagged).toEqual(["tasks.tasklists.delete", "tasks.tasks.clear", "tasks.tasks.delete"]);
  });
});
