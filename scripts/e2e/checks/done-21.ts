// Done 21: one read per marketing service against the fake, through the MCP tools: Search Console, Analytics data and
// admin, Tag Manager and Groups, then Google Ads. Ads and Groups are never part of a first sign-in or a plain
// "Add Google account", and neither is Analytics editing, so the account is connected for the services by name.
// Google Ads needs the developer code the user saves on the account page: without it the call is refused before any
// request reaches Google (GWS_ADS_DEVELOPER_TOKEN_MISSING), and the refusal carries a one-time link where the signed-in
// person sets the code themselves (used once, then refused). After saving it, the read passes, and the code is not in
// the output, nor in the database in plain text.
import { codeOf } from "../mcp";
import { scanD1 } from "../d1-scan";
import { connectFromAccounts, formFields, signedInPage } from "../oauth-driver";
import type { CheckResult, E2eContext, Recorder } from "../run";

const SERVICES = ["searchconsole", "analytics", "analyticsadmin", "ads", "groups", "tagmanager"] as const;

export default async function done21(ctx: E2eContext, r: Recorder): Promise<CheckResult> {
  const email = `e2e-${ctx.runId}-s@fake.test`;
  await ctx.fake.seed({ accounts: [{ email, sub: `9${Date.now()}7${Math.floor(Math.random() * 1e6)}`, preset: "default" }] });
  const landed = await connectFromAccounts(ctx.browser, ctx.fake, email, SERVICES);
  r.check(new URL(landed, ctx.base).pathname === "/accounts", `account s connected for ${SERVICES.join(", ")} by name -> ${new URL(landed, ctx.base).pathname}`);
  const accountId = (await ctx.accountIds())[email];
  if (accountId === undefined) {
    r.fail("account s is not on the user's list");
    return r.done();
  }
  const client = await ctx.newClient(`E2E marketing client ${ctx.runId}`, [email]);
  const s = client.session;
  const account = JSON.stringify(email);

  const reads = await s.execute(`async () => {
    const sites = await sdk.webmasters.sites.list({ account: ${account} });
    const meta = await sdk.analyticsdata.properties.getMetadata({ name: "properties/2001/metadata", account: ${account} });
    const summaries = await sdk.analyticsadmin.accountSummaries.list({ account: ${account} });
    const containers = await sdk.tagmanager.containers({ account: ${account} });
    const groups = await sdk.directory.groups.list({ customer: "my_customer", account: ${account} });
    return {
      sites: (sites.siteEntry ?? []).map((x) => x.siteUrl),
      metrics: (meta.metrics ?? []).length,
      properties: (summaries.accountSummaries ?? []).flatMap((a) => (a.propertySummaries ?? []).map((p) => p.property)),
      containers: containers.containers.map((c) => c.publicId),
      groups: (groups.groups ?? []).length,
    };
  }`);
  const v = reads.out.result as { sites?: string[]; metrics?: number; properties?: string[]; containers?: string[]; groups?: number } | undefined;
  r.check(
    reads.out.ok && reads.out.calls.length >= 5 && reads.out.calls.every((c) => c.status === "ok" && c.effect === "read"),
    `reads: ${reads.out.calls.map((c) => `${c.fn}:${c.status}`).join(", ") || codeOf(reads.out)}`,
  );
  r.check((v?.sites ?? []).includes("https://example.test/"), `Search Console sites -> ${JSON.stringify(v?.sites ?? [])}`);
  r.check((v?.metrics ?? 0) > 0, `Analytics data metadata -> ${v?.metrics ?? "-"} metrics`);
  r.check((v?.properties ?? []).includes("properties/2001"), `Analytics admin account summaries -> ${JSON.stringify(v?.properties ?? [])}`);
  r.check((v?.containers ?? []).includes("GTM-AB12CD"), `Tag Manager containers -> ${JSON.stringify(v?.containers ?? [])}`);
  r.check((v?.groups ?? 0) > 0, `Groups directory.groups.list -> ${v?.groups ?? "-"} groups`);

  const ads = `async () => sdk.ads.accounts({ account: ${account} })`;
  const before = (await ctx.fake.requests(email)).length;
  const missing = await s.execute(ads);
  const reached = (await ctx.fake.requests(email)).slice(before).filter((q) => q.path.includes("googleads")).length;
  r.check(codeOf(missing.out) === "GWS_ADS_DEVELOPER_TOKEN_MISSING" && reached === 0, `Ads before saving a developer code -> ${codeOf(missing.out)}, requests that reached the fake: ${reached}`);

  // The refusal's one-time link: the signed-in person enters a code on its page, and the link works only once.
  const setLink = missing.out.error?.details?.setLink as { url?: unknown } | undefined;
  const linkUrl = typeof setLink?.url === "string" ? new URL(setLink.url) : undefined;
  const onSite = linkUrl !== undefined && linkUrl.origin === new URL(ctx.base).origin && linkUrl.pathname === "/settings/set";
  if (!r.check(onSite, "the missing-code error carries a one-time setting link on gws-mcp") || linkUrl === undefined) return r.done();
  ctx.secrets.push(linkUrl.searchParams.get("t") ?? "");
  const linkPath = `${linkUrl.pathname}${linkUrl.search}`;
  const linkPage = await ctx.browser.fetch(linkPath);
  const linkHtml = await linkPage.text();
  r.check(
    linkPage.status === 200 &&
      linkPage.headers.get("cache-control") === "no-store" &&
      linkPage.headers.get("referrer-policy") === "same-origin" &&
      linkHtml.includes("Set your Google Ads developer code"),
    `open the setting link -> ${linkPage.status}, cache-control ${linkPage.headers.get("cache-control")}, referrer-policy ${linkPage.headers.get("referrer-policy")}`,
  );
  const linkFields = formFields(linkHtml, "/settings/set");
  if (!r.check(linkFields !== undefined, "the link page offers the developer code form")) return r.done();
  const linkCode = `FAKE-dev-code-link-${ctx.runId}`;
  ctx.secrets.push(linkCode);
  const viaLink = await ctx.browser.postForm("/settings/set", [...(linkFields ?? []), ["value", linkCode]]);
  const viaLinkText = await viaLink.text();
  r.check(viaLink.status === 200 && !viaLinkText.includes(linkCode), `save a developer code through the link -> ${viaLink.status}, the code is not in the page`);
  // A used link gets the one "not valid" answer (400) on every store: the database's record of used links is read
  // before anything else, so a link store still serving the deleted record changes nothing.
  const replay = await ctx.browser.postForm("/settings/set", [...(linkFields ?? []), ["value", linkCode]]);
  await replay.body?.cancel();
  r.check(replay.status === 400, `the same link again -> ${replay.status}`);
  const isSet = await s.execute(`async () => sdk.settings.get({ key: "ads.developer_token" })`);
  r.check((isSet.out.result as { isSet?: boolean } | undefined)?.isSet === true && !isSet.text.includes(linkCode), "settings.get sees it set, never the code");

  const page = `/accounts/${encodeURIComponent(accountId)}`;
  const action = `${page}/ads`;
  const code = `FAKE-dev-code-${ctx.runId}`;
  ctx.secrets.push(code);
  const { html } = await signedInPage(ctx.browser, page);
  const hidden = formFields(html, action);
  if (!r.check(hidden !== undefined, "the account page offers the Google Ads details form")) return r.done();
  const saved = await ctx.browser.postForm(action, [...(hidden ?? []), ["developerCode", code], ["managerId", ""]]);
  await saved.body?.cancel();
  r.check(saved.status === 303, `save the developer code on ${action} -> ${saved.status}`);

  const after = await s.execute(ads);
  const customers = (after.out.result as { customers?: unknown[] } | undefined)?.customers ?? [];
  r.check(after.out.ok && customers.length >= 1 && !after.text.includes(code), `Ads after saving it -> ${after.out.ok ? `${customers.length} customers` : codeOf(after.out)}, the code is not in the output`);
  const scan = await scanD1(ctx.d1, [], [code, linkCode]);
  r.check(scan.hits.length === 0, `D1 scan for the saved developer codes (${scan.tables.length} tables): ${scan.hits.length === 0 ? "clean" : scan.hits.join("; ")}`);
  await s.close();
  return r.done();
}
