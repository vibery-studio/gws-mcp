// Done 24: human approval. A public share is on the default GWS_HUMAN_APPROVAL list, so the AI app cannot apply it
// on its own: a dry run returns a one-time approval link, apply:true without an approval stops with
// GWS_APPROVAL_REQUIRED before any write, and only after the signed-in person approves on the link's page does
// apply:true run it, once. A replay needs a new approval, a used link is refused, and a declined link approves nothing.
import { apiWrites, logged } from "./done-05";
import { codeOf } from "../mcp";
import { formFields } from "../oauth-driver";
import type { CheckResult, E2eContext, Recorder } from "../run";

const APPROVE_PATH = "/plan/approve";

export default async function done24(ctx: E2eContext, r: Recorder): Promise<CheckResult> {
  const s = ctx.main.session;
  const email = ctx.emails.a;
  const created = await s.execute(`async () => sdk.drive.files.create({ requestBody: { name: "E2E-APPROVE-${ctx.runId}", mimeType: "text/plain" } })`, true);
  const fileId = (created.out.result as { id?: string } | undefined)?.id;
  if (!r.check(created.out.ok && typeof fileId === "string", `a plain create applies without approval -> ${created.out.ok ? fileId : codeOf(created.out)}`) || fileId === undefined) return r.done();
  const share = `async () => sdk.drive.permissions.create({ fileId: ${JSON.stringify(fileId)}, requestBody: { role: "reader", type: "anyone" } })`;
  const anyone = async () =>
    Object.entries((await ctx.fake.state(email)).resources).filter(
      ([k, v]) => k.startsWith(`drive:permission:${email}:${fileId}:`) && (v as { type?: string }).type === "anyone",
    ).length;

  /** A dry run of the share and the path of its approval link (its token held as a secret). */
  const dryRun = async () => {
    const dry = await s.execute(share);
    const url = typeof dry.out.approval?.url === "string" ? new URL(dry.out.approval.url) : undefined;
    if (url !== undefined) ctx.secrets.push(url.searchParams.get("t") ?? "");
    const onSite = url !== undefined && url.origin === new URL(ctx.base).origin && url.pathname === APPROVE_PATH;
    return { dry, path: onSite && url !== undefined ? `${url.pathname}${url.search}` : undefined };
  };

  const first = await dryRun();
  const step = first.dry.out.plan[0];
  r.check(
    first.dry.out.ok && step?.needsApproval === true && step.reason === "public-share" && first.path !== undefined,
    `dry-run: needsApproval=${step?.needsApproval ?? "-"} reason=${step?.reason ?? "-"}, approval link on gws-mcp ${APPROVE_PATH}: ${first.path !== undefined}`,
  );
  if (first.path === undefined) return r.done();

  const unapproved = await logged(ctx, email, () => s.execute(share, true));
  const unapprovedWrites = apiWrites(unapproved.added);
  const fresh = (unapproved.value.out.error?.details?.approval as { url?: unknown } | undefined)?.url;
  if (typeof fresh === "string") ctx.secrets.push(new URL(fresh).searchParams.get("t") ?? "");
  r.check(
    codeOf(unapproved.value.out) === "GWS_APPROVAL_REQUIRED" && typeof fresh === "string" && unapproved.intact && unapprovedWrites.length === 0,
    `apply:true before approval -> ${codeOf(unapproved.value.out)}, carries a fresh link: ${typeof fresh === "string"}, API writes = ${unapprovedWrites.length}`,
  );

  const page = await ctx.browser.fetch(first.path);
  const html = await page.text();
  r.check(
    page.status === 200 &&
      page.headers.get("cache-control") === "no-store" &&
      page.headers.get("referrer-policy") === "same-origin" &&
      html.includes("Approve what your AI app wants to do") &&
      html.includes(email) &&
      html.includes("Makes something visible to anyone"),
    `open the approval link -> ${page.status}, cache-control ${page.headers.get("cache-control")}, referrer-policy ${page.headers.get("referrer-policy")}`,
  );
  const fields = formFields(html, APPROVE_PATH);
  if (!r.check(fields !== undefined, "the approval page offers the approve form")) return r.done();
  const approved = await ctx.browser.postForm(APPROVE_PATH, [...(fields ?? []), ["decision", "approve"]]);
  await approved.body?.cancel();
  r.check(approved.status === 200, `approve -> ${approved.status}`);

  const applied = await logged(ctx, email, () => s.execute(share, true));
  const appliedWrites = apiWrites(applied.added);
  const shares = await anyone();
  r.check(
    applied.value.out.ok && applied.intact && appliedWrites.length === 1 && shares === 1,
    `apply:true after approval -> ok=${applied.value.out.ok}, API writes = ${appliedWrites.length}, anyone permissions = ${shares}`,
  );

  const replay = await logged(ctx, email, () => s.execute(share, true));
  r.check(
    codeOf(replay.value.out) === "GWS_APPROVAL_REQUIRED" && apiWrites(replay.added).length === 0,
    `the same apply again -> ${codeOf(replay.value.out)}, API writes = ${apiWrites(replay.added).length}`,
  );
  const reused = await ctx.browser.postForm(APPROVE_PATH, [...(fields ?? []), ["decision", "approve"]]);
  await reused.body?.cancel();
  r.check(reused.status === 400, `the used approval link again -> ${reused.status}`);

  const second = await dryRun();
  const secondFields = second.path === undefined ? undefined : formFields(await (await ctx.browser.fetch(second.path)).text(), APPROVE_PATH);
  if (!r.check(secondFields !== undefined, "a new dry run gives a new approval link")) return r.done();
  const declined = await ctx.browser.postForm(APPROVE_PATH, [...(secondFields ?? []), ["decision", "decline"]]);
  await declined.body?.cancel();
  const afterDecline = await logged(ctx, email, () => s.execute(share, true));
  r.check(
    declined.status === 200 && codeOf(afterDecline.value.out) === "GWS_APPROVAL_REQUIRED" && apiWrites(afterDecline.added).length === 0,
    `decline -> ${declined.status}; apply:true after it -> ${codeOf(afterDecline.value.out)}, API writes = ${apiWrites(afterDecline.added).length}`,
  );
  return r.done();
}
