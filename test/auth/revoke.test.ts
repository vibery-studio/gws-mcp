import { getOAuthApi, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { grantIdOfRedirect, listClients, recordApproval, revokeClient } from "../../src/auth/clients";
import { providerOptions } from "../../src/auth/provider-options";
import { mcpApiHandler } from "../../src/mcp/server";
import { webApp } from "../../src/web/app";
import { openStore } from "../../src/store/db";
import { uniqueEmail } from "../helpers/fake";
import {
  BASE,
  CLIENT_REDIRECT,
  Browser,
  approveClient,
  authorizePath,
  defaultAccount,
  exchangeCode,
  grantRows,
  mcpToolsList,
  parseConsent,
  pkce,
  seedGoogle,
  signIn,
  userIdFor,
  type ConsentForm,
} from "./browser";

/** The env the web app sees: the provider adds its helpers to it. */
const helpers = getOAuthApi({ ...providerOptions(env), apiRoute: "/mcp", apiHandler: mcpApiHandler, defaultHandler: webApp }, env);
const webEnv = { ...env, OAUTH_PROVIDER: helpers } as Env;

/** OAUTH_KV whose grant listing is empty, as Cloudflare's eventually consistent KV list can be right after a write. */
const staleGrantListingKv = new Proxy(env.OAUTH_KV, {
  get(target, key) {
    if (key === "list") {
      return (options?: KVNamespaceListOptions) =>
        options?.prefix?.startsWith("grant:") ? Promise.resolve({ keys: [], list_complete: true, cacheStatus: null }) : target.list(options);
    }
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  },
});
const staleHelpers = getOAuthApi(
  { ...providerOptions(env), apiRoute: "/mcp", apiHandler: mcpApiHandler, defaultHandler: webApp },
  { ...env, OAUTH_KV: staleGrantListingKv },
);
/** The web env whose provider helpers (consent, listing, revoke) all see that stale grant listing. */
const staleEnv = { ...env, OAUTH_PROVIDER: staleHelpers } as Env;

/** The web env with the provider's grant revocation failing, as a KV outage mid-revoke would. */
function envWithFailingRevoke(): Env {
  const failing = new Proxy(helpers, {
    get(target, key) {
      if (key === "revokeGrant") return () => Promise.reject(new Error("injected revoke failure"));
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) satisfies OAuthHelpers;
  return { ...env, OAUTH_PROVIDER: failing } as Env;
}

async function signedInUser(prefix: string, browser = new Browser()): Promise<{ browser: Browser; userId: string }> {
  const email = uniqueEmail(prefix);
  const sub = await seedGoogle(email);
  await signIn(browser, email);
  return { browser, userId: userIdFor(sub) };
}

describe("revoking a client", () => {
  it("rejects the same token afterwards, drops its allowlist and leaves other clients alone", async () => {
    const { browser, userId } = await signedInUser("revoke");
    const revoked = await approveClient(browser, "Client to revoke", defaultAccount);
    const kept = await approveClient(browser, "Client to keep", defaultAccount);
    expect(await mcpToolsList(revoked.accessToken)).toBe(200);
    expect(await helpers.unwrapToken(revoked.accessToken)).not.toBeNull();
    expect(await grantRows(userId, revoked.clientId)).toHaveLength(1);

    const listed = await listClients(webEnv, userId);
    expect(listed.map((c) => [c.clientName, c.accountIds.length]).sort()).toEqual([
      ["Client to keep", 1],
      ["Client to revoke", 1],
    ]);

    await revokeClient(webEnv, userId, revoked.clientId);

    expect(await mcpToolsList(revoked.accessToken)).toBe(401);
    expect(await helpers.unwrapToken(revoked.accessToken)).toBeNull();
    expect(await grantRows(userId, revoked.clientId)).toEqual([]);
    expect((await listClients(webEnv, userId)).map((c) => c.clientId)).toEqual([kept.clientId]);

    expect(await mcpToolsList(kept.accessToken)).toBe(200);
    expect(await grantRows(userId, kept.clientId)).toHaveLength(1);
  });

  it("also kills the client's refresh token", async () => {
    const { browser, userId } = await signedInUser("revoke-refresh");
    const client = await approveClient(browser, "Refresh client", defaultAccount);
    expect(client.refreshToken).toBeTruthy();
    await revokeClient(webEnv, userId, client.clientId);
    const res = await exports.default.fetch(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: client.refreshToken ?? "", client_id: client.clientId }).toString(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe("invalid_grant");
  });

  it("removes the allowlist first, so a failure while revoking tokens still leaves the client no account", async () => {
    const { browser, userId } = await signedInUser("revoke-partial");
    const client = await approveClient(browser, "Half-revoked client", defaultAccount);
    const [accountId] = await grantRows(userId, client.clientId);
    expect(accountId).toBeTruthy();
    await expect(revokeClient(envWithFailingRevoke(), userId, client.clientId)).rejects.toThrow("injected revoke failure");
    expect(await grantRows(userId, client.clientId)).toEqual([]);
    expect(await openStore(env).grants.isAllowed(userId, client.clientId, accountId ?? "")).toBe(false);
  });

  it("lists clients with display-safe names", async () => {
    const { browser, userId } = await signedInUser("revoke-name");
    const client = await approveClient(browser, `\u202Eexe.txt\u0000${"n".repeat(500)}`, defaultAccount);
    const [listed] = (await listClients(webEnv, userId)).filter((c) => c.clientId === client.clientId);
    expect(listed?.clientName.startsWith("exe.txtnnn")).toBe(true);
    expect(Array.from(listed?.clientName ?? "").length).toBeLessThanOrEqual(101);
  });

  it("revokes only the given user's grant of a client", async () => {
    const one = await signedInUser("revoke-one");
    const two = await signedInUser("revoke-two");
    const a = await approveClient(one.browser, "Shared name", defaultAccount);
    const b = await approveClient(two.browser, "Shared name", defaultAccount);
    await revokeClient(webEnv, one.userId, b.clientId);
    expect(await mcpToolsList(b.accessToken)).toBe(200);
    expect(await mcpToolsList(a.accessToken)).toBe(200);
  });

  it("keeps the approval rows after a failed revoke, so the client stays listed and a retry finishes", async () => {
    const { browser, userId } = await signedInUser("revoke-retry");
    const client = await approveClient(browser, "Retried client", defaultAccount);
    await expect(revokeClient(envWithFailingRevoke(), userId, client.clientId)).rejects.toThrow("injected revoke failure");
    expect(await approvalRows(userId, client.clientId)).toHaveLength(1);
    expect((await listClients(webEnv, userId)).map((c) => c.clientId)).toEqual([client.clientId]);
    await revokeClient(webEnv, userId, client.clientId);
    expect(await mcpToolsList(client.accessToken)).toBe(401);
    expect(await approvalRows(userId, client.clientId)).toEqual([]);
    expect(await listClients(webEnv, userId)).toEqual([]);
  });

  it("revokes every recorded grant even when the provider's listing does not show them yet", async () => {
    const { browser, userId } = await signedInUser("revoke-stale", new Browser(async (r) => webApp.fetch(r, staleEnv)));
    const client = await approveClient(browser, "Fresh client", defaultAccount);
    expect((await staleHelpers.listUserGrants(userId)).items).toEqual([]);
    expect(await approvalRows(userId, client.clientId)).toHaveLength(1);
    await revokeClient(staleEnv, userId, client.clientId);
    expect(await helpers.unwrapToken(client.accessToken)).toBeNull();
    expect(await mcpToolsList(client.accessToken)).toBe(401);
    expect(await approvalRows(userId, client.clientId)).toEqual([]);
  });

  it("also revokes a grant the provider lists but no approval recorded", async () => {
    const { browser, userId } = await signedInUser("revoke-unrecorded");
    const client = await approveClient(browser, "Unrecorded client", defaultAccount);
    await env.DB.prepare("DELETE FROM client_approvals WHERE user_id = ? AND client_id = ?").bind(userId, client.clientId).run();
    await revokeClient(webEnv, userId, client.clientId);
    expect(await mcpToolsList(client.accessToken)).toBe(401);
  });
});

/** The D1 approval rows (grant ids) of a user's client, oldest first. */
async function approvalRows(userId: string, clientId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT grant_id FROM client_approvals WHERE user_id = ? AND client_id = ? ORDER BY created_at, grant_id")
    .bind(userId, clientId)
    .all<{ grant_id: string }>();
  return results.map((r) => r.grant_id);
}

/** Approves an already registered client once more from the same browser; returns the new access token. */
async function approveAgain(browser: Browser, clientId: string, accountIds: (form: ConsentForm) => string[]): Promise<string> {
  const { verifier, challenge } = await pkce();
  const page = await browser.fetch(authorizePath(clientId, challenge, crypto.randomUUID()));
  const form = parseConsent(await page.text());
  const approved = await browser.postForm("/authorize", [
    ["handle", form.handle],
    ["csrf", form.csrf],
    ["decision", "approve"],
    ...accountIds(form).map((id): [string, string] => ["account", id]),
  ]);
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const body = (await (await exchangeCode(clientId, code, verifier)).json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string") throw new Error("token exchange returned no access_token");
  return body.access_token;
}

describe("recording approvals", () => {
  it("records the grant of each consent and retires the earlier one even when the provider's listing missed it", async () => {
    const { browser, userId } = await signedInUser("approve-again", new Browser(async (r) => webApp.fetch(r, staleEnv)));
    const first = await approveClient(browser, "Approved twice", defaultAccount);
    const [firstGrant] = await approvalRows(userId, first.clientId);
    expect(firstGrant).toBe(first.accessToken.split(":")[1]);

    const second = await approveAgain(browser, first.clientId, () => []);
    const secondGrant = second.split(":")[1];
    expect(await approvalRows(userId, first.clientId)).toEqual([secondGrant]);
    expect(await mcpToolsList(first.accessToken)).toBe(401);
    expect(await mcpToolsList(second)).toBe(200);
    // The second consent's choice replaced the allowlist.
    expect(await grantRows(userId, first.clientId)).toEqual([]);
    const [listed] = await listClients(webEnv, userId);
    expect(listed).toMatchObject({ clientId: first.clientId, clientName: "Approved twice", accountIds: [] });
  });

  it("keeps an earlier grant's row when retiring it fails, so a later revoke still reaches it", async () => {
    const { browser, userId } = await signedInUser("approve-keep");
    const client = await approveClient(browser, "Kept row", defaultAccount);
    const [earlier] = await approvalRows(userId, client.clientId);
    const redirectTo = `${CLIENT_REDIRECT}?code=${encodeURIComponent(`${userId}:newgrant_1:secret`)}`;
    await recordApproval(envWithFailingRevoke(), { userId, clientId: client.clientId, clientName: "Kept row", redirectTo });
    expect((await approvalRows(userId, client.clientId)).sort()).toEqual([earlier, "newgrant_1"].sort());
    await revokeClient(webEnv, userId, client.clientId);
    expect(await mcpToolsList(client.accessToken)).toBe(401);
    expect(await approvalRows(userId, client.clientId)).toEqual([]);
  });

  it("retires only approvals older than the new one, so a newer consent that landed meanwhile keeps its grant", async () => {
    const { id: userId } = await openStore(env).users.create({ sub: `${Date.now()}${Math.random()}`.replace(".", ""), email: uniqueEmail("approve-older") });
    const clientId = "client-interleave";
    const now = Date.now();
    // An older grant, and a newer consent's row recorded between this consent's insert and its read.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO client_approvals (user_id, client_id, grant_id, client_name, created_at) VALUES (?, ?, ?, ?, ?)").bind(
        userId,
        clientId,
        "older_grant",
        "C",
        now - 60_000,
      ),
      env.DB.prepare("INSERT INTO client_approvals (user_id, client_id, grant_id, client_name, created_at) VALUES (?, ?, ?, ?, ?)").bind(
        userId,
        clientId,
        "newer_grant",
        "C",
        now + 60_000,
      ),
    ]);
    const revoked: string[] = [];
    const stub = { revokeGrant: async (id: string) => void revoked.push(id) } as unknown as OAuthHelpers;
    const redirectTo = `${CLIENT_REDIRECT}?code=${encodeURIComponent(`${userId}:this_grant:secret`)}`;
    await recordApproval({ ...env, OAUTH_PROVIDER: stub } as Env, { userId, clientId, clientName: "C", redirectTo });
    expect(revoked).toEqual(["older_grant"]);
    expect(await approvalRows(userId, clientId)).toEqual(["this_grant", "newer_grant"]);
  });

  it("leaves exactly the latest grant when two consents of one client run concurrently", async () => {
    const { id: userId } = await openStore(env).users.create({ sub: `${Date.now()}${Math.random()}`.replace(".", ""), email: uniqueEmail("approve-race") });
    const clientId = "client-race";
    const revoked: string[] = [];
    const stub = { revokeGrant: async (id: string) => void revoked.push(id) } as unknown as OAuthHelpers;
    const consentEnv = { ...env, OAUTH_PROVIDER: stub } as Env;
    const consent = (grantId: string) =>
      recordApproval(consentEnv, { userId, clientId, clientName: "C", redirectTo: `${CLIENT_REDIRECT}?code=${encodeURIComponent(`${userId}:${grantId}:secret`)}` });
    // Both inserts land before either consent reads the rows back. The second is the later one (time, then grant id).
    await Promise.all([consent("race_a"), consent("race_b")]);
    expect(await approvalRows(userId, clientId)).toEqual(["race_b"]);
    expect(revoked).toEqual(["race_a"]);
  });

  it("reads the grant id from the authorization code and refuses anything else", () => {
    const redirect = (code: string | null) => {
      const url = new URL("https://mcp-client.example/callback?state=s");
      if (code !== null) url.searchParams.set("code", code);
      return url.toString();
    };
    expect(grantIdOfRedirect(redirect("u_1:Ab-_9:secret"), "u_1")).toBe("Ab-_9");
    for (const bad of [redirect(null), redirect("u_2:Ab:secret"), redirect("u_1:Ab"), redirect("u_1::secret"), redirect("u_1:a b:secret"), "not a url"]) {
      expect(() => grantIdOfRedirect(bad, "u_1"), bad).toThrow(/grant/);
    }
  });
});
