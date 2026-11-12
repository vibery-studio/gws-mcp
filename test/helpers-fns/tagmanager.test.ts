import { describe, expect, it } from "vitest";
import { DESTRUCTIVE_REASON_WORDS } from "../../src/core/destructive";
import { fake } from "../helpers/fake";
import { auditRows, connect, errorCodeOf, G, session, valueOf } from "./harness";

/** Publishing without the person's approval: the helper publishes in one run. */
const ONE_RUN = { GWS_HUMAN_APPROVAL: [] } as const;

const READ = `${G}tagmanager.readonly`;
const VERSIONS = `${G}tagmanager.edit.containerversions`;
const PUBLISH = `${G}tagmanager.publish`;
const ALL = [READ, VERSIONS, PUBLISH];
const ACCOUNT = "6001001001";
const WEB = "9001001";
const BASE = `accounts/${ACCOUNT}/containers/${WEB}`;

const stateOf = async (email: string) => (await fake.state(email)).resources;
const writesTo = async (email: string, suffix: string) => (await fake.requests(email)).filter((q) => q.method === "POST" && q.path.includes(suffix));

/** A tag added to the default workspace, so it holds one pending change. */
function pendingTag(email: string) {
  return {
    key: `tagmanager:tag:${email}:${ACCOUNT}/${WEB}/1/2`,
    value: {
      path: `${BASE}/workspaces/1/tags/2`,
      accountId: ACCOUNT,
      containerId: WEB,
      workspaceId: "1",
      tagId: "2",
      name: "Signup event",
      type: "html",
      parameter: [{ type: "template", key: "html", value: "<b>signup</b>" }],
      firingTriggerId: ["1"],
      fingerprint: "2075938918",
    },
  };
}

describe("tagmanager.containers", () => {
  it("flattens accounts and containers with their public ids", async () => {
    const { auth } = await connect("h-gtm", [READ]);
    const { s, executeId } = session(auth, false);
    const out = valueOf(await s.dispatch("tagmanager.containers", {}));
    expect(out.truncated).toBe(false);
    expect(out.containers).toEqual([
      { accountId: ACCOUNT, accountName: "Example Company", containerId: WEB, name: "Example site", publicId: "GTM-AB12CD", usageContext: ["web"] },
      { accountId: ACCOUNT, accountName: "Example Company", containerId: "9001002", name: "Spare container", publicId: "GTM-EF34GH", usageContext: ["web"] },
    ]);
    await s.close();
    expect((await auditRows(executeId)).map((r) => r.fn)).toEqual(["tagmanager.accounts.list", "tagmanager.accounts.containers.list", "tagmanager.containers"]);
  });

  it("names the missing scope", async () => {
    const { auth } = await connect("h-gtm", [`${G}drive.file`]);
    expect(errorCodeOf(await session(auth, false).s.dispatch("tagmanager.containers", {}))).toBe("GWS_SCOPE_MISSING");
  });
});

describe("tagmanager.workspaceStatus", () => {
  it("shows no pending changes for a clean workspace, by numeric or public id", async () => {
    const { auth } = await connect("h-gtm", [READ]);
    for (const containerId of [WEB, "GTM-AB12CD", "gtm-ab12cd"]) {
      const out = valueOf(await session(auth, false).s.dispatch("tagmanager.workspaceStatus", { containerId }));
      expect(out).toEqual({
        accountId: ACCOUNT,
        containerId: WEB,
        containerName: "Example site",
        workspaces: [{ workspaceId: "1", name: "Default Workspace", pendingChanges: [], mergeConflicts: [] }],
      });
    }
  });

  it("lists the pending changes of a workspace", async () => {
    const { auth, email } = await connect("h-gtm", [READ]);
    await fake.seed({ accounts: [], resources: [pendingTag(email)] });
    const out = valueOf(await session(auth, false).s.dispatch("tagmanager.workspaceStatus", { containerId: WEB, workspaceId: "1", accountId: ACCOUNT }));
    expect((out.workspaces as Array<{ pendingChanges: unknown[] }>)[0]?.pendingChanges).toEqual([{ type: "tag", id: "2", name: "Signup event", changeStatus: "added" }]);
  });

  it("rejects an unknown container and a malformed id", async () => {
    const { auth } = await connect("h-gtm", [READ]);
    expect(errorCodeOf(await session(auth, false).s.dispatch("tagmanager.workspaceStatus", { containerId: "424242" }))).toBe("GWS_INVALID_INPUT");
    expect(errorCodeOf(await session(auth, false).s.dispatch("tagmanager.workspaceStatus", { containerId: "web/../1" }))).toBe("GWS_INVALID_INPUT");
  });
});

describe("tagmanager.publish", () => {
  const input = { containerId: "GTM-AB12CD", workspaceId: "1", name: "Signup release", notes: "Add the signup tag" };

  it("plans one destructive publish that names the container and workspace and waits on the pending version", async () => {
    const { auth, email } = await connect("h-gtm", ALL);
    await fake.seed({ accounts: [], resources: [pendingTag(email)] });
    const { s } = session(auth, false, ONE_RUN);

    const out = valueOf(await s.dispatch("tagmanager.publish", input));

    expect(out).toMatchObject({ applied: false, containerName: "Example site", publicId: "GTM-AB12CD", workspaceName: "Default Workspace" });
    expect(s.plan.map((p) => p.fn)).toEqual([
      "tagmanager.accounts.containers.workspaces.create_version",
      "tagmanager.accounts.containers.versions.publish",
      "tagmanager.publish",
    ]);
    const [create, publish, summary] = s.plan;
    expect(create).toMatchObject({ effect: "write", request: { method: "POST", body: { name: "Signup release", notes: "Add the signup tag" } } });
    expect(create?.incomplete).toBeUndefined();
    expect(publish).toMatchObject({ destructive: true, incomplete: true, dependsOn: [create?.step] });
    expect(summary).toMatchObject({ destructive: true, effect: "write", reason: "publish", reasonText: DESTRUCTIVE_REASON_WORDS.publish });
    expect(publish).toMatchObject({ reason: "publish", reasonText: DESTRUCTIVE_REASON_WORDS.publish });
    expect(summary?.note).toContain('"Default Workspace"');
    expect(summary?.note).toContain('"Example site"');
    expect(summary?.note).toContain("GTM-AB12CD");
    expect(out.steps).toEqual(s.plan.map((p) => p.step));
    expect(s.destructive).toBe(true);

    // Nothing was sent: the live version and the workspace are as they were.
    expect(await writesTo(email, "create_version")).toEqual([]);
    expect(await writesTo(email, ":publish")).toEqual([]);
    expect((await stateOf(email))[`tagmanager:live:${email}:${ACCOUNT}/${WEB}`]).toEqual({ containerVersionId: "1" });
  });

  it("creates the version and publishes it under apply, moving on to the new workspace", async () => {
    const { auth, email } = await connect("h-gtm", ALL);
    await fake.seed({ accounts: [], resources: [pendingTag(email)] });
    const { s, executeId } = session(auth, true, ONE_RUN);

    const out = valueOf(await s.dispatch("tagmanager.publish", input));

    expect(out).toEqual({
      applied: true,
      versionId: "2",
      containerName: "Example site",
      publicId: "GTM-AB12CD",
      workspaceName: "Default Workspace",
      newWorkspacePath: `${BASE}/workspaces/2`,
    });
    const state = await stateOf(email);
    expect(state[`tagmanager:live:${email}:${ACCOUNT}/${WEB}`]).toEqual({ containerVersionId: "2" });
    expect(state[`tagmanager:version:${email}:${ACCOUNT}/${WEB}/2`]).toMatchObject({ name: "Signup release", description: "Add the signup tag" });
    expect(state[`tagmanager:workspace:${email}:${ACCOUNT}/${WEB}/1`]).toBeUndefined();
    expect(state[`tagmanager:workspace:${email}:${ACCOUNT}/${WEB}/2`]).toBeDefined();
    expect(s.destructive).toBe(false);
    expect(s.appliedDestructive).toBe(true);

    await s.close();
    expect((await auditRows(executeId)).map((r) => [r.fn, r.applied])).toEqual([
      ["tagmanager.accounts.list", 0],
      ["tagmanager.accounts.containers.list", 0],
      ["tagmanager.accounts.containers.workspaces.get", 0],
      ["tagmanager.accounts.containers.workspaces.create_version", 1],
      ["tagmanager.accounts.containers.versions.publish", 1],
      ["tagmanager.publish", 1],
    ]);
  });

  it("says where the work is when the publish fails after the version was saved", async () => {
    const { auth, email } = await connect("h-gtm", ALL);
    await fake.fault({ email, method: "POST", pathRegex: ":publish$", times: 1, response: { status: 500, body: { error: { code: 500, message: "backend error", status: "INTERNAL" } } } });
    const r = await session(auth, true, ONE_RUN).s.dispatch("tagmanager.publish", input);
    expect("__gwsError" in r && r.__gwsError).toMatchObject({
      code: "GWS_UPSTREAM_ERROR",
      details: { versionId: "2", newWorkspacePath: `${BASE}/workspaces/2` },
    });
    expect("__gwsError" in r && r.__gwsError.message).toContain("version 2 was saved");
    const state = await stateOf(email);
    expect(state[`tagmanager:live:${email}:${ACCOUNT}/${WEB}`]).toEqual({ containerVersionId: "1" });
    expect(state[`tagmanager:version:${email}:${ACCOUNT}/${WEB}/2`]).toBeDefined();
  });

  it("changes nothing when the workspace or container does not exist", async () => {
    const { auth, email } = await connect("h-gtm", ALL);
    expect(errorCodeOf(await session(auth, true, ONE_RUN).s.dispatch("tagmanager.publish", { ...input, workspaceId: "77" }))).toBe("GWS_UPSTREAM_ERROR");
    expect(errorCodeOf(await session(auth, true, ONE_RUN).s.dispatch("tagmanager.publish", { ...input, containerId: "GTM-ZZZZZZ" }))).toBe("GWS_INVALID_INPUT");
    expect(await writesTo(email, "create_version")).toEqual([]);
  });

  it("validates the input", async () => {
    const { auth } = await connect("h-gtm", ALL);
    const { s } = session(auth, false, ONE_RUN);
    for (const bad of [{ containerId: "GTM-AB12CD" }, { ...input, workspaceId: "main" }, { ...input, name: "" }, { ...input, extra: true }]) {
      expect(errorCodeOf(await s.dispatch("tagmanager.publish", bad))).toBe("GWS_INVALID_INPUT");
    }
    expect(s.calls.every((c) => c.fn === "tagmanager.publish")).toBe(true);
  });

  it("names the missing publish scope in a dry-run too", async () => {
    const { auth } = await connect("h-gtm", [READ, VERSIONS]);
    const { s } = session(auth, false, ONE_RUN);
    expect(errorCodeOf(await s.dispatch("tagmanager.publish", input))).toBe("GWS_SCOPE_MISSING");
  });

  it("where publishing needs the person's approval, refuses before any write and names the two runs instead", async () => {
    const { auth, email } = await connect("h-gtm-gated", [READ, VERSIONS, PUBLISH]);
    const apiWrites = async () => (await fake.requests(email)).filter((q) => q.method !== "GET" && !/oauth2/.test(q.path)).length;
    const before = await apiWrites();
    for (const apply of [false, true]) {
      const r = await session(auth, apply).s.dispatch("tagmanager.publish", input);
      expect(errorCodeOf(r)).toBe("GWS_APPROVAL_REQUIRED");
      const error = (r as { __gwsError: { message: string; details?: Record<string, unknown> } }).__gwsError;
      expect(error.message).toContain("Do it in two runs");
      expect(error.message).toContain("create_version");
      expect(error.message).toContain("versions.publish");
      expect(error.details).toMatchObject({ reasons: ["publish"] });
    }
    expect(await apiWrites()).toBe(before);
  });
});
