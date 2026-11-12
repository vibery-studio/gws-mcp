import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { openUserSettings } from "../../src/store/user-settings";
import { fake } from "../helpers/fake";
import { connect, errorCodeOf, G, session, valueOf } from "../helpers-fns/harness";

const TAGMANAGER_ACCOUNT = "6001001001";
const USERS = `${G}tagmanager.manage.users`;
const MANAGE_ACCOUNTS = `${G}tagmanager.manage.accounts`;
const TAGMANAGER_READ = `${G}tagmanager.readonly`;
const ADS_CUSTOMER = "9876543210";
/** The fake's Ads metrics cover 2026-11-03 to 2026-11-09. */
const ADS_NOW = Date.parse("2026-11-10T05:00:00Z");

/** An account update aimed at a user permission through the reserved `{+path}`. */
const aliasedUpdate = {
  path: `accounts/${TAGMANAGER_ACCOUNT}/user_permissions/9`,
  requestBody: { emailAddress: "someone@example.com", accountAccess: { permission: "admin" } },
};

/**
 * A fresh account, connected with a cold token cache: its first Google call would refresh the access token at the
 * fake's OAuth endpoint. Returns the fake's request log for the account so far (connecting logs its own requests).
 */
async function coldTagManagerAccount() {
  const client = await connect("rp-gtm", [MANAGE_ACCOUNTS, USERS]);
  return { ...client, logBefore: await fake.requests(client.email) };
}

describe("a reserved path that names another resource", () => {
  it.each([false, true])("is refused before any request to Google, token refresh included (apply %s)", async (apply) => {
    const { auth, email, logBefore } = await coldTagManagerAccount();
    const r = await session(auth, apply).s.dispatch("tagmanager.accounts.update", aliasedUpdate);
    expect(errorCodeOf(r)).toBe("GWS_INVALID_INPUT");
    expect(r).toMatchObject({ __gwsError: { details: { param: "path", reason: "pattern-mismatch" } } });
    expect(await fake.requests(email)).toEqual(logBefore);
  });

  it.each([
    [`accounts/${TAGMANAGER_ACCOUNT}/../${TAGMANAGER_ACCOUNT}/user_permissions/9`, "dot-segment"],
    [`accounts/${TAGMANAGER_ACCOUNT}%2Fuser_permissions%2F9`, "percent-sign"],
  ])("refuses the traversal or encoded variant %j (%s) before any request to Google", async (path, reason) => {
    const { auth, email, logBefore } = await coldTagManagerAccount();
    const r = await session(auth, true).s.dispatch("tagmanager.accounts.update", { ...aliasedUpdate, path });
    expect(r).toMatchObject({ __gwsError: { code: "GWS_INVALID_INPUT", details: { param: "path", reason } } });
    expect(await fake.requests(email)).toEqual(logBefore);
  });

  it("is refused before the developer-code check on a Google Ads method", async () => {
    const { auth, email } = await connect("rp-ads", [`${G}adwords`]);
    const logBefore = await fake.requests(email);
    const r = await session(auth, false).s.dispatch("googleads.customers.googleAds.search", {
      customerId: `${ADS_CUSTOMER}/x`,
      requestBody: { query: "SELECT campaign.id FROM campaign" },
    });
    expect(r).toMatchObject({ __gwsError: { code: "GWS_INVALID_INPUT", details: { param: "customerId", reason: "pattern-mismatch" } } });
    expect(await fake.requests(email)).toEqual(logBefore);
  });
});

describe("a reserved path of the expected form still reaches Google", () => {
  it("tagmanager", async () => {
    const { auth } = await connect("rp-gtm", [TAGMANAGER_READ]);
    const out = valueOf(await session(auth, false).s.dispatch("tagmanager.accounts.containers.list", { parent: `accounts/${TAGMANAGER_ACCOUNT}` }));
    expect((out.container as unknown[]).length).toBeGreaterThan(0);
  });

  it("analyticsadmin", async () => {
    const { auth } = await connect("rp-gaa", [`${G}analytics.readonly`]);
    const out = valueOf(await session(auth, false).s.dispatch("analyticsadmin.properties.dataStreams.list", { parent: "properties/2001" }));
    expect(Array.isArray(out.dataStreams)).toBe(true);
  });

  it("analyticsdata", async () => {
    const { auth } = await connect("rp-gad", [`${G}analytics.readonly`]);
    const out = valueOf(await session(auth, false).s.dispatch("analyticsdata.properties.getMetadata", { name: "properties/2001/metadata" }));
    expect(out.name).toBe("properties/2001/metadata");
  });

  it("googleads", async () => {
    const client = await connect("rp-ads", [`${G}adwords`], { now: ADS_NOW });
    await openUserSettings(env).set(client.auth.userId, "ads.developer_token", `FAKE-dev-token-${crypto.randomUUID().slice(0, 8)}`);
    const out = valueOf(
      await session(client.auth, false).s.dispatch("googleads.customers.googleAds.search", {
        customerId: ADS_CUSTOMER,
        requestBody: { query: "SELECT campaign.id FROM campaign" },
      }),
    );
    expect(Array.isArray(out.results)).toBe(true);
  });

  it("slides", async () => {
    const { auth } = await connect("rp-slides", [`${G}presentations`]);
    const created = valueOf(await session(auth, true).s.dispatch("slides.presentations.create", { requestBody: { title: "Reserved path" } }));
    const presentationId = String(created.presentationId);
    const got = valueOf(await session(auth, false).s.dispatch("slides.presentations.get", { presentationId }));
    expect(got.presentationId).toBe(presentationId);
  });
});
