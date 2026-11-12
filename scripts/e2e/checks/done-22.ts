// Done 22: the access list, on the deployed shape. An email no rule matches is refused at sign-in and leaves no user
// behind; an allowed one signs in; an admin adds and removes a rule on the "Who can use this" page, and removing it
// ends the person's AI app access: the same token is rejected, within the 60 s window a Worker may cache a role (the
// approvals are deleted with the rule, so in practice at once), and the person cannot sign in again.
// The E2E database has no admin of its own: this check writes one exact-email admin rule for a made-up address on a
// reserved test domain and deletes it, and the person's rule, at the end. `fake.test` is allowed by the harness setup;
// no rule ever covers `denied.test`, and `allowed.test` is only ever named by the two exact rules above.
import { setTimeout as sleep } from "node:timers/promises";
import { d1Query, sqlLiteral } from "../d1-scan";
import { rawToolsList } from "../mcp";
import { Browser, approveClient, completeGoogle, signIn, signedInPage } from "../oauth-driver";
import type { CheckResult, E2eContext, Recorder } from "../run";

/** The longest a Worker reuses a person's role (src/auth/access.ts ACCESS_CACHE_MS), plus slack for the request. */
const WINDOW_MS = 60_000;
const SLACK_MS = 10_000;
const POLL_MS = 2_000;

const sub = (n: number) => `9${Date.now()}${n}${Math.floor(Math.random() * 1e6)}`;
const count = async (ctx: E2eContext, sql: string): Promise<number> => Number((await d1Query<{ n: number }>(ctx.d1, sql))[0]?.n ?? -1);

/** A fresh browser's sign-in attempt: the final response's status and text, and whether a session cookie was set. */
async function attempt(ctx: E2eContext, email: string): Promise<{ status: number; text: string; cookies: number }> {
  const browser = new Browser(ctx.base);
  const res = await completeGoogle(browser, ctx.fake, await browser.fetch("/login"), email);
  return { status: res.status, text: await res.text(), cookies: browser.cookies.size };
}

async function postAccess(browser: Browser, action: "add" | "remove", fields: Array<[string, string]>): Promise<Response> {
  const { csrf } = await signedInPage(browser, "/access");
  const res = await browser.postForm(`/access/${action}`, [["csrf", csrf], ...fields]);
  await res.body?.cancel();
  return res;
}

export default async function done22(ctx: E2eContext, r: Recorder): Promise<CheckResult> {
  const denied = `e2e-${ctx.runId}-x@denied.test`;
  const admin = `e2e-${ctx.runId}-adm@allowed.test`;
  const person = `e2e-${ctx.runId}-u@allowed.test`;
  await ctx.fake.seed({
    accounts: [denied, admin, person].map((email, i) => ({ email, sub: sub(i + 4), preset: "default" })),
  });
  try {
    // 1. An email no rule matches.
    const refused = await attempt(ctx, denied);
    r.check(refused.status === 403 && refused.text.includes("This gws-mcp is private") && refused.cookies === 0, `unknown email at sign-in -> ${refused.status}, the private page, session cookies: ${refused.cookies}`);
    const users = await count(ctx, `SELECT COUNT(*) AS n FROM users WHERE primary_email = ${sqlLiteral(denied)}`);
    r.check(users === 0, `the refused email left ${users} user rows`);

    // 2. An allowed email: the harness setup allowed the domain, and account a signed in through it.
    const rules = await count(ctx, `SELECT COUNT(*) AS n FROM access_rules WHERE pattern = '@fake.test' AND role = 'user'`);
    r.check(rules === 1, `account a's domain rule @fake.test is on the list as user (${rules}); a signed in through it`);

    // 3. An admin signs in (the database has none, so one exact-email rule is written), then adds and removes a rule.
    await d1Query(
      ctx.d1,
      `INSERT OR IGNORE INTO access_rules (pattern, role, note, created_by, created_at) VALUES (${sqlLiteral(admin)}, 'admin', NULL, 'e2e-harness', ${Date.now()})`,
    );
    const adminBrowser = new Browser(ctx.base);
    const adminLanded = await signIn(adminBrowser, ctx.fake, admin);
    ctx.secrets.push(...adminBrowser.cookieValues());
    r.check(new URL(adminLanded, ctx.base).origin === ctx.base, `exact-email admin signs in -> ${new URL(adminLanded, ctx.base).pathname}`);
    const page = await adminBrowser.fetch("/access");
    await page.body?.cancel();
    r.check(page.status === 200, `admin opens /access -> ${page.status}`);

    const added = await postAccess(adminBrowser, "add", [
      ["pattern", person],
      ["role", "user"],
    ]);
    r.check(added.status === 303, `admin adds ${person.replace(ctx.runId, "<run>")} as user on /access/add -> ${added.status}`);
    const rule = await count(ctx, `SELECT COUNT(*) AS n FROM access_rules WHERE pattern = ${sqlLiteral(person)} AND role = 'user'`);
    r.check(rule === 1, `the rule is in the database (${rule})`);

    // 4. The person signs in, is not an admin, and an AI app approved for their account works.
    const personBrowser = new Browser(ctx.base);
    const landed = await signIn(personBrowser, ctx.fake, person);
    ctx.secrets.push(...personBrowser.cookieValues());
    r.check(new URL(landed, ctx.base).origin === ctx.base, `the added person signs in -> ${new URL(landed, ctx.base).pathname}`);
    const hidden = await personBrowser.fetch("/access");
    await hidden.body?.cancel();
    r.check(hidden.status === 404, `a person who is not an admin opens /access -> ${hidden.status}`);
    const approved = await approveClient(personBrowser, `E2E access client ${ctx.runId}`, [person]);
    ctx.secrets.push(approved.accessToken);
    const before = await rawToolsList(ctx.base, approved.accessToken);
    r.check(before.status === 200, `the person's AI app token before removal: tools/list -> ${before.status}`);

    // 5. Removal ends their access within the window.
    const removed = await postAccess(adminBrowser, "remove", [["pattern", person]]);
    r.check(removed.status === 303, `admin removes the rule on /access/remove -> ${removed.status}`);
    const started = Date.now();
    let status = 200;
    while (status === 200 && Date.now() - started < WINDOW_MS + SLACK_MS) {
      status = (await rawToolsList(ctx.base, approved.accessToken)).status;
      if (status === 200) await sleep(POLL_MS);
    }
    const waited = Date.now() - started;
    r.check(status !== 200 && waited <= WINDOW_MS + SLACK_MS, `after removal the same token: tools/list -> ${status} after ${waited} ms (window ${WINDOW_MS} ms)`);
    const again = await attempt(ctx, person);
    r.check(again.status === 403 && again.text.includes("This gws-mcp is private"), `the removed person signs in again -> ${again.status}, the private page`);
    const left = await count(ctx, `SELECT COUNT(*) AS n FROM access_rules WHERE pattern = ${sqlLiteral(person)}`);
    r.check(left === 0, `the rule is gone from the database (${left})`);
  } finally {
    await d1Query(ctx.d1, `DELETE FROM access_rules WHERE pattern IN (${sqlLiteral(admin)}, ${sqlLiteral(person)})`).catch(() => undefined);
  }
  return r.done();
}
