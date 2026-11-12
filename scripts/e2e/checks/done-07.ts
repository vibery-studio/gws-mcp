// Done 7: snippets probing fetch, env, this.env, globalThis and the sdk internals get no token or secret;
// console output holding a token-shaped string is redacted. Also the sandbox abuse probes, end to end: a log
// that would be slow for a backtracking redaction pattern, an oversized planned body, a snippet that replaces
// setTimeout, and an applied write followed by abuse. Each ends with a structured error and the applied
// write keeps its audit row.
import { FAKE_CLIENT_SECRET } from "../../../src/config";
import { REDACTED } from "../../../src/core/redact";
import { d1Query, sqlLiteral } from "../d1-scan";
import { codeOf } from "../mcp";
import type { CheckResult, E2eContext, Recorder } from "../run";

/** Never in any execute output: token shapes (beyond the run's own secret values). */
const TOKEN_SHAPES = ["ya29.", "1//", "Bearer "];
const DEFAULT_TIMEOUT_MS = 45_000;

const PROBE = `async () => {
  const out = {};
  const attempt = async (key, fn) => { try { out[key] = await fn(); } catch (e) { out[key] = "threw: " + String(e && e.message || e).slice(0, 120); } };
  await attempt("fetch", async () => { const res = await fetch("https://example.com/"); return "status " + res.status + " " + (await res.text()).slice(0, 50); });
  await attempt("env", () => typeof env === "undefined" ? "undefined" : JSON.stringify(env));
  await attempt("thisEnv", () => JSON.stringify(this && this.env) ?? "undefined");
  await attempt("processEnv", () => typeof process === "undefined" ? "undefined" : JSON.stringify(process.env));
  await attempt("globals", () => Object.getOwnPropertyNames(globalThis).join(","));
  await attempt("globalValues", () => JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(globalThis).map((k) => { try { const v = globalThis[k]; return [k, typeof v === "string" ? v : typeof v]; } catch { return [k, "?"]; } }))));
  await attempt("sdk", () => String(sdk) + " | " + JSON.stringify(sdk) + " | " + Object.getOwnPropertyNames(sdk).join(",") + " | " + String(sdk.gmail.users));
  await attempt("sdkCtor", () => String(sdk.constructor) + " " + String(Object.getPrototypeOf(sdk)));
  await attempt("gws", () => typeof __gws === "undefined" ? "undefined" : Object.getOwnPropertyNames(__gws).join(",") + " " + String(__gws.call));
  await attempt("gwsCall", () => typeof __gwsCall === "undefined" ? "undefined" : String(__gwsCall));
  return out;
}`;

export default async function done07(ctx: E2eContext, r: Recorder): Promise<CheckResult> {
  const s = ctx.main.session;
  const secrets = [...ctx.secrets, FAKE_CLIENT_SECRET];
  const clean = (text: string) => !secrets.some((v) => v.length >= 8 && text.includes(v)) && !TOKEN_SHAPES.some((t) => text.includes(t));

  // The account has a cached access token and a stored refresh token for the probe to look for.
  await s.execute(`async () => sdk.gmail.users.labels.list({ userId: "me" })`);
  const probe = await s.execute(PROBE);
  const p = (probe.out.result ?? {}) as Record<string, string | undefined>;
  r.check(probe.out.ok, `isolation probe ran: ok=${probe.out.ok}`);
  r.check(typeof p.fetch === "string" && p.fetch.startsWith("threw"), `fetch -> ${p.fetch ?? "-"}`);
  r.check(p.env === "undefined" && (p.processEnv === "undefined" || p.processEnv === "{}"), `env -> ${p.env ?? "-"}; process env -> ${p.processEnv ?? "-"}`);
  const thisEnv = p.thisEnv ?? "-";
  r.check(thisEnv === "undefined" || thisEnv === "{}" || thisEnv.startsWith("threw"), `this-env -> ${thisEnv}`);
  r.note(`sdk -> ${(p.sdk ?? "-").slice(0, 120)}`);
  r.note(`__gws -> ${(p.gws ?? "-").slice(0, 120)}`);
  r.check(clean(probe.text), `probe output (${probe.text.length} chars) holds no run secret, access/refresh token or authorization-header shape`);
  // The server redacts execute output, which would hide a reached credential from `clean`. The probe emits
  // no credential itself (and the prelude holds no redaction marker), so any marker in its result, logs or
  // error means the sandbox reached something credential-shaped.
  r.check(!probe.text.includes(REDACTED), `probe output holds no ${REDACTED} marker: ${probe.text.split(REDACTED).length - 1} found`);

  const marker = `ya29.E2E${ctx.runId}${"A".repeat(40)}`;
  const red = await s.execute(`async () => { console.log("token " + ${JSON.stringify(marker)}); return ${JSON.stringify(marker)}; }`);
  const logLine = red.out.logs[0] ?? "";
  r.check(
    logLine.includes(REDACTED) && !red.text.includes(marker) && !red.text.includes("ya29."),
    `console.log of a ya29. token -> "${logLine}"; result -> ${JSON.stringify(red.out.result)}`,
  );

  // Abuse probes.
  const slow = await s.execute(`async () => { const s = "eyJ".repeat(100000); console.log(s); return s; }`);
  r.check(codeOf(slow.out) === "GWS_RESPONSE_TOO_LARGE" && slow.ms < 10_000, `300 KB repeated JWT prefix as log and result -> ${codeOf(slow.out)} in ${slow.ms} ms`);

  const planned = await s.execute(`async () => sdk.drive.files.create({ requestBody: { name: "E2E-BIG-${ctx.runId}", description: "D".repeat(1000000) } })`);
  const body = planned.out.plan[0]?.request?.body as { bytes?: number; truncated?: boolean } | undefined;
  r.check(
    planned.out.ok && body?.truncated === true && (body.bytes ?? 0) > 1_000_000,
    `dry-run with a 1 MB body -> plan body {bytes:${body?.bytes}, truncated:${body?.truncated}}`,
  );
  const oversized = await s.execute(`async () => sdk.drive.files.create({ requestBody: { name: "E2E-HUGE-${ctx.runId}", description: "D".repeat(6000000) } })`);
  const reason = (oversized.out.error?.details as { reason?: string } | undefined)?.reason;
  r.check(
    codeOf(oversized.out) === "GWS_INVALID_INPUT" && reason === "input-too-large" && oversized.out.plan.length === 0,
    `dry-run with a 6 MB input -> ${codeOf(oversized.out)} (${reason ?? "-"})`,
  );

  // A snippet that tries to outlast the host's deadline, then make a late call. Where the sandbox has timers
  // (the Worker's) it replaces setTimeout and waits past the deadline; where it has none (the QuickJS sandbox of the
  // Node host) it stalls by other means: a promise that never settles, and a loop that never yields.
  const hasTimers = (await s.execute(`async () => typeof setTimeout === "function"`)).out.result === true;
  const stalls: Array<[string, string]> = hasTimers
    ? [
        [
          "setTimeout replaced, then a late call",
          `async () => {
    const realTimeout = setTimeout;
    globalThis.setTimeout = () => 0;
    await new Promise((resolve) => realTimeout(resolve, ${DEFAULT_TIMEOUT_MS + 5000}));
    return sdk.gmail.users.labels.list({ userId: "me" });
  }`,
        ],
      ]
    : [
        ["a promise that never settles, then a late call", `async () => { await new Promise(() => {}); return sdk.gmail.users.labels.list({ userId: "me" }); }`],
        ["a loop that never yields", `async () => { while (true) {} }`],
      ];
  const timers = [];
  for (const [label, code] of stalls) {
    const timer = await s.execute(code);
    timers.push(timer);
    r.check(
      codeOf(timer.out) === "GWS_EXECUTION_TIMEOUT" && timer.out.calls.length === 0 && timer.ms < DEFAULT_TIMEOUT_MS + 5000,
      `${label} -> ${codeOf(timer.out)} after ${timer.ms} ms, calls=${timer.out.calls.length}`,
    );
  }

  const abuse = await s.execute(
    `async () => {
      await sdk.drive.files.create({ requestBody: { name: "E2E-ABUSE-${ctx.runId}" } });
      const s = "eyJ".repeat(100000);
      console.log(s);
      return s;
    }`,
    true,
  );
  r.check(codeOf(abuse.out) === "GWS_RESPONSE_TOO_LARGE" && abuse.ms < 10_000, `applied write, then a 300 KB flood -> ${codeOf(abuse.out)} in ${abuse.ms} ms`);
  const rows = await d1Query<{ fn: string; applied: number; status: string }>(
    ctx.d1,
    `SELECT fn, applied, status FROM audit_log WHERE execute_id = ${sqlLiteral(abuse.out.executeId)}`,
  );
  r.check(
    rows.length === 1 && rows[0]?.fn === "drive.files.create" && rows[0].applied === 1 && rows[0].status === "ok",
    `audit row of the applied write: ${JSON.stringify(rows)}`,
  );
  for (const out of [slow, planned, oversized, ...timers, abuse]) {
    if (!clean(out.text)) r.fail("an abuse probe output holds a secret or token shape");
  }
  return r.done();
}
