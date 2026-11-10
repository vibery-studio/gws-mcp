// Done 1: MCP tool discovery lists exactly `search` and `execute`; an unauthenticated call returns 401.
import { rawToolsList } from "../mcp";
import type { CheckResult, E2eContext, Recorder } from "../run";

export default async function done01(ctx: E2eContext, r: Recorder): Promise<CheckResult> {
  const names = await ctx.main.session.toolNames();
  r.check(JSON.stringify(names) === JSON.stringify(["execute", "search"]), `tools/list names=${JSON.stringify(names)}`);

  const anon = await rawToolsList(ctx.base);
  r.check(anon.status === 401, `POST /mcp without a token -> ${anon.status}`);
  const header = anon.wwwAuthenticate;
  const metadata = header === null ? undefined : /resource_metadata="([^"]*)"/.exec(header)?.[1];
  // Printed by parts: the evidence redaction treats "Bearer <word>" as a credential.
  r.check(
    header !== null && /^Bearer\s/i.test(header) && metadata !== undefined,
    `WWW-Authenticate present: scheme=${header?.split(" ")[0] === "Bearer" ? "B-earer" : "(other)"} resource_metadata=${metadata ?? "(absent)"}`,
  );
  return r.done();
}
