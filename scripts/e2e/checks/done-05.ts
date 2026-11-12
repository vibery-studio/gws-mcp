// Done 5: a write without apply returns its request plan and changes nothing at the (fake) API; with apply the
// change is observable. A public share is flagged destructive; a write that uses an unexecuted write's result
// is marked incomplete in the plan. A public share also needs the person's approval (GWS_HUMAN_APPROVAL), so the
// combined snippet stops before any write under apply; the create alone applies (Done 24 covers the approval).
//
// "Changes nothing" is shown two ways, neither depending on a clock: the fake's state after the dry-run has no
// file of that name and no new permission, and the account's request log grew by no API write during the step.
import { codeOf } from "../mcp";
import type { CheckResult, E2eContext, Recorder } from "../run";

/** Hosts of OAuth traffic (token refresh is not an API write). */
const OAUTH_PATH = /^\/(oauth2\.googleapis\.com|accounts\.google\.com|openidconnect\.googleapis\.com)\//;

export type LogEntry = { method: string; path: string };

/**
 * Runs one step and returns the entries it added to the account's request log, counted from the log
 * immediately before and after the step. The log is sorted by key and bounded (the oldest go first), so the
 * entries from before must still be its exact prefix: otherwise an eviction or reordering happened and
 * the count would not be trustworthy, and the step fails.
 */
export async function logged<T>(ctx: E2eContext, email: string, step: () => Promise<T>): Promise<{ value: T; added: LogEntry[]; intact: boolean; counts: string }> {
  const before = await ctx.fake.requests(email);
  const value = await step();
  const after = await ctx.fake.requests(email);
  const intact = after.length >= before.length && before.every((q, i) => JSON.stringify(q) === JSON.stringify(after[i]));
  return { value, added: after.slice(before.length), intact, counts: `${before.length} -> ${after.length}` };
}

/** The API writes among request-log entries (OAuth traffic excluded). */
export const apiWrites = (entries: readonly LogEntry[]) => entries.filter((q) => q.method !== "GET" && !OAUTH_PATH.test(q.path));

export default async function done05(ctx: E2eContext, r: Recorder): Promise<CheckResult> {
  const s = ctx.main.session;
  const email = ctx.emails.a;
  const name = `E2E-DOC-${ctx.runId}`;
  const code = `async () => {
    const f = await sdk.drive.files.create({ requestBody: { name: ${JSON.stringify(name)}, mimeType: "text/plain" } });
    const p = await sdk.drive.permissions.create({ fileId: f.id, requestBody: { role: "reader", type: "anyone" } });
    return { fileId: f.id, permissionId: p.id };
  }`;

  const resources = async () => (await ctx.fake.state(email)).resources;
  const namedFiles = (res: Record<string, unknown>) =>
    Object.entries(res).filter(([k, v]) => k.startsWith(`drive:file:${email}:`) && (v as { name?: unknown }).name === name);
  const permissionKeys = (res: Record<string, unknown>) => Object.keys(res).filter((k) => k.startsWith(`drive:permission:${email}:`));

  const permsBefore = new Set(permissionKeys(await resources()));
  const dryStep = await logged(ctx, email, () => s.execute(code));
  const dry = dryStep.value;
  const [create, share] = dry.out.plan;
  r.check(dry.out.ok && !dry.out.applied && dry.out.plan.length === 2, `dry-run ok=${dry.out.ok} applied=${dry.out.applied} plan steps=${dry.out.plan.length}`);
  r.check(create?.fn === "drive.files.create" && create.effect === "write" && create.request?.method === "POST", `step ${create?.step}: ${create?.fn} ${create?.request?.method ?? "-"} ${create?.request?.url ?? ""}`);
  r.check(
    share?.fn === "drive.permissions.create" && share.destructive && share.incomplete === true && create !== undefined && (share.dependsOn ?? []).includes(create.step),
    `step ${share?.step}: ${share?.fn} destructive=${share?.destructive} incomplete=${share?.incomplete} dependsOn=${JSON.stringify(share?.dependsOn)}`,
  );
  r.check(dry.out.destructive, `execute flagged destructive=${dry.out.destructive}`);
  const afterDry = await resources();
  const newPerms = permissionKeys(afterDry).filter((k) => !permsBefore.has(k));
  r.check(
    namedFiles(afterDry).length === 0 && newPerms.length === 0,
    `/__fake/state after dry-run: files named ${name} = ${namedFiles(afterDry).length}, new permissions = ${newPerms.length}`,
  );
  const dryWrites = apiWrites(dryStep.added);
  r.check(dryStep.intact && dryWrites.length === 0, `fake request log of a: ${dryStep.counts} entries (prefix intact=${dryStep.intact}), API writes during dry-run = ${dryWrites.length}`);

  // The public share needs the person's approval (GWS_HUMAN_APPROVAL default), and it uses the create's result, so the
  // plan cannot be approved as it is: apply:true stops before every write, the create included (Done 24 approves a share).
  r.check(share?.needsApproval === true && create?.needsApproval === undefined, `needsApproval: create=${create?.needsApproval ?? "-"} share=${share?.needsApproval ?? "-"}`);
  const refusedStep = await logged(ctx, email, () => s.execute(code, true));
  const refusedWrites = apiWrites(refusedStep.added);
  r.check(
    codeOf(refusedStep.value.out) === "GWS_APPROVAL_REQUIRED" && refusedStep.intact && refusedWrites.length === 0 && namedFiles(await resources()).length === 0,
    `apply:true of create + public share -> ${codeOf(refusedStep.value.out)}, API writes = ${refusedWrites.length}, files named ${name} = ${namedFiles(await resources()).length}`,
  );

  const createOnly = `async () => sdk.drive.files.create({ requestBody: { name: ${JSON.stringify(name)}, mimeType: "text/plain" } })`;
  const applyStep = await logged(ctx, email, () => s.execute(createOnly, true));
  const applied = applyStep.value;
  const fileId = (applied.out.result as { id?: string } | undefined)?.id;
  r.check(applied.out.ok && applied.out.applied && typeof fileId === "string", `apply:true of the create -> ok=${applied.out.ok} applied=${applied.out.applied} fileId=${fileId ?? "-"}`);
  const writes = apiWrites(applyStep.added);
  r.check(
    applyStep.intact && writes.length === 1,
    `fake request log of a: ${applyStep.counts} entries (prefix intact=${applyStep.intact}), API writes during apply = ${writes.length} (${writes.map((w) => `${w.method} ${w.path}`).join("; ")})`,
  );
  const state = await resources();
  const file = state[`drive:file:${email}:${fileId ?? "?"}`] as { name?: string } | undefined;
  r.check(file?.name === name, `/__fake/state has the created file: name=${file?.name ?? "(missing)"}`);
  return r.done();
}
