import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import spreadsheetsCreate from "../../fake-google/fixtures/sheets/spreadsheets-create.json";
import spreadsheetsGet from "../../fake-google/fixtures/sheets/spreadsheets-get.json";
import valuesAppend from "../../fake-google/fixtures/sheets/values-append.json";
import valuesClear from "../../fake-google/fixtures/sheets/values-clear.json";
import valuesGet from "../../fake-google/fixtures/sheets/values-get.json";
import { parseFixture, type Fixture } from "../../fake-google/src/fixtures";
import { routes } from "../../fake-google/src/routes/sheets";
import { loadConfig } from "../../src/config";
import { googleOAuth } from "../../src/google/oauth";
import { createTransport } from "../../src/google/transport";
import { generatedFns } from "../../src/sdk/generated/index";
import { authorizeAtFake } from "../helpers/accounts";
import { fake, fakeFetch, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const SHEETS = `${G}spreadsheets`;
const BASE = "/sheets.googleapis.com/v4/spreadsheets";
const SEED = "seed-sheet-budget";
const FIXTURE_EMAIL = "alice@fake.test";

const transport = createTransport(env, loadConfig(env));

async function account(scopes: string[], email = uniqueEmail("sheets")) {
  await fake.seed({ accounts: [{ email, sub: "100000000000000000001", preset: "default" }] });
  const tokens = await googleOAuth(env, transport).exchangeCode(await authorizeAtFake({ email, scopes }));
  return { email, token: tokens.accessToken };
}

function api(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fakeFetch(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
}

function post(token: string, path: string, body?: unknown): Promise<Response> {
  return api(token, path, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

const enc = encodeURIComponent;

async function values(token: string, id: string, range: string, query = ""): Promise<{ range: string; values?: unknown[][]; majorDimension: string }> {
  const res = await api(token, `${BASE}/${id}/values/${enc(range)}${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { range: string; values?: unknown[][]; majorDimension: string };
}

function append(token: string, id: string, range: string, rows: unknown[][], query = "valueInputOption=USER_ENTERED"): Promise<Response> {
  return post(token, `${BASE}/${id}/values/${enc(range)}:append?${query}`, { values: rows });
}

function outputSchema(fn: string) {
  const def = generatedFns.find((f) => f.name === fn);
  if (!def) throw new Error(`no generated fn ${fn}`);
  return def.output;
}

async function createSheet(token: string, body: unknown = { properties: { title: "Ledger" } }): Promise<string> {
  const res = await post(token, BASE, body);
  expect(res.status).toBe(200);
  return ((await res.json()) as { spreadsheetId: string }).spreadsheetId;
}

describe("scopes", () => {
  const ROUTES = [
    { fn: "sheets.spreadsheets.create", method: "POST", path: BASE },
    { fn: "sheets.spreadsheets.get", method: "GET", path: `${BASE}/${SEED}` },
    { fn: "sheets.spreadsheets.values.get", method: "GET", path: `${BASE}/${SEED}/values/Sheet1` },
    { fn: "sheets.spreadsheets.values.append", method: "POST", path: `${BASE}/${SEED}/values/Sheet1:append` },
    { fn: "sheets.spreadsheets.values.clear", method: "POST", path: `${BASE}/${SEED}/values/Sheet1:clear` },
  ] as const;

  it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))("%s requires exactly the method's Discovery scopes", (_name, r) => {
    const route = routes.find((x) => x.method === r.method && x.pattern.test(r.path));
    expect(route, r.fn).toBeDefined();
    const meta = generatedFns.find((f) => f.name === r.fn)?.method;
    expect([...(route?.scopes ?? [])].sort()).toEqual([...(meta?.scopes ?? [])].sort());
  });

  it("refuses each route for a token without any of its scopes", async () => {
    const { token } = await account([`${G}calendar.events`]);
    for (const r of ROUTES) {
      const res = await api(token, r.path, { method: r.method });
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      const body = (await res.json()) as { error: { details: Array<{ reason: string }> } };
      expect(body.error.details[0]?.reason).toBe("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    }
  });

  it("lets spreadsheets.readonly read but not append", async () => {
    const { token } = await account([`${SHEETS}.readonly`]);
    expect((await api(token, `${BASE}/${SEED}/values/Sheet1`)).status).toBe(200);
    expect((await append(token, SEED, "Sheet1", [["x"]])).status).toBe(403);
  });
});

describe("spreadsheets", () => {
  it("creates a spreadsheet with a default sheet and reads it back", async () => {
    const { token } = await account([SHEETS]);
    const res = await post(token, BASE, { properties: { title: "Ledger" } });
    const created = (await res.json()) as { spreadsheetId: string; spreadsheetUrl: string; properties: { title: string }; sheets: Array<{ properties: { title: string; sheetId: number } }> };
    expect(created.properties.title).toBe("Ledger");
    expect(created.sheets.map((s) => s.properties.title)).toEqual(["Sheet1"]);
    expect(created.spreadsheetUrl).toContain(created.spreadsheetId);
    expect(outputSchema("sheets.spreadsheets.create").safeParse(created).success).toBe(true);
    const got = (await (await api(token, `${BASE}/${created.spreadsheetId}`)).json()) as typeof created;
    expect(got).toEqual(created);
  });

  it("creates named sheets, and returns 404 for an unknown spreadsheet", async () => {
    const { token } = await account([SHEETS]);
    const id = await createSheet(token, { properties: { title: "Two" }, sheets: [{ properties: { title: "Data" } }, { properties: { title: "Notes" } }] });
    const got = (await (await api(token, `${BASE}/${id}`)).json()) as { sheets: Array<{ properties: { title: string; index: number } }> };
    expect(got.sheets.map((s) => [s.properties.title, s.properties.index])).toEqual([["Data", 0], ["Notes", 1]]);
    expect((await api(token, `${BASE}/nope`)).status).toBe(404);
  });
});

describe("values.append", () => {
  it("appends after the last row and returns an updates block shaped like Google", async () => {
    const { email, token } = await account([SHEETS]);
    const id = await createSheet(token);
    const first = (await (await append(token, id, "Sheet1", [["a", "b", "c"], [1, 2, 3]])).json()) as Record<string, unknown>;
    expect(first.tableRange).toBeUndefined();
    expect(first.updates).toEqual({ spreadsheetId: id, updatedRange: "Sheet1!A1:C2", updatedRows: 2, updatedColumns: 3, updatedCells: 6 });
    const second = (await (await append(token, id, "Sheet1!A1:C1", [["x", "y", "z"]])).json()) as Record<string, unknown>;
    expect(second.tableRange).toBe("Sheet1!A1:C2");
    expect(second.updates).toMatchObject({ updatedRange: "Sheet1!A3:C3", updatedRows: 1, updatedColumns: 3, updatedCells: 3 });
    expect(outputSchema("sheets.spreadsheets.values.append").safeParse(second).success).toBe(true);
    expect((await values(token, id, "Sheet1")).values).toEqual([["a", "b", "c"], ["1", "2", "3"], ["x", "y", "z"]]);
    expect((await fake.state(email)).resources[`sheets:spreadsheet:${email}:${id}`]).toBeDefined();
  });

  it("appends below the seeded table", async () => {
    const { token } = await account([SHEETS]);
    const res = (await (await append(token, SEED, "Sheet1", [["Tea", 3]])).json()) as { tableRange: string; updates: { updatedRange: string } };
    expect(res.tableRange).toBe("Sheet1!A1:B2");
    expect(res.updates.updatedRange).toBe("Sheet1!A3:B3");
  });

  it("starts at the column of the range and handles quoted sheet titles", async () => {
    const { token } = await account([SHEETS]);
    const id = await createSheet(token, { properties: { title: "T" }, sheets: [{ properties: { title: "My Data" } }] });
    const res = (await (await append(token, id, "'My Data'!B1", [["q"]])).json()) as { updates: { updatedRange: string } };
    expect(res.updates.updatedRange).toBe("'My Data'!B1");
    expect((await values(token, id, "'My Data'!A1:C2")).values).toEqual([["", "q"]]);
  });

  it("turns USER_ENTERED numbers into numbers and keeps RAW strings", async () => {
    const { token } = await account([SHEETS]);
    const id = await createSheet(token);
    await append(token, id, "Sheet1", [["42", "TRUE", "text"]], "valueInputOption=USER_ENTERED");
    await append(token, id, "Sheet1", [["42"]], "valueInputOption=RAW");
    expect((await values(token, id, "Sheet1", "?valueRenderOption=UNFORMATTED_VALUE")).values).toEqual([[42, true, "text"], ["42"]]);
    expect((await values(token, id, "Sheet1")).values).toEqual([["42", "TRUE", "text"], ["42"]]);
  });

  it("rejects bad requests: no valueInputOption, unknown sheet, bad values, unknown spreadsheet", async () => {
    const { token } = await account([SHEETS]);
    expect((await append(token, SEED, "Sheet1", [["x"]], "")).status).toBe(400);
    expect((await append(token, SEED, "Nope", [["x"]])).status).toBe(400);
    expect((await post(token, `${BASE}/${SEED}/values/Sheet1:append?valueInputOption=RAW`, { values: "x" })).status).toBe(400);
    expect((await post(token, `${BASE}/${SEED}/values/Sheet1:append?valueInputOption=RAW`, { values: [] })).status).toBe(400);
    expect((await append(token, "missing", "Sheet1", [["x"]])).status).toBe(404);
  });
});

describe("values.get and values.clear", () => {
  it("reads a bounded range, trimming trailing empty cells", async () => {
    const { token } = await account([SHEETS]);
    expect(await values(token, SEED, "Sheet1!A1:B3")).toEqual({ range: "Sheet1!A1:B3", majorDimension: "ROWS", values: [["Item", "Amount"], ["Coffee", "4"]] });
    expect((await values(token, SEED, "Sheet1!B2")).values).toEqual([["4"]]);
    expect((await values(token, SEED, "Sheet1!D1:E5")).values).toBeUndefined();
    expect((await values(token, SEED, "Sheet1!A:A")).values).toEqual([["Item"], ["Coffee"]]);
    expect((await values(token, SEED, "Sheet1")).range).toBe("Sheet1!A1:Z1000");
    expect(outputSchema("sheets.spreadsheets.values.get").safeParse(await values(token, SEED, "Sheet1")).success).toBe(true);
  });

  it("clears a range and reports it", async () => {
    const { token } = await account([SHEETS]);
    const res = await post(token, `${BASE}/${SEED}/values/${enc("Sheet1!A2:B2")}:clear`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ spreadsheetId: SEED, clearedRange: "Sheet1!A2:B2" });
    expect(outputSchema("sheets.spreadsheets.values.clear").safeParse(body).success).toBe(true);
    expect((await values(token, SEED, "Sheet1")).values).toEqual([["Item", "Amount"]]);
  });

  it("rejects an unparseable range and COLUMNS major dimension", async () => {
    const { token } = await account([SHEETS]);
    expect((await api(token, `${BASE}/${SEED}/values/${enc("Sheet1!ZZ")}`)).status).toBe(400);
    expect((await api(token, `${BASE}/${SEED}/values/Sheet1?majorDimension=COLUMNS`)).status).toBe(400);
  });
});

describe("fixtures", () => {
  const byId = (f: unknown): Fixture => parseFixture(f);

  function url(fx: Fixture): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(fx.request.query ?? {})) for (const x of [v].flat()) qs.append(k, x);
    return `${fx.request.path}${qs.size > 0 ? `?${qs}` : ""}`;
  }

  it("are what the fake serves for a seeded account, replayed in order", async () => {
    const email = uniqueEmail("sheets-replay");
    const { token } = await account([SHEETS], email);
    const steps: Array<[Fixture, unknown?]> = [
      [byId(spreadsheetsGet)],
      [byId(valuesGet)],
      [byId(valuesAppend), { values: [["Tea", 3]] }],
      [byId(valuesClear)],
      [byId(spreadsheetsCreate), { properties: { title: "Budget" } }],
    ];
    for (const [fx, body] of steps) {
      const res = await api(token, url(fx), {
        method: fx.request.method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      expect(res.status, fx.id).toBe(fx.response.status);
      const actual = JSON.parse((await res.text()).replaceAll(email, FIXTURE_EMAIL)) as Record<string, unknown>;
      const expected = fx.response.body as Record<string, unknown>;
      if (fx.id === "sheets-spreadsheets-create") {
        // A new spreadsheet has a fresh id and link.
        for (const k of ["spreadsheetId", "spreadsheetUrl"]) {
          delete actual[k];
          delete expected[k];
        }
      }
      expect(actual, fx.id).toEqual(expected);
    }
  });
});
