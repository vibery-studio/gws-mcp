import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config";
import type { AuthProps } from "../../src/contracts";
import { PLANNING_PASS_PREFIX, runExecute, type ExecuteReport } from "../../src/core/execute";
import { APPROVAL_LINK_PATH, APPROVAL_TTL_MS, DEPENDENT_NOTE, TOO_LARGE_NOTE, peekApprovalLink } from "../../src/core/human-approval";
import { linkKey } from "../../src/core/links";
import type { CorePorts } from "../../src/core/ports";
import { workersHumanApprovalPort, workersPorts } from "../../src/runtime/workers/ports";
import { openApprovals } from "../../src/store/approvals";
import { openStore } from "../../src/store/db";
import { APPROVAL_LINK_COPY } from "../../src/web/pages/approval-link";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";
import { BASE, Browser, config, loginCallback } from "../auth/browser";
import { expectPlainLanguage } from "./plain-language";

/**
 * Human approval end to end on the Workers runtime: a plan with a step whose reason is on GWS_HUMAN_APPROVAL (the
 * default list here) gets an approval link; the signed-in person approves it on the link's page; only then does
 * `apply: true` run it, once, for exactly that plan, user and client. Without an approval nothing reaches Google.
 */

const G = "https://www.googleapis.com/auth/";
const APP_NAME = "Approval <Test> App";
const DRIVE = [`${G}drive.file`];
/** The Workers ports plus the approval page's, as the MCP endpoint wires them. */
const remotePorts = (): CorePorts & { humanApprovals: ReturnType<typeof workersHumanApprovalPort> } => ({
  ...workersPorts(env),
  humanApprovals: workersHumanApprovalPort(env),
});

/** A user with one Drive account, an MCP client allowed on it, a file in it, and a browser signed in as them. */
async function person(prefix: string) {
  const email = uniqueEmail(prefix);
  const seeded = await seedUserWithAccount(env, { email, scopes: DRIVE, isDefault: true });
  const auth: AuthProps = { userId: seeded.userId, clientId: `c-approve-${crypto.randomUUID().slice(0, 8)}` };
  await openStore(env).grants.add(auth.userId, auth.clientId, seeded.account.id);
  await openStore(env).approvals.record({ userId: auth.userId, clientId: auth.clientId, grantId: `g-${crypto.randomUUID()}`, clientName: APP_NAME });
  const browser = new Browser();
  const signed = await loginCallback(browser, email);
  if (signed.status !== 302) throw new Error(`sign-in failed: ${signed.status}`);
  // A plain create is not on the list, so it applies at once.
  const made = await exec(auth, `async () => sdk.drive.files.create({ requestBody: { name: "approve-me.txt" } })`, { apply: true });
  if (!made.ok) throw new Error(`create failed: ${JSON.stringify(made.error)}`);
  return { auth, email, userId: seeded.userId, accountId: seeded.account.id, browser, fileId: (made.result as { id: string }).id };
}

function exec(auth: AuthProps, code: string, o: { apply?: boolean; config?: Partial<Config>; now?: () => number; ports?: CorePorts } = {}): Promise<ExecuteReport> {
  return runExecute({
    code,
    apply: o.apply ?? false,
    auth,
    ports: o.ports ?? remotePorts(),
    config: { ...config, ...o.config },
    ...(o.now ? { now: o.now } : {}),
  });
}

const share = (fileId: string, extra = "") =>
  `async () => sdk.drive.permissions.create({ fileId: ${JSON.stringify(fileId)}, requestBody: { role: "reader", type: "anyone" }${extra} })`;

/** The API writes the fake has seen for `email` (OAuth traffic excluded). */
async function apiWrites(email: string): Promise<string[]> {
  return (await fake.requests(email)).filter((q) => q.method !== "GET" && !/oauth2|accounts\.google|openidconnect/.test(q.path)).map((q) => `${q.method} ${q.path}`);
}

async function anyonePermissions(email: string, fileId: string): Promise<number> {
  const { resources } = await fake.state(email);
  return Object.entries(resources).filter(([k, v]) => k.includes(fileId) && k.includes("perm") && (v as { type?: string }).type === "anyone").length;
}

async function auditOf(executeId: string): Promise<Array<Record<string, unknown>>> {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
  return results;
}

async function auditByFn(userId: string, fn: string): Promise<Array<Record<string, unknown>>> {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE user_id = ? AND fn = ? ORDER BY ts").bind(userId, fn).all();
  return results;
}

/** The link's path (with its token) from a dry run's approval offer. */
function linkPath(out: ExecuteReport): { path: string; token: string } {
  const url = new URL(out.approval?.url ?? "");
  return { path: `${url.pathname}${url.search}`, token: url.searchParams.get("t") ?? "" };
}

function formOf(page: string): { csrf: string; t: string } {
  const csrf = /<form method="post" action="\/plan\/approve"><input type="hidden" name="csrf" value="([^"]+)">/.exec(page)?.[1];
  const t = /<input type="hidden" name="t" value="([^"]+)">/.exec(page)?.[1];
  if (!csrf || !t) throw new Error("the page has no approval form");
  return { csrf, t };
}

function post(browser: Browser, fields: Record<string, string>): Promise<Response> {
  return browser.fetch(APPROVAL_LINK_PATH, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Dry-runs `code`, opens its link and decides on the page. */
async function decide(p: Awaited<ReturnType<typeof person>>, code: string, decision: "approve" | "decline", auth = p.auth) {
  const dry = await exec(auth, code);
  const { path, token } = linkPath(dry);
  const page = await (await p.browser.fetch(path)).text();
  const res = await post(p.browser, { ...formOf(page), decision });
  return { dry, path, token, page, res, form: formOf(page) };
}

function expectLinkHeaders(res: Response): void {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
}

describe("a dry run with a step that needs approval", () => {
  it("marks the step, returns a ten-minute approval link, audits it as a read, and writes nothing", async () => {
    const p = await person("ap-dry");
    const before = await apiWrites(p.email);
    const out = await exec(p.auth, share(p.fileId));
    expect(out.ok).toBe(true);
    expect(out.plan).toEqual([expect.objectContaining({ fn: "drive.permissions.create", reason: "public-share", destructive: true, needsApproval: true })]);
    expect(out.approval).toEqual({ reasons: ["public-share"], url: expect.stringMatching(new RegExp(`^${BASE}/plan/approve\\?t=[A-Za-z0-9_-]{43}$`)), expiresAt: expect.any(String) });
    expect(Date.parse(out.approval?.expiresAt ?? "")).toBeLessThanOrEqual(Date.now() + APPROVAL_TTL_MS);
    expect(await apiWrites(p.email)).toEqual(before);
    const rows = await auditOf(out.executeId);
    expect(rows.find((r) => r.fn === "approval.link.minted")).toMatchObject({ client_id: p.auth.clientId, effect: "read", applied: 0, status: "ok" });
    expect(JSON.stringify(rows)).not.toContain(linkPath(out).token);
  });

  it("offers no link when the step uses the result of a write that has not run, and apply then writes nothing at all", async () => {
    const p = await person("ap-dep");
    const code = `async () => {
      const f = await sdk.drive.files.create({ requestBody: { name: "dependent.txt" } });
      return sdk.drive.permissions.create({ fileId: f.id, requestBody: { role: "reader", type: "anyone" } });
    }`;
    const dry = await exec(p.auth, code);
    expect(dry.plan[1]).toMatchObject({ incomplete: true, needsApproval: true });
    expect(dry.plan[0]?.needsApproval).toBeUndefined();
    expect(dry.approval).toEqual({ reasons: ["public-share"], note: expect.stringContaining("Apply that earlier write in its own run first") });
    const before = await apiWrites(p.email);
    const applied = await exec(p.auth, code, { apply: true });
    expect(applied.error?.code).toBe("GWS_APPROVAL_REQUIRED");
    expect(applied.error?.details?.approval).toBeUndefined();
    // Not even the create ran: the check comes before every write.
    expect(await apiWrites(p.email)).toEqual(before);
  });

  it("keeps steps whose reason is not on the list as they were: a delete plans and applies with no approval", async () => {
    const p = await person("ap-other");
    const code = `async () => sdk.drive.files.delete({ fileId: ${JSON.stringify(p.fileId)} })`;
    const dry = await exec(p.auth, code);
    expect(dry.plan).toEqual([expect.objectContaining({ fn: "drive.files.delete", reason: "delete" })]);
    expect(dry.plan[0]?.needsApproval).toBeUndefined();
    expect(dry.approval).toBeUndefined();
    const applied = await exec(p.auth, code, { apply: true });
    expect(applied).toMatchObject({ ok: true, applied: true, plan: [] });
    expect(applied.approval).toBeUndefined();
    expect((await auditOf(applied.executeId)).map((r) => [r.fn, r.applied])).toEqual([["drive.files.delete", 1]]);
  });
});

describe("apply:true of a plan that needs approval", () => {
  it("without an approval: GWS_APPROVAL_REQUIRED with a fresh link, and no Google write", async () => {
    const p = await person("ap-none");
    const before = await apiWrites(p.email);
    const out = await exec(p.auth, share(p.fileId), { apply: true });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("GWS_APPROVAL_REQUIRED");
    expect(out.error?.message).toContain("Give them the link in details.approval");
    expect(out.error?.details).toEqual({
      reasons: ["public-share"],
      approval: { reasons: ["public-share"], url: expect.stringContaining(`${BASE}/plan/approve?t=`), expiresAt: expect.any(String) },
    });
    expect(out.plan).toEqual([expect.objectContaining({ needsApproval: true })]);
    expect(await apiWrites(p.email)).toEqual(before);
    expect(await anyonePermissions(p.email, p.fileId)).toBe(0);
    // The planning pass is audited apart from the execute's own calls.
    expect((await auditOf(`${PLANNING_PASS_PREFIX}${out.executeId}`)).map((r) => [r.fn, r.status, r.applied])).toEqual([["drive.permissions.create", "planned", 0]]);
    expect((await auditOf(out.executeId)).map((r) => r.fn)).toEqual(["approval.link.minted"]);
  });

  it("after the person approves on the page: runs once, audits the approval and its use; a replay needs a new approval", async () => {
    const p = await person("ap-flow");
    const dry = await exec(p.auth, share(p.fileId));
    const { path, token } = linkPath(dry);

    const view = await p.browser.fetch(path);
    const page = await view.text();
    expect(view.status).toBe(200);
    expectLinkHeaders(view);
    expect(page).toContain(APPROVAL_LINK_COPY.title);
    expect(page).toContain(`<span class="mono">${p.email}</span>`);
    expect(page).toContain("Makes something visible to anyone");
    expect(page).toContain("drive.permissions.create");
    expect(page).toContain(`POST https://www.googleapis.com/drive/v3/files/${p.fileId}/permissions`);
    expectPlainLanguage(page, { allow: [p.email] });
    // Viewing does not use the link up, and approves nothing.
    expect((await exec(p.auth, share(p.fileId), { apply: true })).error?.code).toBe("GWS_APPROVAL_REQUIRED");
    expect((await p.browser.fetch(path)).status).toBe(200);

    const approved = await post(p.browser, { ...formOf(page), decision: "approve" });
    expect(approved.status).toBe(200);
    expectLinkHeaders(approved);
    expect(await approved.text()).toContain(APPROVAL_LINK_COPY.approved);
    // Under the AI app and the dry run that made the link, tied to the approval and its use by the approval id.
    const [approvedRow] = await auditByFn(p.userId, "approval.link.approved");
    expect(approvedRow).toMatchObject({ client_id: p.auth.clientId, execute_id: dry.executeId, effect: "write", applied: 1, request_id: expect.stringMatching(/^approval:/) });

    const before = await apiWrites(p.email);
    const applied = await exec(p.auth, share(p.fileId), { apply: true });
    expect(applied.error).toBeUndefined();
    expect(applied).toMatchObject({ ok: true, applied: true });
    expect(await anyonePermissions(p.email, p.fileId)).toBe(1);
    expect((await apiWrites(p.email)).length).toBe(before.length + 1);
    const appliedRows = await auditOf(applied.executeId);
    expect(appliedRows.map((r) => [r.fn, r.applied])).toEqual([
      ["approval.used", 1],
      ["drive.permissions.create", 1],
    ]);
    expect(appliedRows[0]?.request_id).toBe(approvedRow?.request_id);

    // Used up: the same plan needs a new approval, and the link is spent.
    const replay = await exec(p.auth, share(p.fileId), { apply: true });
    expect(replay.error?.code).toBe("GWS_APPROVAL_REQUIRED");
    expect(await anyonePermissions(p.email, p.fileId)).toBe(1);
    const again = await post(p.browser, { ...formOf(page), decision: "approve" });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("Nothing was approved. Ask your AI app for a new one.");
    expect((await p.browser.fetch(path)).status).toBe(400);
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM approvals WHERE user_id = ?").bind(p.userId).first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect(JSON.stringify(await auditByFn(p.userId, "approval.link.approved"))).not.toContain(token);
  });

  it("binds the approval to the exact plan: another body, account, fn or code is refused and leaves it unused", async () => {
    const p = await person("ap-bind");
    const other = await seedUserWithAccount(env, { email: uniqueEmail("ap-bind-2"), scopes: DRIVE, userId: p.userId });
    await openStore(env).grants.add(p.auth.userId, p.auth.clientId, other.account.id);
    await decide(p, share(p.fileId), "approve");
    const before = await apiWrites(p.email);

    const variants = [
      // Another body.
      `async () => sdk.drive.permissions.create({ fileId: ${JSON.stringify(p.fileId)}, requestBody: { role: "writer", type: "anyone" } })`,
      // Another account.
      `async () => sdk.drive.permissions.create({ account: ${JSON.stringify(other.account.email)}, fileId: ${JSON.stringify(p.fileId)}, requestBody: { role: "reader", type: "anyone" } })`,
      // Another target.
      share("another-file-id"),
      // The same request with another query (also an owner transfer, so another reason too).
      `async () => sdk.drive.permissions.create({ fileId: ${JSON.stringify(p.fileId)}, transferOwnership: true, requestBody: { role: "owner", type: "user", emailAddress: "x@fake.test" } })`,
      // The same step from other code.
      `async () => { return sdk.drive.permissions.create({ fileId: ${JSON.stringify(p.fileId)}, requestBody: { role: "reader", type: "anyone" } }); }`,
      // The approved step plus one more.
      `async () => { await sdk.drive.permissions.create({ fileId: ${JSON.stringify(p.fileId)}, requestBody: { role: "reader", type: "anyone" } }); return sdk.drive.permissions.create({ fileId: ${JSON.stringify(p.fileId)}, requestBody: { role: "reader", type: "anyone" } }); }`,
    ];
    for (const code of variants) {
      const out = await exec(p.auth, code, { apply: true });
      expect(out.error?.code, code).toBe("GWS_APPROVAL_REQUIRED");
    }
    expect(await apiWrites(p.email)).toEqual(before);
    expect(await apiWrites(other.account.email)).toEqual([]);
    // The approval is still there for exactly its plan.
    const applied = await exec(p.auth, share(p.fileId), { apply: true });
    expect(applied.ok).toBe(true);
    expect(await anyonePermissions(p.email, p.fileId)).toBe(1);
  });

  it("works only for the client and user it was given for", async () => {
    const p = await person("ap-client");
    await decide(p, share(p.fileId), "approve");
    const otherClient: AuthProps = { userId: p.auth.userId, clientId: `c-other-${crypto.randomUUID().slice(0, 8)}` };
    await openStore(env).grants.add(otherClient.userId, otherClient.clientId, p.accountId);
    const before = await apiWrites(p.email);
    expect((await exec(otherClient, share(p.fileId), { apply: true })).error?.code).toBe("GWS_APPROVAL_REQUIRED");
    expect(await apiWrites(p.email)).toEqual(before);
    // Another user cannot use it either, whatever their plan: the claim names user and client.
    const approvals = openApprovals(env);
    const { results } = await env.DB.prepare("SELECT plan_hash FROM approvals WHERE user_id = ? AND used_at IS NULL").bind(p.userId).all<{ plan_hash: string }>();
    const planHash = results[0]?.plan_hash ?? "";
    expect(await approvals.claim({ planHash, userId: "someone-else", clientId: p.auth.clientId, now: Date.now() })).toBeNull();
    expect(await approvals.claim({ planHash, userId: p.userId, clientId: otherClient.clientId, now: Date.now() })).toBeNull();
    // Still unused for its own user and client.
    expect((await exec(p.auth, share(p.fileId), { apply: true })).ok).toBe(true);
  });

  it("lets exactly one of two concurrent applies use one approval", async () => {
    const p = await person("ap-race");
    await decide(p, share(p.fileId), "approve");
    const before = await apiWrites(p.email);
    const outs = await Promise.all([exec(p.auth, share(p.fileId), { apply: true }), exec(p.auth, share(p.fileId), { apply: true })]);
    expect(outs.filter((o) => o.ok)).toHaveLength(1);
    expect(outs.filter((o) => o.error?.code === "GWS_APPROVAL_REQUIRED")).toHaveLength(1);
    expect((await apiWrites(p.email)).length).toBe(before.length + 1);
  });

  it("expires ten minutes after the person approved", async () => {
    const p = await person("ap-expiry");
    await decide(p, share(p.fileId), "approve");
    const later = Date.now() + APPROVAL_TTL_MS + 1000;
    const before = await apiWrites(p.email);
    expect((await exec(p.auth, share(p.fileId), { apply: true, now: () => later })).error?.code).toBe("GWS_APPROVAL_REQUIRED");
    expect(await apiWrites(p.email)).toEqual(before);
  });

  it("an expired link shows the not-valid page and is unknown to its reader", async () => {
    const p = await person("ap-link-expiry");
    const dry = await exec(p.auth, share(p.fileId));
    const { token } = linkPath(dry);
    expect(await peekApprovalLink(env.CACHE_KV, token, Date.now())).not.toBeNull();
    expect(await peekApprovalLink(env.CACHE_KV, token, Date.now() + APPROVAL_TTL_MS + 1000)).toBeNull();
  });

  it("refuses a step the applied run reaches that was not in the approved plan, before sending it", async () => {
    const p = await person("ap-diverge");
    // In a dry run a write returns a pending value; this code shares publicly only when it sees a real one.
    const code = `async () => {
      const f = await sdk.drive.files.create({ requestBody: { name: "diverge.txt" } });
      if (String(f.id).startsWith("__gws_pending__")) return "dry";
      return sdk.drive.permissions.create({ fileId: f.id, requestBody: { role: "reader", type: "anyone" } });
    }`;
    const dry = await exec(p.auth, code);
    expect(dry.approval).toBeUndefined();
    const out = await exec(p.auth, code, { apply: true });
    expect(out.error?.code).toBe("GWS_APPROVAL_REQUIRED");
    expect(out.error?.message).toContain("it was not in the plan the person approved");
    expect(out.calls.map((c) => [c.fn, c.status])).toEqual([
      ["drive.files.create", "ok"],
      ["drive.permissions.create", "denied"],
    ]);
    expect((await apiWrites(p.email)).filter((w) => w.includes("/permissions"))).toEqual([]);
  });
});

describe("the approved steps under apply", () => {
  it("run each once: a second identical step the applied run adds is refused before it is sent", async () => {
    const p = await person("ap-twice");
    // One share in the dry run; under apply the code shares a second time.
    const code = `async () => {
      const first = await sdk.drive.permissions.create({ fileId: ${JSON.stringify(p.fileId)}, requestBody: { role: "reader", type: "anyone" } });
      if (String(first.id).startsWith("__gws_pending__")) return "dry";
      return sdk.drive.permissions.create({ fileId: ${JSON.stringify(p.fileId)}, requestBody: { role: "reader", type: "anyone" } });
    }`;
    await decide(p, code, "approve");
    const before = await apiWrites(p.email);
    const out = await exec(p.auth, code, { apply: true });
    expect(out.error?.code).toBe("GWS_APPROVAL_REQUIRED");
    expect(out.calls.map((c) => c.status)).toEqual(["ok", "denied"]);
    expect((await apiWrites(p.email)).length).toBe(before.length + 1);
  });
});

describe("the approval page", () => {
  it("declining uses the link and approves nothing", async () => {
    const p = await person("ap-decline");
    const { res, form, path } = await decide(p, share(p.fileId), "decline");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(APPROVAL_LINK_COPY.declined);
    expect(await auditByFn(p.userId, "approval.link.declined")).toEqual([expect.objectContaining({ client_id: p.auth.clientId, applied: 1, request_id: expect.stringMatching(/^plan:[0-9a-f]{16}$/) })]);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM approvals WHERE user_id = ?").bind(p.userId).first<{ n: number }>())?.n).toBe(0);
    expect((await exec(p.auth, share(p.fileId), { apply: true })).error?.code).toBe("GWS_APPROVAL_REQUIRED");
    expect((await post(p.browser, { ...form, decision: "approve" })).status).toBe(400);
    expect((await p.browser.fetch(path)).status).toBe(400);
  });

  it("gives another signed-in person the not-valid page, and the link stays usable for its owner", async () => {
    const p = await person("ap-owner");
    const q = await person("ap-intruder");
    const dry = await exec(p.auth, share(p.fileId));
    const { path, token } = linkPath(dry);
    const theirs = await q.browser.fetch(path);
    expect(theirs.status).toBe(400);
    const theirsText = await theirs.text();
    expect(theirsText).toContain("Nothing was approved. Ask your AI app for a new one.");
    expect(theirsText).not.toContain(p.email);
    const unknown = await q.browser.fetch(`${APPROVAL_LINK_PATH}?t=${"A".repeat(43)}`);
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toBe(theirsText);
    // A POST with the other person's own session and CSRF changes nothing either.
    const qPage = await (await q.browser.fetch("/")).text();
    const qCsrf = /name="csrf" value="([^"]+)"/.exec(qPage)?.[1] ?? "";
    expect((await post(q.browser, { csrf: qCsrf, t: token, decision: "approve" })).status).toBe(400);
    expect((await p.browser.fetch(path)).status).toBe(200);
    const used = await env.DB.prepare("SELECT count(*) AS n FROM used_links WHERE token_hash = ?").bind(await linkKey("approval", token)).first<{ n: number }>();
    expect(used?.n).toBe(0);
  });

  it("sends a signed-out browser to sign in and back to the link", async () => {
    const p = await person("ap-signedout");
    const { path } = linkPath(await exec(p.auth, share(p.fileId)));
    const res = await new Browser().fetch(path);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(path)}`);
  });

  it("refuses a POST without this site's Origin, and one without a decision", async () => {
    const p = await person("ap-guard");
    const { path } = linkPath(await exec(p.auth, share(p.fileId)));
    const form = formOf(await (await p.browser.fetch(path)).text());
    const foreign = await p.browser.fetch(APPROVAL_LINK_PATH, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ ...form, decision: "approve" }).toString(),
    });
    expect(foreign.status).toBe(403);
    expect((await post(p.browser, { ...form, decision: "maybe" })).status).toBe(400);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM approvals WHERE user_id = ?").bind(p.userId).first<{ n: number }>())?.n).toBe(0);
  });
});

describe("GWS_HUMAN_APPROVAL off, or no approval page", () => {
  it("off keeps the old behaviour: no mark, no link, apply runs directly with no planning pass", async () => {
    const p = await person("ap-off");
    const off = { GWS_HUMAN_APPROVAL: [] } satisfies Partial<Config>;
    const dry = await exec(p.auth, share(p.fileId), { config: off });
    expect(dry.plan[0]).not.toHaveProperty("needsApproval");
    expect(dry.approval).toBeUndefined();
    const applied = await exec(p.auth, share(p.fileId), { apply: true, config: off });
    expect(applied).toMatchObject({ ok: true, applied: true, plan: [] });
    expect(await anyonePermissions(p.email, p.fileId)).toBe(1);
    expect(await auditOf(`${PLANNING_PASS_PREFIX}${applied.executeId}`)).toEqual([]);
  });

  it("a runtime without the approval page refuses such steps and offers no link", async () => {
    const p = await person("ap-nopage");
    const ports = workersPorts(env);
    const dry = await exec(p.auth, share(p.fileId), { ports });
    expect(dry.approval).toEqual({ reasons: ["public-share"], note: expect.stringContaining("no page where the person could approve") });
    const before = await apiWrites(p.email);
    const out = await exec(p.auth, share(p.fileId), { apply: true, ports });
    expect(out.error?.code).toBe("GWS_APPROVAL_REQUIRED");
    expect(await apiWrites(p.email)).toEqual(before);
  });
});

describe("what the approval page shows", () => {
  it("never offers Approve for a step too large to show in full, and refuses the POST; the person can still decline", async () => {
    const p = await person("ap-large");
    // Padding that sorts before the recipient would push the recipient past what the page shows.
    const code = `async () => sdk.drive.permissions.create({ fileId: ${JSON.stringify(p.fileId)}, transferOwnership: true, requestBody: { displayName: "x".repeat(17000), role: "owner", type: "user", emailAddress: "attacker@evil.test" } })`;
    const dry = await exec(p.auth, code);
    expect(dry.plan[0]).toMatchObject({ reason: "owner-transfer", needsApproval: true });
    expect(dry.approval).toMatchObject({ reasons: ["owner-transfer"], url: expect.any(String), note: TOO_LARGE_NOTE });
    const { path } = linkPath(dry);
    const view = await p.browser.fetch(path);
    const page = await view.text();
    expect(view.status).toBe(200);
    expect(page).toContain(APPROVAL_LINK_COPY.tooLargeTitle);
    expect(page).not.toContain('value="approve"');
    expect(page).toContain('value="decline"');
    expect(page).not.toContain("xxxxxxxxxx");
    expectPlainLanguage(page, { allow: [p.email, APP_NAME] });
    // A crafted POST is refused server-side, and leaves the link usable.
    const refused = await post(p.browser, { ...formOf(page), decision: "approve" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain(APPROVAL_LINK_COPY.tooLargeTitle);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM approvals WHERE user_id = ?").bind(p.userId).first<{ n: number }>())?.n).toBe(0);
    const applied = await exec(p.auth, code, { apply: true });
    expect(applied.error?.code).toBe("GWS_APPROVAL_REQUIRED");
    expect(applied.error?.message).toContain("Split the change into smaller runs");
    expect((await post(p.browser, { ...formOf(page), decision: "decline" })).status).toBe(200);
  });

  it("names the AI app and lists the plan's other writes as context, apart from the steps to approve", async () => {
    const p = await person("ap-context");
    const code = `async () => {
      await sdk.drive.files.update({ fileId: ${JSON.stringify(p.fileId)}, requestBody: { name: "holiday-photo.jpg" } });
      return sdk.drive.permissions.create({ fileId: ${JSON.stringify(p.fileId)}, requestBody: { role: "reader", type: "anyone" } });
    }`;
    const dry = await exec(p.auth, code);
    const page = await (await p.browser.fetch(linkPath(dry).path)).text();
    // Escaped as any text: the name holds markup characters.
    expect(page).toContain("Approval &lt;Test&gt; App");
    expect(page).not.toContain("<Test>");
    const [needs, context] = page.split(APPROVAL_LINK_COPY.context);
    expect(needs).toContain("drive.permissions.create");
    expect(needs).not.toContain("drive.files.update");
    expect(context).toContain("drive.files.update");
    expect(context).toContain("holiday-photo.jpg");
    expectPlainLanguage(page, { allow: [p.email, APP_NAME] });
  });

  it("writes out hidden and direction-changing characters, and marks values with letters outside A to Z", async () => {
    const p = await person("ap-bidi");
    // A right-to-left override before the role, and a Cyrillic "о" in the recipient's domain.
    const code = `async () => sdk.drive.permissions.create({ fileId: ${JSON.stringify(p.fileId)}, transferOwnership: true, requestBody: { displayName: "\u202Eowner", role: "owner", type: "user", emailAddress: "bob@c\u043Empany.com" } })`;
    const dry = await exec(p.auth, code);
    const page = await (await p.browser.fetch(linkPath(dry).path)).text();
    expect(page).not.toContain("\u202E");
    expect(page).not.toContain("\u202e");
    expect(page).toContain("⟦U+202E⟧owner");
    expect(page).toContain(APPROVAL_LINK_COPY.lettersWarning.replace("'", "&#39;"));
    for (const hidden of ["\u202E", "\u200B", "\u2066", "\uFEFF"]) expect(page.includes(JSON.parse(`"${hidden}"`))).toBe(false);
  });

  it("digests the exact body bytes: the same fields sent in another order are another step", async () => {
    const p = await person("ap-bytes");
    // Known fields go out in schema order whatever the input order; fields the schema does not know keep theirs. The
    // planning pass sends extra_a before extra_b, the applied run the other way round.
    const code = `async () => {
      const probe = await sdk.drive.files.create({ requestBody: { name: "order.txt" } });
      const dry = String(probe.id).startsWith("__gws_pending__");
      const body = dry ? { role: "reader", type: "anyone", extra_a: "1", extra_b: "2" } : { role: "reader", type: "anyone", extra_b: "2", extra_a: "1" };
      return sdk.drive.permissions.create({ fileId: ${JSON.stringify(p.fileId)}, requestBody: body });
    }`;
    await decide(p, code, "approve");
    const out = await exec(p.auth, code, { apply: true });
    expect(out.error?.code).toBe("GWS_APPROVAL_REQUIRED");
    expect(await anyonePermissions(p.email, p.fileId)).toBe(0);
  });

  it("a helper that needs approval and waits on an unsent write is marked, and the note says to apply that write first", async () => {
    const p = await person("ap-helper");
    const code = `async () => {
      const f = await sdk.drive.files.create({ requestBody: { name: "cal-id.txt" } });
      return sdk.calendar.share({ calendarId: f.id, public: true, role: "reader" });
    }`;
    const dry = await exec(p.auth, code);
    expect(dry.plan[1]).toMatchObject({ fn: "calendar.share", reason: "public-share", needsApproval: true, incomplete: true });
    expect(dry.approval).toEqual({ reasons: ["public-share"], note: DEPENDENT_NOTE });
    expect(DEPENDENT_NOTE).toContain("Apply that earlier write in its own run first");
    const before = await apiWrites(p.email);
    const applied = await exec(p.auth, code, { apply: true });
    expect(applied.error?.code).toBe("GWS_APPROVAL_REQUIRED");
    expect(applied.error?.message).toContain("Apply that earlier write in its own run first");
    expect(await apiWrites(p.email)).toEqual(before);
  });

  it("raising access on a domain permission is a public share, found by reading the permission; a named person's is not", async () => {
    const p = await person("ap-domain");
    const off = { GWS_HUMAN_APPROVAL: [] } satisfies Partial<Config>;
    const made = await exec(
      p.auth,
      `async () => ({
        domain: (await sdk.drive.permissions.create({ fileId: ${JSON.stringify(p.fileId)}, requestBody: { type: "domain", role: "reader", domain: "example.test" } })).id,
        user: (await sdk.drive.permissions.create({ fileId: ${JSON.stringify(p.fileId)}, requestBody: { type: "user", role: "reader", emailAddress: "colleague@fake.test" } })).id,
      })`,
      { apply: true, config: off },
    );
    const ids = made.result as { domain: string; user: string };
    const update = (permissionId: string) =>
      `async () => sdk.drive.permissions.update({ fileId: ${JSON.stringify(p.fileId)}, permissionId: ${JSON.stringify(permissionId)}, requestBody: { role: "writer" } })`;
    expect((await exec(p.auth, update(ids.domain))).plan[0]).toMatchObject({ reason: "public-share", needsApproval: true });
    expect((await exec(p.auth, update("anyoneWithLink"))).plan[0]).toMatchObject({ reason: "public-share", needsApproval: true });
    // A permission that cannot be read counts as a public share.
    expect((await exec(p.auth, update("no-such-permission"))).plan[0]).toMatchObject({ reason: "public-share", needsApproval: true });
    const named = (await exec(p.auth, update(ids.user))).plan[0];
    expect(named?.destructive).toBe(false);
    expect(named?.needsApproval).toBeUndefined();
  });
});
