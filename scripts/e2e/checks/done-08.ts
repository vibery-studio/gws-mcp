// Done 8: the rate limit, the calls-per-execute budget and the response cap each trigger their own structured
// error, with the default limits (CALLS_PER_EXECUTE=50, CALL_RESPONSE_MAX_BYTES=4000000,
// RATE_CLIENT_PER_MIN=120) and a fresh client. It must run last: it spends the user's minute of rate budget.
// No route exposes the limit config, so the defaults are asserted from each error's details.
import { setTimeout as sleep } from "node:timers/promises";
import { codeOf } from "../mcp";
import type { CheckResult, E2eContext, Recorder } from "../run";

const RATE_WINDOW_MS = 60_000;
/** The default limits this check relies on (src/config.ts). */
const CALLS_PER_EXECUTE = 50;
const CALL_RESPONSE_MAX_BYTES = 4_000_000;
const RATE_CLIENT_PER_MIN = 120;
const LABELS_PATH = "^/gmail\\.googleapis\\.com/gmail/v1/users/[^/]+/labels$";
const labelsLoop = (n: number) => `async () => { for (let i = 0; i < ${n}; i++) await sdk.gmail.users.labels.list({ userId: "me" }); return ${n}; }`;
/**
 * The same n calls issued at once: the host's per-execute upstream cap queues them, so the burst is bound by the
 * limiter, not by this machine's latency. It waits for every call to settle before rethrowing the first failure:
 * a bare Promise.all would end the snippet on the first rejection and the host would then fail the still-queued
 * calls with a later, unrelated error that replaces the rate-limit error in the execute's result.
 */
const labelsBurst = (n: number) =>
  `async () => {
    const calls = Array.from({ length: ${n} }, () => sdk.gmail.users.labels.list({ userId: "me" }));
    const settled = await Promise.allSettled(calls);
    const failed = settled.find((s) => s.status === "rejected");
    if (failed) throw failed.reason;
    return ${n};
  }`;

/** Sleeps to just past the next window boundary and returns that window's index. */
async function waitForFreshWindow(r: Recorder, why: string): Promise<number> {
  const wait = RATE_WINDOW_MS - (Date.now() % RATE_WINDOW_MS) + 500;
  r.note(`waited ${wait} ms for a fresh rate window (${why})`);
  await sleep(wait);
  return Math.floor(Date.now() / RATE_WINDOW_MS);
}

export default async function done08(ctx: E2eContext, r: Recorder): Promise<CheckResult> {
  const client = await ctx.newClient(`E2E limits client ${ctx.runId}`, [ctx.emails.a]);
  const s = client.session;
  try {
    // The limiter counts in fixed 60 s windows. Start the budget test at the beginning of one so earlier checks'
    // calls are not in it.
    await waitForFreshWindow(r, "budget test");

    const budget = await s.execute(labelsLoop(CALLS_PER_EXECUTE + 1));
    const budgetLimit = (budget.out.error?.details as { limit?: unknown } | undefined)?.limit;
    const budgetOk = budget.out.calls.filter((c) => c.status === "ok").length;
    r.check(
      codeOf(budget.out) === "GWS_CALL_BUDGET_EXCEEDED" && budgetLimit === CALLS_PER_EXECUTE && budgetOk === CALLS_PER_EXECUTE,
      `${CALLS_PER_EXECUTE + 1} calls in one execute -> ${codeOf(budget.out)} limit=${String(budgetLimit)} after ${budgetOk} ok calls (${budget.out.calls.length} recorded)`,
    );

    await ctx.fake.fault({
      email: ctx.emails.a,
      method: "GET",
      pathRegex: LABELS_PATH,
      times: 1,
      // The fake generates the ~5 MB body itself, so the request stays tiny whatever this machine's uplink is.
      response: { status: 200, body: { labels: [] }, padBytes: 5_000_000 },
    });
    const big = await s.execute(labelsLoop(1));
    const bigDetails = (big.out.error?.details ?? {}) as { scope?: unknown; max?: unknown };
    r.check(
      codeOf(big.out) === "GWS_RESPONSE_TOO_LARGE" && bigDetails.scope === "call" && bigDetails.max === CALL_RESPONSE_MAX_BYTES,
      `one ~5 MB upstream response (fault) -> ${codeOf(big.out)} ${JSON.stringify(bigDetails)}`,
    );

    // The budget and response calls (52 at most) may sit in an earlier window. Re-sync to a fresh one right
    // before the rate calls: 45 stay under 120, another 45 pass it.
    const window = await waitForFreshWindow(r, "rate test");
    const rateCodes: string[] = [];
    let rateDetails: { scope?: unknown; limit?: unknown } | undefined;
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      const out = (await s.execute(labelsBurst(45))).out;
      rateCodes.push(codeOf(out));
      if (codeOf(out) === "GWS_RATE_LIMITED") rateDetails ??= out.error?.details as typeof rateDetails;
      r.note(`execute ${i + 1} of 45 calls -> ${codeOf(out)} (${out.calls.filter((c) => c.status === "ok").length} ok calls, ${Date.now() - started} ms)`);
    }
    r.check(rateCodes[0] === "none", `first 45-call execute stays under the limit -> ${rateCodes[0] ?? "-"}`);
    const limited = rateCodes.includes("GWS_RATE_LIMITED");
    r.check(
      limited && rateDetails?.scope === "client" && rateDetails.limit === RATE_CLIENT_PER_MIN,
      `3 x 45 calls (limit ${RATE_CLIENT_PER_MIN} per client per minute) -> ${limited ? "GWS_RATE_LIMITED" : "not limited"} ${JSON.stringify(rateDetails ?? {})}`,
    );
    const sameWindow = Math.floor(Date.now() / RATE_WINDOW_MS) === window;
    r.check(sameWindow, `all calls in one rate window: ${sameWindow}`);

    const codes = new Set([codeOf(budget.out), codeOf(big.out), limited ? "GWS_RATE_LIMITED" : "none"]);
    r.check(codes.size === 3 && !codes.has("none"), `distinct codes: ${[...codes].join(", ")}`);
  } finally {
    await s.close();
  }
  return r.done();
}
