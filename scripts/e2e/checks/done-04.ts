// Done 4: a read snippet returns zod-validated data; unknown method, bad input, bad response shape and missing
// scope each return a distinct structured error code.
import { codeOf } from "../mcp";
import type { CheckResult, E2eContext, Recorder } from "../run";

const LABELS_PATH = "^/gmail\\.googleapis\\.com/gmail/v1/users/[^/]+/labels$";

export default async function done04(ctx: E2eContext, r: Recorder): Promise<CheckResult> {
  const s = ctx.main.session;
  const read = await s.execute(`async () => {
    const res = await sdk.gmail.users.labels.list({ userId: "me" });
    return { count: res.labels.length, names: res.labels.map((l) => l.name) };
  }`);
  const value = read.out.result as { count?: number; names?: string[] } | undefined;
  r.check(read.out.ok && typeof value?.count === "number" && value.count > 0, `read gmail.users.labels.list -> ok=${read.out.ok} labels=${value?.count ?? "-"} (${value?.names?.slice(0, 3).join(",") ?? ""})`);

  const unknown = await s.execute(`async () => sdk.gmail.users.nope.list({ userId: "me" })`);
  const badInput = await s.execute(`async () => sdk.gmail.users.messages.get({ userId: "me" })`);
  await ctx.fake.fault({
    email: ctx.emails.a,
    method: "GET",
    pathRegex: LABELS_PATH,
    times: 1,
    response: { status: 200, body: { labels: "not-an-array" } },
  });
  const badShape = await s.execute(`async () => sdk.gmail.users.labels.list({ userId: "me" })`);
  const noScope = await s.execute(`async () => sdk.drive.drives.list({})`);

  const cases: ReadonlyArray<[string, string, string]> = [
    ["unknown method", codeOf(unknown.out), "GWS_UNKNOWN_METHOD"],
    ["bad input (messages.get without id)", codeOf(badInput.out), "GWS_INVALID_INPUT"],
    ["bad response shape (fault: labels not an array)", codeOf(badShape.out), "GWS_RESPONSE_SHAPE"],
    ["missing scope (drive.drives.list under narrow scopes)", codeOf(noScope.out), "GWS_SCOPE_MISSING"],
  ];
  for (const [what, got, want] of cases) r.check(got === want, `${what} -> ${got}`);
  const codes = new Set(cases.map(([, got]) => got));
  r.check(codes.size === 4, `distinct codes: ${codes.size}/4`);
  return r.done();
}
