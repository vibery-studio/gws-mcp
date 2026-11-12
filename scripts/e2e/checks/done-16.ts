// Done 16: Forms, Tasks and Slides on the fake Google, through the MCP tools. Search finds a method per service;
// the reads return validated data (a bad-shape response is refused); a task insert and a Slides replaceAllText dry-run with no API write, then
// apply observably; deletes are flagged destructive; regeneration stays byte-identical. An account connected for
// the five original services only is offered every other service on its "Add Google services" page (a first sign-in
// account is offered only the opt-in ones), and
// gets GWS_SCOPE_MISSING (not a crash) on Tasks, while its Drive scope still serves Forms and Slides reads, as
// their Discovery scopes allow.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codeOf, type ExecuteReport } from "../mcp";
import { DEFAULT_CONNECT_SERVICES, GOOGLE_SERVICES } from "../../../src/config";
import { COPY, SERVICE_NAMES } from "../../../src/web/copy";
import { connectFromAccounts, connectionsRedirect, formFields, signedInPage } from "../oauth-driver";
import type { CheckResult, E2eContext, Recorder } from "../run";
import { NEW_SERVICE_QUERIES } from "./done-03";
import { apiWrites, logged } from "./done-05";
import { genCheck } from "./done-10";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAX_RANK = 3;

/** Seeded by the fake's `default` preset for every account. */
const SEED_FORM = "seed-form-feedback";
const SEED_LIST = "seed-tasklist-default";
const SEED_SLIDES = "seed-slides-template";
/** `tasks.tasklists.list` as the fake logs it (host-prefixed, `@me` possibly percent-encoded). */
const TASKLISTS_PATH = "^/tasks\\.googleapis\\.com/tasks/v1/users/(?:@|%40)me/lists$";
/** `{{name}}` occurs this many times in the seeded template. */
const TEMPLATE_NAME_OCCURRENCES = 3;

const NEW_SERVICES = ["forms", "tasks", "slides"] as const;
const ORIGINAL_SERVICES = ["gmail", "drive", "calendar", "sheets", "docs"] as const;
/** What an account connected for the original five can add: every other service, in the page's order. */
const OFFERED_TO_OLDER = GOOGLE_SERVICES.filter((s) => !(ORIGINAL_SERVICES as readonly string[]).includes(s));
/** What a first sign-in leaves to add: the opt-in services (Ads, Groups, Analytics editing, Tag Manager edit, publish, admin). */
const OFFERED_AFTER_FIRST_SIGN_IN = GOOGLE_SERVICES.filter((s) => !DEFAULT_CONNECT_SERVICES.includes(s));

type Plan = ExecuteReport["plan"];

function planLine(plan: Plan): string {
  return plan.map((p) => `${p.fn}${p.request ? ` ${p.request.method}` : ""} destructive=${p.destructive}`).join("; ") || "(empty)";
}

/**
 * An account's "Add Google services" page: the services it already has (read-only), the ones it can add (the
 * only checkboxes), and whether those post to the page's own action with a "Continue to Google" button.
 */
async function servicesOffer(ctx: E2eContext, accountId: string) {
  const path = `/accounts/${encodeURIComponent(accountId)}/services`;
  const { html } = await signedInPage(ctx.browser, path);
  const connected = html.split("Already connected</h2>")[1]?.split("<form")[0]?.split("</ul>")[0] ?? "";
  const offered = [...html.matchAll(/<input type="checkbox" name="service" value="([a-z]+)"/g)].map((m) => m[1] ?? "");
  const form = formFields(html, path) !== undefined && html.includes(`>${COPY.actions.continueToGoogle}</button>`);
  return {
    has: (svc: keyof typeof SERVICE_NAMES) => connected.includes(`<strong>${SERVICE_NAMES[svc]}</strong>`),
    offered,
    form,
    allConnected: html.includes(COPY.empty.allServicesConnected),
  };
}

async function searchesNewServices(ctx: E2eContext, r: Recorder): Promise<void> {
  for (const [query, expected] of NEW_SERVICE_QUERIES) {
    const { results, isError } = await ctx.main.session.search(query);
    const rank = results.findIndex((x) => x.name === expected) + 1;
    r.check(!isError && rank >= 1 && rank <= MAX_RANK, `search("${query}") -> ${expected} at rank ${rank || "none"}`);
  }
}

async function reads(ctx: E2eContext, r: Recorder): Promise<void> {
  const run = await ctx.main.session.execute(`async () => {
    const form = await sdk.forms.forms.get({ formId: ${JSON.stringify(SEED_FORM)} });
    const responses = await sdk.forms.forms.responses.list({ formId: ${JSON.stringify(SEED_FORM)} });
    const lists = await sdk.tasks.tasklists.list({});
    const deck = await sdk.slides.presentations.get({ presentationId: ${JSON.stringify(SEED_SLIDES)} });
    return {
      formItems: (form.items ?? []).length,
      responses: (responses.responses ?? []).length,
      lists: (lists.items ?? []).map((l) => l.id),
      slides: (deck.slides ?? []).length,
    };
  }`);
  const v = run.out.result as { formItems?: number; responses?: number; lists?: string[]; slides?: number } | undefined;
  const statuses = run.out.calls.map((c) => `${c.fn}:${c.status}`);
  r.check(
    run.out.ok && run.out.calls.length === 4 && run.out.calls.every((c) => c.status === "ok" && c.effect === "read"),
    `reads (output zod-validated by the dispatcher): ${statuses.join(", ")}`,
  );
  r.check(
    (v?.formItems ?? 0) > 0 && (v?.responses ?? 0) > 0 && (v?.lists ?? []).includes(SEED_LIST) && (v?.slides ?? 0) > 0,
    `  form items=${v?.formItems ?? "-"} responses=${v?.responses ?? "-"} tasklists=${JSON.stringify(v?.lists ?? [])} slides=${v?.slides ?? "-"}`,
  );
}

/**
 * The new services' responses are validated, not passed through: a fake 200 whose `items` is not an array gives
 * GWS_RESPONSE_SHAPE. The fault fires once (`times: 1`); the plain read after it must succeed, which also
 * consumes the fault if the faulted call never reached the fake, so none is left behind.
 */
async function responseShape(ctx: E2eContext, r: Recorder): Promise<void> {
  const s = ctx.main.session;
  await ctx.fake.fault({
    email: ctx.emails.a,
    method: "GET",
    pathRegex: TASKLISTS_PATH,
    times: 1,
    response: { status: 200, body: { kind: "tasks#taskLists", items: "not-an-array" } },
  });
  const list = `async () => sdk.tasks.tasklists.list({})`;
  const faulted = await s.execute(list);
  r.check(codeOf(faulted.out) === "GWS_RESPONSE_SHAPE", `tasks.tasklists.list with a bad-shape 200 (fault: items not an array) -> ${codeOf(faulted.out)}`);
  const after = await s.execute(list);
  const items = (after.out.result as { items?: unknown[] } | undefined)?.items;
  r.check(after.out.ok && Array.isArray(items), `  next tasks.tasklists.list (fault consumed) -> ${after.out.ok ? `ok, ${items?.length ?? 0} lists` : codeOf(after.out)}`);
}

async function taskInsert(ctx: E2eContext, r: Recorder): Promise<void> {
  const s = ctx.main.session;
  const email = ctx.emails.a;
  const title = `E2E-TASK-${ctx.runId}`;
  const code = `async () => sdk.tasks.tasks.insert({ tasklist: ${JSON.stringify(SEED_LIST)}, requestBody: { title: ${JSON.stringify(title)} } })`;
  const titled = async () =>
    Object.entries((await ctx.fake.state(email)).resources).filter(
      ([k, v]) => k.startsWith(`tasks:task:${email}:${SEED_LIST}/`) && (v as { title?: unknown }).title === title,
    );

  const dry = await logged(ctx, email, () => s.execute(code));
  const [step] = dry.value.out.plan;
  r.check(
    dry.value.out.ok && !dry.value.out.applied && dry.value.out.plan.length === 1 && step?.fn === "tasks.tasks.insert" && step.effect === "write" && !step.destructive,
    `tasks.tasks.insert dry-run: applied=${dry.value.out.applied} plan=${planLine(dry.value.out.plan)}`,
  );
  const dryWrites = apiWrites(dry.added);
  const afterDry = await titled();
  r.check(dry.intact && dryWrites.length === 0 && afterDry.length === 0, `  request log ${dry.counts} (intact=${dry.intact}), API writes=${dryWrites.length}, tasks titled ${title}=${afterDry.length}`);

  const applied = await logged(ctx, email, () => s.execute(code, true));
  const out = applied.value.out.result as { id?: string; title?: string } | undefined;
  r.check(applied.value.out.ok && applied.value.out.applied && typeof out?.id === "string", `tasks.tasks.insert apply:true -> ok=${applied.value.out.ok} id=${out?.id ?? "-"}`);
  const writes = apiWrites(applied.added);
  const stored = await titled();
  r.check(
    applied.intact && writes.length === 1 && stored.length === 1 && stored[0]?.[0] === `tasks:task:${email}:${SEED_LIST}/${out?.id ?? "?"}`,
    `  API writes=${writes.length} (${writes.map((w) => `${w.method} ${w.path}`).join("; ")}); /__fake/state has the task: ${stored.length === 1}`,
  );
}

async function slidesReplace(ctx: E2eContext, r: Recorder): Promise<void> {
  const s = ctx.main.session;
  const email = ctx.emails.a;
  const marker = `E2E-SLIDES-${ctx.runId}`;
  const code = `async () => sdk.slides.presentations.batchUpdate({
    presentationId: ${JSON.stringify(SEED_SLIDES)},
    requestBody: { requests: [{ replaceAllText: { containsText: { text: "{{name}}", matchCase: true }, replaceText: ${JSON.stringify(marker)} } }] },
  })`;
  const blobKey = `drive:blob:${email}:${SEED_SLIDES}`;
  const blob = async () => (await ctx.fake.state(email)).resources[blobKey];

  const before = await blob();
  const dry = await logged(ctx, email, () => s.execute(code));
  const [step] = dry.value.out.plan;
  r.check(
    dry.value.out.ok && !dry.value.out.applied && dry.value.out.plan.length === 1 && step?.fn === "slides.presentations.batchUpdate" && !step.destructive,
    `slides replaceAllText dry-run: applied=${dry.value.out.applied} plan=${planLine(dry.value.out.plan)}`,
  );
  const dryWrites = apiWrites(dry.added);
  const unchanged = typeof before === "string" && (await blob()) === before;
  r.check(dry.intact && dryWrites.length === 0 && unchanged, `  request log ${dry.counts} (intact=${dry.intact}), API writes=${dryWrites.length}, presentation unchanged=${unchanged}`);

  const applied = await logged(ctx, email, () => s.execute(code, true));
  const reply = applied.value.out.result as { replies?: Array<{ replaceAllText?: { occurrencesChanged?: number } }> } | undefined;
  const changed = reply?.replies?.[0]?.replaceAllText?.occurrencesChanged;
  r.check(applied.value.out.ok && applied.value.out.applied && changed === TEMPLATE_NAME_OCCURRENCES, `slides replaceAllText apply:true -> ok=${applied.value.out.ok} occurrencesChanged=${changed ?? "-"}`);
  const writes = apiWrites(applied.added);
  const read = await s.execute(`async () => {
    const deck = await sdk.slides.presentations.get({ presentationId: ${JSON.stringify(SEED_SLIDES)} });
    const text = JSON.stringify(deck);
    return { marker: text.split(${JSON.stringify(marker)}).length - 1, placeholders: text.split("{{name}}").length - 1 };
  }`);
  const seen = read.out.result as { marker?: number; placeholders?: number } | undefined;
  r.check(
    applied.intact && writes.length === 1 && (await blob()) !== before && seen?.marker === TEMPLATE_NAME_OCCURRENCES && seen.placeholders === 0,
    `  API writes=${writes.length}; presentations.get shows the replacement ${seen?.marker ?? "-"}x and {{name}} ${seen?.placeholders ?? "-"}x`,
  );
}

async function deletesFlagged(ctx: E2eContext, r: Recorder): Promise<void> {
  const email = ctx.emails.a;
  const dry = await logged(ctx, email, () =>
    ctx.main.session.execute(`async () => {
      await sdk.tasks.tasks.delete({ tasklist: ${JSON.stringify(SEED_LIST)}, task: "seed-task-2" });
      await sdk.slides.presentations.batchUpdate({ presentationId: ${JSON.stringify(SEED_SLIDES)}, requestBody: { requests: [{ deleteObject: { objectId: "seed-slide-2" } }] } });
      await sdk.forms.forms.batchUpdate({ formId: ${JSON.stringify(SEED_FORM)}, requestBody: { requests: [{ deleteItem: { location: { index: 0 } } }] } });
      return "planned";
    }`),
  );
  const plan = dry.value.out.plan;
  const fns = plan.map((p) => p.fn);
  r.check(
    dry.value.out.ok &&
      !dry.value.out.applied &&
      dry.value.out.destructive &&
      JSON.stringify(fns) === JSON.stringify(["tasks.tasks.delete", "slides.presentations.batchUpdate", "forms.forms.batchUpdate"]) &&
      plan.every((p) => p.destructive),
    `deletes dry-run: execute destructive=${dry.value.out.destructive} plan=${planLine(plan)}`,
  );
  const writes = apiWrites(dry.added);
  r.check(dry.intact && writes.length === 0, `  request log ${dry.counts} (intact=${dry.intact}), API writes=${writes.length}`);
}

async function regeneration(ctx: E2eContext, r: Recorder): Promise<void> {
  const { exitCode, hash } = await genCheck();
  const res = await fetch(new URL("/version", ctx.base));
  const version = (await res.json()) as { sdkHash?: string };
  const files = NEW_SERVICES.map((svc) => path.join(ROOT, "src", "sdk", "generated", `${svc}.ts`));
  r.check(
    exitCode === 0 && hash !== undefined && version.sdkHash === hash && files.every((f) => existsSync(f)),
    `gen:check exit ${exitCode} byte-identical ${hash ?? "(no hash)"} == /version: ${version.sdkHash === hash}; generated ${NEW_SERVICES.join(", ")}: ${files.every((f) => existsSync(f))}`,
  );
}

async function olderAccount(ctx: E2eContext, r: Recorder): Promise<void> {
  const d = `e2e-${ctx.runId}-d@fake.test`;
  await ctx.fake.seed({ accounts: [{ email: d, sub: `9${Date.now()}4${Math.floor(Math.random() * 1e6)}`, preset: "default" }] });
  const landed = await connectFromAccounts(ctx.browser, ctx.fake, d, ORIGINAL_SERVICES);
  r.check(new URL(landed, ctx.base).pathname === "/accounts", `older account d connected for ${ORIGINAL_SERVICES.join(", ")} only -> ${new URL(landed, ctx.base).pathname}`);
  const old = await connectionsRedirect(ctx.browser);
  r.check(old.status === 303 && old.location === "/accounts", `the old /connections page -> ${old.status} ${old.location ?? ""}`);

  const ids = await ctx.accountIds();
  const dId = ids[d];
  const aId = ids[ctx.emails.a];
  if (!r.check(dId !== undefined && aId !== undefined, "accounts a and d are stored for the user") || dId === undefined || aId === undefined) return;
  const offerD = await servicesOffer(ctx, dId);
  r.check(
    JSON.stringify(offerD.offered) === JSON.stringify(OFFERED_TO_OLDER) && offerD.form && ORIGINAL_SERVICES.every(offerD.has) && !NEW_SERVICES.some(offerD.has),
    `Add Google services for d: can add [${offerD.offered.join(", ")}] with ${COPY.actions.continueToGoogle} (${offerD.form}); already connected ${ORIGINAL_SERVICES.filter(offerD.has).length}/${ORIGINAL_SERVICES.length}`,
  );
  const offerA = await servicesOffer(ctx, aId);
  r.check(
    JSON.stringify(offerA.offered) === JSON.stringify(OFFERED_AFTER_FIRST_SIGN_IN) && !offerA.allConnected && DEFAULT_CONNECT_SERVICES.every(offerA.has),
    `Add Google services for a (first sign-in, one-click set): already connected ${DEFAULT_CONNECT_SERVICES.filter(offerA.has).length}/${DEFAULT_CONNECT_SERVICES.length}; can add [${offerA.offered.join(", ")}]`,
  );

  const client = await ctx.newClient(`E2E older-account client ${ctx.runId}`, [d]);
  try {
    const listed = await client.session.execute(`async () => sdk.accounts.list()`);
    const acct = (listed.out.result as { accounts?: Array<{ email: string; services: Record<string, boolean> }> } | undefined)?.accounts?.find((x) => x.email === d);
    const svc = acct?.services ?? {};
    r.check(
      NEW_SERVICES.every((s) => svc[s] === false) && ORIGINAL_SERVICES.every((s) => svc[s] === true),
      `accounts.list services for d: ${[...ORIGINAL_SERVICES, ...NEW_SERVICES].map((s) => `${s}=${svc[s]}`).join(" ")}`,
    );

    const tasks = await client.session.execute(`async () => sdk.tasks.tasklists.list({ account: ${JSON.stringify(d)} })`);
    const hint = tasks.out.error?.details?.connectHint;
    r.check(
      codeOf(tasks.out) === "GWS_SCOPE_MISSING" && typeof hint === "string" && hint.includes("'tasks'"),
      `tasks.tasklists.list on d -> ${codeOf(tasks.out)} connectHint=${typeof hint === "string" ? hint : "-"}`,
    );
    const drive = await client.session.execute(`async () => {
      const form = await sdk.forms.forms.get({ formId: ${JSON.stringify(SEED_FORM)}, account: ${JSON.stringify(d)} });
      const deck = await sdk.slides.presentations.get({ presentationId: ${JSON.stringify(SEED_SLIDES)}, account: ${JSON.stringify(d)} });
      return { form: form.formId, slides: (deck.slides ?? []).length };
    }`);
    const got = drive.out.result as { form?: string; slides?: number } | undefined;
    r.check(
      drive.out.ok && got?.form === SEED_FORM && (got.slides ?? 0) > 0,
      `forms.get + slides.presentations.get on d via its Drive scope (Discovery) -> ${drive.out.ok ? "ok" : codeOf(drive.out)}; the session still answers after the refusal`,
    );
  } finally {
    await client.session.close();
  }
}

export default async function done16(ctx: E2eContext, r: Recorder): Promise<CheckResult> {
  await searchesNewServices(ctx, r);
  await reads(ctx, r);
  await responseShape(ctx, r);
  await taskInsert(ctx, r);
  await slidesReplace(ctx, r);
  await deletesFlagged(ctx, r);
  await regeneration(ctx, r);
  await olderAccount(ctx, r);
  return r.done();
}
