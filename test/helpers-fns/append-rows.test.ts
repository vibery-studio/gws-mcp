import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { PENDING_TOKEN_PREFIX, type AuthProps } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const APPEND = "helpers.appendSheetRows";
const SEED = "seed-sheet-budget";
const store = openStore(env);
const baseConfig = loadConfig(env);
const pending = (ref: string) => `${PENDING_TOKEN_PREFIX}${ref}`;

async function client() {
  const email = uniqueEmail("h-sheet");
  const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}spreadsheets`], isDefault: true });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }] });
  const auth: AuthProps = { userId: seeded.userId, clientId: `client-${crypto.randomUUID()}` };
  await store.grants.add(auth.userId, auth.clientId, seeded.account.id);
  return { email, auth };
}

function session(auth: AuthProps, apply: boolean) {
  const executeId = `x-${crypto.randomUUID()}`;
  return { s: createCallSession({ ports: workersPorts(env), auth, apply, executeId, config: baseConfig }), executeId };
}

function valueOf(r: DispatchResult): Record<string, unknown> {
  if (!("ok" in r)) throw new Error(`expected a value result, got ${JSON.stringify(r)}`);
  return r.value as Record<string, unknown>;
}

async function rows(auth: AuthProps, id = SEED): Promise<unknown[][]> {
  const { s } = session(auth, false);
  return ((valueOf(await s.dispatch("sheets.spreadsheets.values.get", { spreadsheetId: id, range: "Sheet1" })).values as unknown[][] | undefined) ?? []);
}

const ROWS = [["Tea", 3, true, null], ["Cake", 5.5, false, "note"]];

describe("helpers.appendSheetRows", () => {
  it("dry-run plans one append step and changes nothing", async () => {
    const { email, auth } = await client();
    const before = await rows(auth);
    const logBefore = (await fake.requests(email)).length;
    const { s, executeId } = session(auth, false);

    const out = valueOf(await s.dispatch(APPEND, { spreadsheetId: SEED, range: "Sheet1!A1", rows: ROWS }));

    expect(out).toEqual({ applied: false, step: "s1" });
    expect(s.plan).toHaveLength(1);
    expect(s.plan[0]).toMatchObject({ step: "s1", fn: "sheets.spreadsheets.values.append", account: email, effect: "write", destructive: false });
    expect(s.plan[0]?.request?.query).toMatchObject({ valueInputOption: "USER_ENTERED" });
    expect(s.plan[0]?.request?.body).toEqual({ values: ROWS });
    expect(await fake.requests(email)).toHaveLength(logBefore);
    expect(await rows(auth)).toEqual(before);

    await s.close();
    const { results } = await env.DB.prepare("SELECT fn, applied FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
    expect(results.map((r) => [r.fn, r.applied])).toEqual([["sheets.spreadsheets.values.append", 0], [APPEND, 0]]);
  });

  it("apply appends the rows and values.get shows them", async () => {
    const { auth } = await client();
    const { s, executeId } = session(auth, true);

    const out = valueOf(await s.dispatch(APPEND, { spreadsheetId: SEED, range: "Sheet1!A1", rows: ROWS }));

    expect(out).toMatchObject({ applied: true, spreadsheetId: SEED, updatedRange: "Sheet1!A3:D4", updatedRows: 2, updatedColumns: 4, updatedCells: 8 });
    expect(await rows(auth)).toEqual([["Item", "Amount"], ["Coffee", "4"], ["Tea", "3", "TRUE"], ["Cake", "5.5", "FALSE", "note"]]);

    await s.close();
    const { results } = await env.DB.prepare("SELECT fn, applied FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
    expect(results.map((r) => [r.fn, r.applied])).toEqual([["sheets.spreadsheets.values.append", 1], [APPEND, 1]]);
  });

  it("passes valueInputOption through", async () => {
    const { auth } = await client();
    const { s } = session(auth, false);
    await s.dispatch(APPEND, { spreadsheetId: SEED, range: "Sheet1", rows: [["x"]], valueInputOption: "RAW" });
    expect(s.plan[0]?.request?.query).toMatchObject({ valueInputOption: "RAW" });
  });

  it("rejects bad rows and unknown fields", async () => {
    const { auth } = await client();
    const { s } = session(auth, true);
    for (const bad of [
      { spreadsheetId: SEED, range: "Sheet1", rows: [] },
      { spreadsheetId: SEED, range: "Sheet1", rows: [[{ a: 1 }]] },
      { spreadsheetId: SEED, range: "Sheet1", rows: "x" },
      { spreadsheetId: SEED, range: "Sheet1", rows: [["x"]], valueInputOption: "NOPE" },
      { spreadsheetId: SEED, range: "Sheet1", rows: [["x"]], extra: true },
    ]) {
      const r = await s.dispatch(APPEND, bad);
      expect("__gwsError" in r && r.__gwsError.code, JSON.stringify(bad)).toBe("GWS_INVALID_INPUT");
    }
  });

  it("surfaces an upstream error for an unknown spreadsheet", async () => {
    const { auth } = await client();
    const { s } = session(auth, true);
    const r = await s.dispatch(APPEND, { spreadsheetId: "missing", range: "Sheet1", rows: [["x"]] });
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_UPSTREAM_ERROR");
  });

  it("plans an append to a spreadsheet created in the same dry-run as incomplete, and runs neither", async () => {
    const { email, auth } = await client();
    const { s } = session(auth, false);
    expect(await s.dispatch("sheets.spreadsheets.create", { requestBody: { properties: { title: "New" } } })).toEqual({ __gwsPending: "s1" });
    const r = await s.dispatch(APPEND, { spreadsheetId: pending("s1.spreadsheetId"), range: "Sheet1", rows: [["x"]] });
    expect(r).toEqual({ __gwsPending: "s2" });
    expect(s.plan[1]).toMatchObject({ step: "s2", fn: APPEND, effect: "write", incomplete: true, dependsOn: ["s1"] });
    expect(s.plan.some((p) => p.fn === "sheets.spreadsheets.values.append")).toBe(false);
    const writes = (await fake.requests(email)).filter((q) => q.method === "POST" && q.path.startsWith("/sheets.googleapis.com/"));
    expect(writes).toEqual([]);
  });
});
