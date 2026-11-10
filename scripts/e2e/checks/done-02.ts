// Done 2: the consent page shows client name, capabilities and the account allowlist; an approved client can
// call tools; after the user removes it from its "Remove AI app" confirmation page, the same token is rejected.
import { CAPABILITIES_TEXT } from "../../../src/auth/consent-page";
import { McpSession, rawToolsList } from "../mcp";
import { approveConsent, openConsent, registerClient, submitPageForm } from "../oauth-driver";
import type { CheckResult, E2eContext, Recorder } from "../run";

export default async function done02(ctx: E2eContext, r: Recorder): Promise<CheckResult> {
  const name = `E2E consent client ${ctx.runId}`;
  const clientId = await registerClient(ctx.base, name);
  const { page, verifier } = await openConsent(ctx.browser, clientId);
  r.check(page.html.includes(name), "consent page shows the client name");
  r.check(page.html.includes(CAPABILITIES_TEXT), "consent page shows the capabilities text");
  const a = page.accounts.find((x) => x.label.startsWith(ctx.emails.a));
  r.check(a !== undefined, `consent page has an account checkbox for a (${page.accounts.length} accounts listed)`);
  r.check(page.accounts.every((x) => !x.checked), "no account is pre-checked");
  if (!a) return r.done();

  const approved = await approveConsent(ctx.browser, clientId, page, verifier, [a.id]);
  ctx.secrets.push(approved.accessToken);
  const before = await rawToolsList(ctx.base, approved.accessToken);
  r.check(before.status === 200, `approved token: tools/list -> ${before.status}`);
  const session = await McpSession.open(ctx.base, approved.accessToken);
  const names = await session.toolNames();
  await session.close();
  r.check(names.length === 2, `approved client lists ${names.length} tools`);

  const removePage = `/apps/${encodeURIComponent(clientId)}/remove`;
  const { fields, res: revoke } = await submitPageForm(ctx.browser, removePage, "/connections/client-revoke");
  await revoke.body?.cancel();
  const sent = Object.fromEntries(fields);
  r.check(sent.client === clientId && typeof sent.csrf === "string", `/apps/<id>/remove form posts this app and the session's CSRF token (${fields.map(([k]) => k).join(", ")})`);
  r.check(
    revoke.status === 303 && revoke.headers.get("location") === "/apps",
    `POST /connections/client-revoke from the remove page (session + Origin + CSRF) -> ${revoke.status} ${revoke.headers.get("location") ?? ""}`,
  );
  const after = await rawToolsList(ctx.base, approved.accessToken);
  r.check(after.status === 401, `same token after revoke: tools/list -> ${after.status}`);
  return r.done();
}
