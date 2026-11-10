// Done 6: a client allowlisted for account A gets a structured denial on account B; connecting account C leaves
// that client's allowlist unchanged (C is not listed for it, its hidden count grows, calls on C are denied).
// Only the human's confirmation of an `accounts.grant` link on /connections/confirm widens the allowlist.
import { d1Query, sqlLiteral } from "../d1-scan";
import { codeOf } from "../mcp";
import { confirmGrant, connectFromLink } from "../oauth-driver";
import type { CheckResult, E2eContext, Recorder } from "../run";

type AccountList = { accounts: Array<{ email: string }>; hiddenCount: number };

export default async function done06(ctx: E2eContext, r: Recorder): Promise<CheckResult> {
  const s = ctx.main.session;
  const { a, b, c } = ctx.emails;
  const labelsOn = (email: string) => `async () => sdk.gmail.users.labels.list({ userId: "me", account: ${JSON.stringify(email)} })`;
  const list = async (): Promise<AccountList | undefined> => (await s.execute(`async () => sdk.accounts.list()`)).out.result as AccountList | undefined;
  const allowlist = async () =>
    (
      await d1Query<{ email: string }>(
        ctx.d1,
        `SELECT a.email FROM client_grants g JOIN accounts a ON a.id = g.account_id WHERE g.client_id = ${sqlLiteral(ctx.main.clientId)} ORDER BY a.email`,
      )
    ).map((x) => x.email);

  r.check(codeOf((await s.execute(labelsOn(a))).out) === "none", "call on a (allowlisted) -> ok");
  const onB = await s.execute(labelsOn(b));
  r.check(codeOf(onB.out) === "GWS_ACCOUNT_DENIED", `call on b (not allowlisted) -> ${codeOf(onB.out)}`);

  const before = await list();
  const allowedBefore = await allowlist();
  r.check(JSON.stringify(before?.accounts.map((x) => x.email)) === JSON.stringify([a]), `accounts.list before: accounts=[a] hiddenCount=${before?.hiddenCount}`);

  const link = await s.execute(`async () => sdk.accounts.connect({ services: ["gmail"] })`);
  const url = (link.out.result as { url?: string } | undefined)?.url;
  r.check(link.out.ok && typeof url === "string", `accounts.connect -> single-use link on ${url ? new URL(url).pathname : "(none)"}`);
  if (!url) return r.done();
  const landed = await connectFromLink(ctx.browser, ctx.fake, url, c);
  r.check(new URL(landed, ctx.base).pathname === "/accounts", `connect c through the link -> ${new URL(landed, ctx.base).pathname}`);

  const after = await list();
  r.check(
    JSON.stringify(after?.accounts.map((x) => x.email)) === JSON.stringify([a]) && after?.hiddenCount === (before?.hiddenCount ?? -1) + 1,
    `accounts.list after: c not listed, hiddenCount ${before?.hiddenCount} -> ${after?.hiddenCount}`,
  );
  const allowedAfter = await allowlist();
  r.check(JSON.stringify(allowedAfter) === JSON.stringify(allowedBefore) && allowedAfter.length === 1, `client_grants rows for the client unchanged: ${allowedBefore.length} -> ${allowedAfter.length}`);
  const onC = await s.execute(labelsOn(c));
  r.check(codeOf(onC.out) === "GWS_ACCOUNT_DENIED", `call on c (connected, not allowlisted) -> ${codeOf(onC.out)}`);

  const grant = await s.execute(`async () => sdk.accounts.grant({ account: ${JSON.stringify(c)} })`, true);
  const g = grant.out.result as { status?: string; code?: string; confirmUrl?: string } | undefined;
  r.check(g?.status === "confirmation_required" && g.code === "GWS_CONFIRMATION_REQUIRED" && typeof g.confirmUrl === "string", `accounts.grant(c) apply -> ${g?.status ?? codeOf(grant.out)} link on ${g?.confirmUrl ? new URL(g.confirmUrl).pathname : "-"}`);
  const stillDenied = await s.execute(labelsOn(c));
  r.check(codeOf(stillDenied.out) === "GWS_ACCOUNT_DENIED", `call on c before the human confirms -> ${codeOf(stillDenied.out)}`);
  if (!g?.confirmUrl) return r.done();
  const cId = (await ctx.accountIds())[c];
  if (!r.check(cId !== undefined, "account c is stored for the user") || cId === undefined) return r.done();
  const confirmed = await confirmGrant(ctx.browser, g.confirmUrl, cId);
  await confirmed.body?.cancel();
  r.check(confirmed.status === 303, `POST /connections/confirm-grant (session + Origin + CSRF) -> ${confirmed.status}`);
  const granted = await s.execute(labelsOn(c));
  r.check(codeOf(granted.out) === "none", `call on c after confirmation -> ${codeOf(granted.out) === "none" ? "ok" : codeOf(granted.out)}`);
  return r.done();
}
