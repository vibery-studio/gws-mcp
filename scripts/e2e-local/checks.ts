// The local E2E checks: Done 3, 4, 5, 7, 8, 9 and 10 equivalents through `gws-mcp serve` over stdio, plus the local
// items of Done 18 (CLI accounts lifecycle, key file flagged weaker, loopback OAuth). Remote-only items are skipped
// and listed by run.ts.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import { REDACTED } from "../../src/core/redact";
import { decrypt, importKey, tokenAad } from "../../src/store/crypto";
import { ROOT, runCommand } from "./cli";
import type { Ctx, Recorder } from "./run";

export type ExecuteOut = {
  ok: boolean;
  executeId: string;
  applied: boolean;
  destructive: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  logs: string[];
  calls: Array<{ fn: string; status: string; code?: string; account?: string }>;
  plan: Array<{ step: string; fn: string; effect: string; destructive: boolean; incomplete?: boolean; dependsOn?: string[]; request?: { method?: string; body?: unknown } }>;
};

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ value: unknown; text: string; isError: boolean }> {
  const res = await client.callTool({ name, arguments: args });
  const content = Array.isArray(res.content) ? res.content : [];
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (content.length !== 1 || first?.type !== "text" || typeof first.text !== "string") throw new Error(`${name}: expected one text content`);
  return { value: JSON.parse(first.text) as unknown, text: first.text, isError: res.isError === true };
}

export async function execute(client: Client, code: string, apply = false): Promise<{ out: ExecuteOut; text: string; ms: number }> {
  const started = Date.now();
  const { value, text } = await callTool(client, "execute", { code, apply });
  return { out: value as ExecuteOut, text, ms: Date.now() - started };
}

const codeOf = (out: ExecuteOut) => out.error?.code ?? "none";

// ---- Done 1 (local): exactly two tools -------------------------------------------------------------------

export async function tools(ctx: Ctx, r: Recorder): Promise<void> {
  const { tools: list } = await ctx.main.listTools();
  const names = list.map((t) => t.name).sort();
  r.check(JSON.stringify(names) === '["execute","search"]', `tools/list over stdio -> ${JSON.stringify(names)}`);
}

// ---- Done 3: search -----------------------------------------------------------------------------------------

const PER_SERVICE: ReadonlyArray<[string, string]> = [
  ["gmail messages list", "gmail.users.messages.list"],
  ["drive files list", "drive.files.list"],
  ["calendar events list", "calendar.events.list"],
  ["sheets values get", "sheets.spreadsheets.values.get"],
  ["docs documents get", "docs.documents.get"],
  ["forms responses list", "forms.forms.responses.list"],
  ["tasks insert", "tasks.tasks.insert"],
  ["slides batchUpdate replace text", "slides.presentations.batchUpdate"],
];

export async function done03(ctx: Ctx, r: Recorder): Promise<void> {
  const search = async (query: string) => {
    const { value, text, isError } = await callTool(ctx.main, "search", { query });
    return { results: Array.isArray(value) ? (value as Array<{ name: string; signature: string; effect: string; example: string }>) : [], bytes: Buffer.byteLength(text), isError };
  };
  const first = await search("gmail messages list");
  const top = first.results[0];
  r.check(
    top !== undefined && top.signature.length > 0 && (top.effect === "read" || top.effect === "write") && top.example.length > 0,
    `search("gmail messages list") top=${top?.name ?? "none"} effect=${top?.effect ?? "-"}`,
  );
  for (const [query, expected] of PER_SERVICE) {
    const { results, bytes, isError } = await search(query);
    const rank = results.findIndex((x) => x.name === expected) + 1;
    r.check(!isError && rank >= 1 && rank <= 3 && results.length <= 10 && bytes <= 8000, `search("${query}") -> ${expected} at rank ${rank || "none"}, ${results.length} results, ${bytes} bytes`);
  }
}

// ---- Done 4: read and four distinct errors ------------------------------------------------------------------

export async function done04(ctx: Ctx, r: Recorder): Promise<void> {
  const read = await execute(ctx.main, `async () => { const res = await sdk.gmail.users.labels.list({ userId: "me" }); return res.labels.length; }`);
  r.check(read.out.ok && typeof read.out.result === "number" && read.out.result > 0, `read gmail.users.labels.list -> ok=${read.out.ok} labels=${String(read.out.result)}`);
  const unknown = await execute(ctx.main, `async () => sdk.gmail.users.nope.list({ userId: "me" })`);
  const badInput = await execute(ctx.main, `async () => sdk.gmail.users.messages.get({ userId: "me" })`);
  await ctx.fake.fault({
    email: ctx.emails.a,
    method: "GET",
    pathRegex: "^/gmail\\.googleapis\\.com/gmail/v1/users/[^/]+/labels$",
    times: 1,
    response: { status: 200, body: { labels: "not-an-array" } },
  });
  const badShape = await execute(ctx.main, `async () => sdk.gmail.users.labels.list({ userId: "me" })`);
  const noScope = await execute(ctx.main, `async () => sdk.drive.drives.list({})`);
  const cases: ReadonlyArray<[string, string, string]> = [
    ["unknown method", codeOf(unknown.out), "GWS_UNKNOWN_METHOD"],
    ["bad input", codeOf(badInput.out), "GWS_INVALID_INPUT"],
    ["bad response shape (fault)", codeOf(badShape.out), "GWS_RESPONSE_SHAPE"],
    ["missing scope (drive.drives.list, narrow)", codeOf(noScope.out), "GWS_SCOPE_MISSING"],
  ];
  for (const [what, got, want] of cases) r.check(got === want, `${what} -> ${got}`);
  r.check(new Set(cases.map(([, got]) => got)).size === 4, "four distinct codes");
}

// ---- Done 5: dry-run plan, apply observable -----------------------------------------------------------------

export async function done05(ctx: Ctx, r: Recorder): Promise<void> {
  const email = ctx.emails.a;
  const name = `E2E-LOCAL-DOC-${ctx.runId}`;
  const code = `async () => {
    const f = await sdk.drive.files.create({ requestBody: { name: ${JSON.stringify(name)}, mimeType: "text/plain" } });
    const p = await sdk.drive.permissions.create({ fileId: f.id, requestBody: { role: "reader", type: "anyone" } });
    return { fileId: f.id, permissionId: p.id };
  }`;
  const files = async () => Object.entries((await ctx.fake.state(email)).resources).filter(([k, v]) => k.startsWith(`drive:file:${email}:`) && (v as { name?: string }).name === name);
  const writes = (entries: Array<{ method: string; path: string }>) => entries.filter((q) => q.method !== "GET" && !/^\/(oauth2|accounts|openidconnect)\./.test(q.path));

  const logBefore = (await ctx.fake.requests(email)).length;
  const dry = await execute(ctx.main, code);
  const [create, share] = dry.out.plan;
  r.check(dry.out.ok && !dry.out.applied && dry.out.plan.length === 2 && dry.out.destructive, `dry-run ok=${dry.out.ok} applied=${dry.out.applied} steps=${dry.out.plan.length} destructive=${dry.out.destructive}`);
  r.check(create?.fn === "drive.files.create" && create.request?.method === "POST", `step 1: ${create?.fn} ${create?.request?.method ?? "-"}`);
  r.check(
    share?.fn === "drive.permissions.create" && share.destructive && share.incomplete === true && (share.dependsOn ?? []).includes(create?.step ?? "?"),
    `step 2: ${share?.fn} destructive=${share?.destructive} incomplete=${share?.incomplete} dependsOn=${JSON.stringify(share?.dependsOn)}`,
  );
  const dryLog = (await ctx.fake.requests(email)).slice(logBefore);
  r.check((await files()).length === 0 && writes(dryLog).length === 0, `after the dry-run: files named ${name}=${(await files()).length}, API writes=${writes(dryLog).length}`);

  const applyBefore = (await ctx.fake.requests(email)).length;
  const applied = await execute(ctx.main, code, true);
  const out = applied.out.result as { fileId?: string } | undefined;
  const applyLog = (await ctx.fake.requests(email)).slice(applyBefore);
  r.check(applied.out.ok && applied.out.applied && typeof out?.fileId === "string" && writes(applyLog).length === 2, `apply:true ok=${applied.out.ok} fileId=${out?.fileId ?? "-"} API writes=${writes(applyLog).length}`);
  const state = (await ctx.fake.state(email)).resources;
  const anyone = Object.entries(state).some(([k, v]) => k.startsWith(`drive:permission:${email}:${out?.fileId ?? "?"}:`) && (v as { type?: string }).type === "anyone");
  r.check((await files()).length === 1 && anyone, `the fake holds the file and its public share: ${anyone}`);
}

// ---- Done 7: isolation, redaction, abuse ---------------------------------------------------------------------

const PROBE = `async () => {
  const out = {};
  const attempt = async (key, fn) => { try { out[key] = await fn(); } catch (e) { out[key] = "threw: " + String(e && e.message || e).slice(0, 120); } };
  await attempt("fetch", async () => { const res = await fetch("https://example.com/"); return "status " + res.status; });
  await attempt("env", () => typeof env === "undefined" ? "undefined" : JSON.stringify(env));
  await attempt("processEnv", () => typeof process === "undefined" ? "undefined" : JSON.stringify(process.env));
  await attempt("require", () => typeof require === "undefined" ? "undefined" : "defined");
  await attempt("timers", () => typeof setTimeout + "," + typeof setInterval);
  await attempt("globals", () => Object.getOwnPropertyNames(globalThis).join(","));
  await attempt("sdk", () => String(sdk) + " | " + JSON.stringify(sdk) + " | " + Object.getOwnPropertyNames(sdk).join(","));
  await attempt("gws", () => typeof __gws === "undefined" ? "undefined" : Object.getOwnPropertyNames(__gws).join(",") + " " + String(__gws.call));
  await attempt("dynamicImport", async () => { await import("node:fs"); return "imported"; });
  return out;
}`;

export async function done07(ctx: Ctx, r: Recorder): Promise<void> {
  const clean = (text: string) => !ctx.secrets.some((v) => v.length >= 8 && text.includes(v)) && !["ya29.", "1//", "Bearer "].some((t) => text.includes(t));
  await execute(ctx.main, `async () => sdk.gmail.users.labels.list({ userId: "me" })`);
  const probe = await execute(ctx.main, PROBE);
  const p = (probe.out.result ?? {}) as Record<string, string | undefined>;
  r.check(probe.out.ok, `isolation probe ran: ok=${probe.out.ok}`);
  r.check((p.fetch ?? "").startsWith("threw"), `fetch -> ${p.fetch ?? "-"}`);
  r.check(p.env === "undefined" && p.processEnv === "undefined" && p.require === "undefined", `env -> ${p.env}; process -> ${p.processEnv}; require -> ${p.require}`);
  r.check(p.timers === "undefined,undefined", `timers -> ${p.timers ?? "-"}`);
  r.check((p.dynamicImport ?? "").startsWith("threw"), `import() -> ${p.dynamicImport ?? "-"}`);
  r.note(`globals -> ${(p.globals ?? "-").slice(0, 160)}`);
  r.check(clean(probe.text) && !probe.text.includes(REDACTED), `probe output holds no secret, token shape or ${REDACTED} marker`);

  const marker = `ya29.E2ELOCAL${ctx.runId}${"A".repeat(40)}`;
  const red = await execute(ctx.main, `async () => { console.log("token " + ${JSON.stringify(marker)}); return 1; }`);
  r.check((red.out.logs[0] ?? "").includes(REDACTED) && !red.text.includes(marker), `console.log of a ya29. token -> "${red.out.logs[0] ?? ""}"`);

  const slow = await execute(ctx.main, `async () => { const s = "eyJ".repeat(100000); console.log(s); return s; }`);
  r.check(codeOf(slow.out) === "GWS_RESPONSE_TOO_LARGE" && slow.ms < 10_000, `300 KB repeated JWT prefix -> ${codeOf(slow.out)} in ${slow.ms} ms`);
  const planned = await execute(ctx.main, `async () => sdk.drive.files.create({ requestBody: { name: "E2E-BIG", description: "D".repeat(1000000) } })`);
  const body = planned.out.plan[0]?.request?.body as { bytes?: number; truncated?: boolean } | undefined;
  r.check(planned.out.ok && body?.truncated === true, `dry-run with a 1 MB body -> plan body ${JSON.stringify(body)}`);
  // CALL_INPUT_MAX_BYTES comes from the settings file (2,000,000 in this run): the sandbox bridge refuses past it.
  const oversized = await execute(ctx.main, `async () => sdk.drive.files.create({ requestBody: { name: "E2E-HUGE", description: "D".repeat(3000000) } })`);
  const d = oversized.out.error?.details as { reason?: string; max?: number } | undefined;
  r.check(
    codeOf(oversized.out) === "GWS_INVALID_INPUT" && d?.reason === "input-too-large" && d.max === ctx.callInputMaxBytes,
    `3 MB input -> ${codeOf(oversized.out)} ${JSON.stringify(d)} (the configured CALL_INPUT_MAX_BYTES reaches the bridge)`,
  );
  const hang = await execute(ctx.main, `async () => { await new Promise(() => {}); }`);
  r.check(codeOf(hang.out) === "GWS_EXECUTION_TIMEOUT" && hang.ms < ctx.executeTimeoutMs + 5000, `a promise that never settles -> ${codeOf(hang.out)} after ${hang.ms} ms`);
  const busy = await execute(ctx.main, `async () => { for (;;) {} }`);
  r.check(codeOf(busy.out) === "GWS_EXECUTION_TIMEOUT" && busy.ms < ctx.executeTimeoutMs + 5000, `a busy loop -> ${codeOf(busy.out)} after ${busy.ms} ms`);
  for (const o of [slow, planned, oversized, hang, busy]) if (!clean(o.text)) r.fail("an abuse probe output holds a secret or token shape");
}

// ---- Done 8: budget, response cap, rate limit ---------------------------------------------------------------

export async function done08(ctx: Ctx, r: Recorder): Promise<void> {
  const loop = (n: number) => `async () => { for (let i = 0; i < ${n}; i++) await sdk.gmail.users.labels.list({ userId: "me" }); return ${n}; }`;
  const budget = await execute(ctx.main, loop(51));
  const ok = budget.out.calls.filter((c) => c.status === "ok").length;
  r.check(codeOf(budget.out) === "GWS_CALL_BUDGET_EXCEEDED" && budget.out.error?.details?.limit === 50 && ok === 50, `51 calls -> ${codeOf(budget.out)} limit=${String(budget.out.error?.details?.limit)} after ${ok} ok`);

  await ctx.fake.fault({
    email: ctx.emails.a,
    method: "GET",
    pathRegex: "^/gmail\\.googleapis\\.com/gmail/v1/users/[^/]+/labels$",
    times: 1,
    response: { status: 200, body: { labels: [] }, padBytes: 5_000_000 },
  });
  const big = await execute(ctx.main, loop(1));
  r.check(
    codeOf(big.out) === "GWS_RESPONSE_TOO_LARGE" && big.out.error?.details?.scope === "call" && big.out.error.details.max === 4_000_000,
    `~5 MB upstream response -> ${codeOf(big.out)} ${JSON.stringify(big.out.error?.details ?? {})}`,
  );

  // A config folder with its own database, so its rate counters hold only these calls. 3 x 45 calls (and 3 executes)
  // pass the client limit of 120 within one 60 s window; a bare Promise.all is used on purpose: the execute must
  // report the rate limit the snippet threw, not the error that ending the execute gives the calls still queued.
  const msIntoWindow = Date.now() % 60_000;
  if (msIntoWindow > 40_000) {
    r.note(`waited ${60_500 - msIntoWindow} ms for a fresh rate window`);
    await sleep(60_500 - msIntoWindow);
  }
  const window = Math.floor(Date.now() / 60_000);
  const burst = `async () => { await Promise.all(Array.from({ length: 45 }, () => sdk.gmail.users.labels.list({ userId: "me" }))); return 45; }`;
  const codes: string[] = [];
  let details: Record<string, unknown> | undefined;
  let released = 0;
  // Slow upstream answers keep calls queued for a slot when the limit hits, so ending the execute releases them.
  ctx.setApiDelay(150);
  try {
    for (let i = 0; i < 3; i++) {
      const out = (await execute(ctx.rate, burst)).out;
      codes.push(codeOf(out));
      const ended = out.calls.filter((c) => c.code === "GWS_EXECUTION_ERROR").length;
      if (codeOf(out) === "GWS_RATE_LIMITED") {
        details ??= out.error?.details;
        released += ended;
      }
      r.note(`execute ${i + 1}: 45 concurrent calls -> ${codeOf(out)} (${out.calls.filter((c) => c.status === "ok").length} ok, ${ended} released when the execute ended)`);
    }
  } finally {
    ctx.setApiDelay(0);
  }
  r.check(codes[0] === "none", `first 45-call execute stays under the limit -> ${codes[0] ?? "-"}`);
  r.check(codes.includes("GWS_RATE_LIMITED") && details?.scope === "client" && details.limit === 120, `rate limit -> ${JSON.stringify(details ?? {})}`);
  r.check(
    released > 0 && !codes.includes("GWS_EXECUTION_ERROR"),
    `the limited execute ended with calls still queued (${released} released) and still reports the rate limit: ${codes.join(", ")}`,
  );
  r.check(Math.floor(Date.now() / 60_000) === window, "all rate calls in one window");
  r.check(new Set([codeOf(budget.out), codeOf(big.out), "GWS_RATE_LIMITED"]).size === 3, "three distinct codes");
}

// ---- Done 9: audit rows, nothing sensitive at rest --------------------------------------------------------------

export async function done09(ctx: Ctx, r: Recorder): Promise<void> {
  const bodyMarker = `E2E-LOCAL-BODY-${ctx.runId}`;
  const fileMarker = `E2E-LOCAL-FILE-${ctx.runId}`;
  const mime = [`To: ${ctx.emails.b}`, `Subject: e2e ${ctx.runId}`, "Content-Type: text/plain; charset=utf-8", "", `${bodyMarker} body`].join("\r\n");
  const raw = Buffer.from(mime, "utf8").toString("base64url");
  const run = await execute(
    ctx.main,
    `async () => {
      const labels = await sdk.gmail.users.labels.list({ userId: "me" });
      const sent = await sdk.gmail.users.messages.send({ userId: "me", requestBody: { raw: ${JSON.stringify(raw)} } });
      const file = await sdk.drive.files.create({ requestBody: { name: "e2e-${ctx.runId}.txt" }, media: { mimeType: "text/plain", text: ${JSON.stringify(fileMarker)} } });
      return { labels: labels.labels.length, sent: sent.id, file: file.id };
    }`,
    true,
  );
  r.check(run.out.ok && run.out.calls.length === 3, `applied execute: ${run.out.calls.map((c) => `${c.fn}:${c.status}`).join(",")}`);
  const upstream = JSON.stringify((await ctx.fake.state(ctx.emails.a)).resources);
  r.check(upstream.includes(raw) || upstream.includes(bodyMarker), "the fake holds the sent message body");

  const dbFile = path.join(ctx.configDir, "gws-mcp.db");
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE execute_id = ?").get(run.out.executeId) as { n: number };
    r.check(rows.n === 3, `audit_log rows for the execute = ${rows.n} (calls = 3)`);
    const stored = db.prepare("SELECT id, user_id, refresh_ct, refresh_iv, key_version FROM accounts WHERE refresh_ct IS NOT NULL").all() as Array<{
      id: string;
      user_id: string;
      refresh_ct: string;
      refresh_iv: string;
      key_version: number;
    }>;
    const keyFile = JSON.parse(readFileSync(path.join(ctx.configDir, "key"), "utf8")) as { TOKEN_ENC_KEY: string };
    const key = await importKey({ TOKEN_ENC_KEY: keyFile.TOKEN_ENC_KEY });
    let opened = 0;
    for (const row of stored) {
      const plain = await decrypt(key, { ct: row.refresh_ct, iv: row.refresh_iv }, tokenAad("refresh", { userId: row.user_id, accountId: row.id, keyVersion: row.key_version }));
      if (plain.startsWith("1//")) opened++;
    }
    r.check(stored.length >= 1 && opened === stored.length, `refresh tokens at rest: ${stored.length} AES-GCM ciphertexts, each opens only with the key (${opened}/${stored.length})`);
  } finally {
    db.close();
  }
  // Raw bytes of the database and its sidecars, so nothing hides in free pages, the WAL or a table the scan forgot.
  const files = readdirSync(ctx.configDir).filter((f) => f.startsWith("gws-mcp.db"));
  // Token shapes with the fake's own prefixes: a bare "1//" can occur by chance inside base64 ciphertext.
  const needles = [bodyMarker, raw, fileMarker, Buffer.from(fileMarker).toString("base64"), "ya29.fake-", "1//fake-", "Bearer ", ...ctx.secrets];
  const hits: string[] = [];
  for (const f of files) {
    const bytes = readFileSync(path.join(ctx.configDir, f));
    for (const n of needles) if (n.length >= 4 && bytes.includes(Buffer.from(n))) hits.push(`${f}: ${n === raw ? "raw message" : n.slice(0, 12)}`);
  }
  r.check(hits.length === 0, `raw scan of ${files.join(", ")} for ${needles.length} markers, token shapes and run secrets: ${hits.length === 0 ? "clean" : hits.join("; ")}`);
}

// ---- Done 10: the SDK is the generated one ------------------------------------------------------------------

export async function done10(ctx: Ctx, r: Recorder): Promise<void> {
  let stdout = "";
  let exitCode = 0;
  try {
    ({ stdout } = await promisify(execFile)("npx", ["tsx", "scripts/gen-sdk.ts", "--check"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }));
  } catch (e) {
    exitCode = 1;
    stdout = String((e as { stdout?: unknown }).stdout ?? "");
  }
  const hash = /sdk: byte-identical (sha256:[0-9a-f]{64})/.exec(stdout)?.[1];
  r.check(exitCode === 0 && hash !== undefined, `gen:check -> exit ${exitCode}, byte-identical ${hash ?? "(no hash)"}`);
  const version = await runCommand(ctx.configDir, ["--version"]);
  r.check(hash !== undefined && version.out.trim().endsWith(`(sdk ${hash})`), `gws-mcp --version -> ${version.out.trim()} (the same SDK hash)`);
  r.check(existsSync(path.join(ROOT, "src", "sdk", "generated", "UNSUPPORTED.md")), "UNSUPPORTED.md exists");
  const doctor = await runCommand(ctx.configDir, ["doctor"]);
  r.check(doctor.code === 0 && doctor.out.includes("with the fake Google (testing)"), `doctor -> exit ${doctor.code}, upstream fake`);
  r.check(/warn {2}secrets: in the key file .*WEAKER than the OS keychain/.test(doctor.out), "doctor flags the key file as weaker than the keychain");
  r.check((doctor.out.match(/: token refresh works/g) ?? []).length === 2, `doctor refreshed each account once: ${(doctor.out.match(/: token refresh works/g) ?? []).length}`);
}
