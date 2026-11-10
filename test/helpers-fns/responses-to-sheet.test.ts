import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../../src/config";
import { PENDING_TOKEN_PREFIX, type AuthProps } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { getRegistry } from "../../src/core/registry";
import { search } from "../../src/core/search";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const COPY = "forms.responsesToSheet";
const FORM = "seed-form-feedback";
const SHEET = "seed-sheet-budget";
const SCOPES = [`${G}forms.body`, `${G}forms.responses.readonly`, `${G}spreadsheets`];
const store = openStore(env);
const baseConfig = loadConfig(env);
const pending = (ref: string) => `${PENDING_TOKEN_PREFIX}${ref}`;

const HEADER = ["Timestamp", "Email Address", "Your name", "How useful was it?"];
const DANA = ["2026-11-05T02:15:00.000Z", "dana@fake.test", "Dana", "Very"];
const ERIN = ["2026-11-06T09:30:00.000Z", "erin@fake.test", "Erin", "Somewhat"];

async function client(scopes: string[] = SCOPES) {
  const email = uniqueEmail("h-form");
  const seeded = await seedUserWithAccount(env, { email, scopes, isDefault: true });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }] });
  const auth: AuthProps = { userId: seeded.userId, clientId: `client-${crypto.randomUUID()}` };
  await store.grants.add(auth.userId, auth.clientId, seeded.account.id);
  return { email, auth };
}

function session(auth: AuthProps, apply: boolean, config: Config = baseConfig) {
  const executeId = `x-${crypto.randomUUID()}`;
  return { s: createCallSession({ ports: workersPorts(env), auth, apply, executeId, config }), executeId };
}

function valueOf(r: DispatchResult): Record<string, unknown> {
  if (!("ok" in r)) throw new Error(`expected a value result, got ${JSON.stringify(r)}`);
  return r.value as Record<string, unknown>;
}

async function rows(auth: AuthProps): Promise<unknown[][]> {
  const { s } = session(auth, false);
  return (valueOf(await s.dispatch("sheets.spreadsheets.values.get", { spreadsheetId: SHEET, range: "Sheet1" })).values as unknown[][] | undefined) ?? [];
}

describe("forms.responsesToSheet", () => {
  it("is a write helper with a signature, example and tags, and search ranks it first", () => {
    const fn = getRegistry().get(COPY);
    expect(fn).toMatchObject({ kind: "host", service: "helpers", effect: "write" });
    expect(fn?.signature).toContain(`${COPY}(`);
    expect(fn?.signature).toContain("Promise<");
    expect(fn?.example).toContain(`await sdk.${COPY}(`);
    expect(fn?.tags).toContain("write");
    expect(fn?.tsDecl.length).toBeGreaterThan(20);
    const top = search({ query: "copy form responses to a spreadsheet" }, [...getRegistry().values()], { SEARCH_MAX_BYTES: 8000 }).map((r) => r.name);
    expect(top[0]).toBe(COPY);
  });

  it("dry-run reads the form and its responses, plans one RAW append and writes nothing", async () => {
    const { email, auth } = await client();
    const before = await rows(auth);
    const { s, executeId } = session(auth, false);

    const out = valueOf(await s.dispatch(COPY, { formId: FORM, spreadsheetId: SHEET }));

    expect(out).toEqual({ applied: false, step: "s1", responses: 2 });
    expect(s.plan).toHaveLength(1);
    expect(s.plan[0]).toMatchObject({ step: "s1", fn: "sheets.spreadsheets.values.append", account: email, effect: "write", destructive: false });
    expect(s.plan[0]?.request?.query).toMatchObject({ valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" });
    expect(s.plan[0]?.request?.url).toContain(`/spreadsheets/${SHEET}/values/A1:append`);
    expect(s.plan[0]?.request?.body).toEqual({ values: [HEADER, DANA, ERIN] });
    expect(await rows(auth)).toEqual(before);
    const sent = (await fake.requests(email)).map((q) => `${q.method} ${q.path}`);
    expect(sent.filter((r) => !r.startsWith("GET ") && r.includes("/sheets.googleapis.com/"))).toEqual([]);
    expect(sent.filter((r) => r.includes("/forms.googleapis.com/"))).toEqual([
      `GET /forms.googleapis.com/v1/forms/${FORM}`,
      `GET /forms.googleapis.com/v1/forms/${FORM}/responses`,
    ]);

    await s.close();
    const { results } = await env.DB.prepare("SELECT fn, applied FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
    expect(results.map((r) => [r.fn, r.applied])).toEqual([
      ["forms.forms.get", 0],
      ["forms.forms.responses.list", 0],
      ["sheets.spreadsheets.values.append", 0],
      [COPY, 0],
    ]);
  });

  it("apply appends the header and one row per response, read over two pages", async () => {
    const { email, auth } = await client();
    const { s, executeId } = session(auth, true);

    const out = valueOf(await s.dispatch(COPY, { formId: FORM, spreadsheetId: SHEET, range: "Sheet1!A1", pageSize: 1 }));

    expect(out).toMatchObject({ applied: true, spreadsheetId: SHEET, responses: 2, updatedRange: "Sheet1!A3:D5", updatedRows: 3 });
    expect(await rows(auth)).toEqual([["Item", "Amount"], ["Coffee", "4"], HEADER, DANA, ERIN]);
    const pages = (await fake.requests(email)).filter((q) => q.path.endsWith(`/forms/${FORM}/responses`));
    expect(pages).toHaveLength(2);

    await s.close();
    const { results } = await env.DB.prepare("SELECT fn, applied FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
    expect(results.map((r) => r.fn)).toEqual([
      "forms.forms.get",
      "forms.forms.responses.list",
      "forms.forms.responses.list",
      "sheets.spreadsheets.values.append",
      COPY,
    ]);
  });

  it("stops at the per-execute call budget instead of reading every page", async () => {
    const { auth } = await client();
    const before = await rows(auth);
    // The helper itself, the form read and the first page use the budget; the second page is refused.
    const { s } = session(auth, true, { ...baseConfig, CALLS_PER_EXECUTE: 3 });
    const r = await s.dispatch(COPY, { formId: FORM, spreadsheetId: SHEET, pageSize: 1 });
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_CALL_BUDGET_EXCEEDED");
    expect(await rows(auth)).toEqual(before);
  });

  it("fails with GWS_SCOPE_MISSING without the responses scope, and appends nothing", async () => {
    const { auth } = await client([`${G}forms.body`, `${G}spreadsheets`]);
    const before = await rows(auth);
    const r = await session(auth, true).s.dispatch(COPY, { formId: FORM, spreadsheetId: SHEET });
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_SCOPE_MISSING");
    expect(await rows(auth)).toEqual(before);
  });

  it("surfaces an upstream error for an unknown form", async () => {
    const { auth } = await client();
    const r = await session(auth, true).s.dispatch(COPY, { formId: "missing", spreadsheetId: SHEET });
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_UPSTREAM_ERROR");
  });

  it("rejects bad input", async () => {
    const { auth } = await client();
    const { s } = session(auth, true);
    for (const bad of [
      { spreadsheetId: SHEET },
      { formId: FORM },
      { formId: "", spreadsheetId: SHEET },
      { formId: FORM, spreadsheetId: SHEET, pageSize: 0 },
      { formId: FORM, spreadsheetId: SHEET, extra: true },
    ]) {
      const r = await s.dispatch(COPY, bad);
      expect("__gwsError" in r && r.__gwsError.code, JSON.stringify(bad)).toBe("GWS_INVALID_INPUT");
    }
  });

  it("plans a copy into a spreadsheet created in the same dry-run as incomplete, and reads nothing", async () => {
    const { email, auth } = await client();
    const logBefore = (await fake.requests(email)).length;
    const { s } = session(auth, false);
    expect(await s.dispatch("sheets.spreadsheets.create", { requestBody: { properties: { title: "Responses" } } })).toEqual({ __gwsPending: "s1" });
    const r = await s.dispatch(COPY, { formId: FORM, spreadsheetId: pending("s1.spreadsheetId") });
    expect(r).toEqual({ __gwsPending: "s2" });
    expect(s.plan[1]).toMatchObject({ step: "s2", fn: COPY, effect: "write", incomplete: true, dependsOn: ["s1"] });
    expect(await fake.requests(email)).toHaveLength(logBefore);
  });
});
