import { googleError, randomToken } from "../oauth";
import { fakeKey, type JsonValue } from "../store";
import type { FakeContext, FakeRoute, SeedPresets } from "./index";

// ---------- model ----------

interface SheetProperties {
  [key: string]: JsonValue;
  sheetId: number;
  title: string;
  index: number;
  sheetType: "GRID";
  gridProperties: { rowCount: number; columnCount: number };
}

/** Stored at `sheets:spreadsheet:<email>:<id>`; this is also the `spreadsheets.get` body. */
interface SpreadsheetRecord {
  [key: string]: JsonValue;
  spreadsheetId: string;
  properties: { title: string; locale: string; autoRecalc: string; timeZone: string };
  sheets: Array<{ properties: SheetProperties }>;
  spreadsheetUrl: string;
}

type Cell = string | number | boolean;
type Grid = Cell[][];

/** Stored at `sheets:values:<email>:<spreadsheetId>/<sheetId>`: rows of cells, "" for an empty cell. */
interface ValuesRecord {
  [key: string]: JsonValue;
  values: Grid;
}

const DEFAULT_ROWS = 1000;
const DEFAULT_COLUMNS = 26;
const MAX_SHEETS = 100;

const spreadsheetKey = (email: string, id: string) => fakeKey("sheets", "spreadsheet", email, id);
const valuesKey = (email: string, id: string, sheetId: number) => fakeKey("sheets", "values", email, `${id}/${sheetId}`);

function newSheet(sheetId: number, title: string, index: number): { properties: SheetProperties } {
  return {
    properties: { sheetId, title, index, sheetType: "GRID", gridProperties: { rowCount: DEFAULT_ROWS, columnCount: DEFAULT_COLUMNS } },
  };
}

// ---------- errors ----------

function notFound(id: string): Response {
  const message = "Requested entity was not found.";
  return googleError(404, message, "NOT_FOUND", { errors: [{ message: `${message} (${id})`, domain: "global", reason: "notFound" }] });
}

function badRequest(message: string, reason = "badRequest"): Response {
  return googleError(400, message, "INVALID_ARGUMENT", { errors: [{ message, domain: "global", reason }] });
}

// ---------- A1 notation ----------

const idOf = (ctx: FakeContext) => decodeURIComponent(ctx.match[1] ?? "");
const rangeOf = (ctx: FakeContext) => decodeURIComponent(ctx.match[2] ?? "");

/** Zero-based, inclusive. `undefined` = unbounded on that side. */
interface Rect {
  r0?: number;
  c0?: number;
  r1?: number;
  c1?: number;
}

const A1_PART = /^([A-Za-z]+)?(\d+)?$/;

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseCorner(text: string): { col?: number; row?: number } | undefined {
  const m = A1_PART.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined)) return undefined;
  const corner: { col?: number; row?: number } = {};
  if (m[1] !== undefined) corner.col = columnIndex(m[1]);
  if (m[2] !== undefined) {
    const row = Number(m[2]) - 1;
    if (row < 0) return undefined;
    corner.row = row;
  }
  return corner;
}

/** `A1`, `A1:C3`, `A:C`, `1:3`, `A2:C`. */
function parseA1(text: string): Rect | undefined {
  const [from, to, ...rest] = text.split(":");
  if (from === undefined || rest.length > 0) return undefined;
  const a = parseCorner(from);
  if (!a) return undefined;
  if (to === undefined) return { r0: a.row, c0: a.col, r1: a.row, c1: a.col };
  const b = parseCorner(to);
  if (!b) return undefined;
  return { r0: a.row, c0: a.col, r1: b.row, c1: b.col };
}

interface Target {
  sheet: { properties: SheetProperties };
  /** Bounds as given; unbounded sides stay undefined. */
  rect: Rect;
  /** Whether an A1 part was given. */
  bounded: boolean;
}

/** Resolves `Title!A1:C3`, `'My Sheet'!A:C`, `Title` or a bare `A1:C3` (first sheet) against the spreadsheet. */
function resolveRange(book: SpreadsheetRecord, text: string): Target | undefined {
  const first = book.sheets[0];
  const byTitle = (t: string) => book.sheets.find((s) => s.properties.title === t);
  let sheet: { properties: SheetProperties } | undefined;
  let a1: string | undefined;
  const quoted = /^'((?:[^']|'')+)'(?:!(.*))?$/.exec(text);
  if (quoted) {
    sheet = byTitle((quoted[1] ?? "").replace(/''/g, "'"));
    a1 = quoted[2];
  } else if (text.includes("!")) {
    const at = text.lastIndexOf("!");
    sheet = byTitle(text.slice(0, at));
    a1 = text.slice(at + 1);
  } else if (byTitle(text)) {
    sheet = byTitle(text);
  } else {
    sheet = first;
    a1 = text;
  }
  if (!sheet) return undefined;
  if (a1 === undefined || a1 === "") return { sheet, rect: {}, bounded: false };
  const rect = parseA1(a1);
  return rect ? { sheet, rect, bounded: true } : undefined;
}

const titleText = (t: string) => (/^[A-Za-z0-9_]+$/.test(t) ? t : `'${t.replace(/'/g, "''")}'`);

/** The A1 string of a rectangle, with unbounded sides taken from the grid. */
function formatRange(sheet: { properties: SheetProperties }, r0: number, c0: number, r1: number, c1: number): string {
  const corner = (r: number, c: number) => `${columnLetters(c)}${r + 1}`;
  const cells = r0 === r1 && c0 === c1 ? corner(r0, c0) : `${corner(r0, c0)}:${corner(r1, c1)}`;
  return `${titleText(sheet.properties.title)}!${cells}`;
}

/** Fills unbounded sides: the start at the first row/column, the end at the grid's edge. */
function bounds(target: Target): { r0: number; c0: number; r1: number; c1: number } {
  const { rowCount, columnCount } = target.sheet.properties.gridProperties;
  const { r0 = 0, c0 = 0, r1 = rowCount - 1, c1 = columnCount - 1 } = target.rect;
  return { r0, c0, r1, c1 };
}

function withinGrid(target: Target): boolean {
  const { rowCount, columnCount } = target.sheet.properties.gridProperties;
  const { r0, c0, r1, c1 } = bounds(target);
  return r0 <= r1 && c0 <= c1 && r1 < rowCount && c1 < columnCount;
}

// ---------- values ----------

const isEmpty = (c: Cell | undefined) => c === undefined || c === "";

/** Drops trailing empty cells of each row and trailing empty rows. */
function trim(grid: Grid): Grid {
  const rows = grid.map((row) => {
    let end = row.length;
    while (end > 0 && isEmpty(row[end - 1])) end--;
    return row.slice(0, end);
  });
  while (rows.length > 0 && rows[rows.length - 1]?.length === 0) rows.pop();
  return rows;
}

async function loadGrid(ctx: FakeContext, id: string, sheetId: number): Promise<Grid> {
  return (await ctx.store.get<ValuesRecord>(valuesKey(ctx.email, id, sheetId)))?.values ?? [];
}

const saveGrid = (ctx: FakeContext, id: string, sheetId: number, grid: Grid) =>
  ctx.store.put(valuesKey(ctx.email, id, sheetId), { values: trim(grid) });

function formatted(c: Cell | undefined): string {
  if (c === undefined) return "";
  if (typeof c === "boolean") return c ? "TRUE" : "FALSE";
  return String(c);
}

/** USER_ENTERED parses numbers and booleans like typing into a cell; RAW keeps the value as given. */
function entered(value: unknown, parse: boolean): Cell {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = String(value);
  if (!parse) return text;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  return text;
}

async function loadBook(ctx: FakeContext, id: string): Promise<SpreadsheetRecord | undefined> {
  return ctx.store.get<SpreadsheetRecord>(spreadsheetKey(ctx.email, id));
}

// ---------- handlers ----------

async function createSpreadsheet(ctx: FakeContext): Promise<Response> {
  let body: unknown;
  try {
    body = JSON.parse((await ctx.req.text()) || "{}");
  } catch {
    return badRequest("Invalid JSON payload received.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return badRequest("Invalid JSON payload received.");
  const input = body as { properties?: { title?: unknown }; sheets?: unknown };
  const title = input.properties?.title;
  if (title !== undefined && typeof title !== "string") return badRequest("Invalid value at 'spreadsheet.properties.title'");
  const titles: string[] = [];
  if (input.sheets !== undefined) {
    if (!Array.isArray(input.sheets) || input.sheets.length > MAX_SHEETS) return badRequest("Invalid value at 'spreadsheet.sheets'");
    for (const s of input.sheets as Array<{ properties?: { title?: unknown } }>) {
      const t = s?.properties?.title ?? `Sheet${titles.length + 1}`;
      if (typeof t !== "string" || t === "" || titles.includes(t)) return badRequest("Invalid or duplicate sheet title");
      titles.push(t);
    }
  }
  if (titles.length === 0) titles.push("Sheet1");
  const id = `1${randomToken(32)}`;
  const book: SpreadsheetRecord = {
    spreadsheetId: id,
    properties: { title: title ?? "Untitled spreadsheet", locale: "en_US", autoRecalc: "ON_CHANGE", timeZone: "Etc/GMT" },
    sheets: titles.map((t, i) => newSheet(i, t, i)),
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`,
  };
  await ctx.store.put(spreadsheetKey(ctx.email, id), book);
  return Response.json(book);
}

async function getSpreadsheet(ctx: FakeContext): Promise<Response> {
  const book = await loadBook(ctx, idOf(ctx));
  return book ? Response.json(book) : notFound(idOf(ctx));
}

async function getValues(ctx: FakeContext): Promise<Response> {
  const id = idOf(ctx);
  const book = await loadBook(ctx, id);
  if (!book) return notFound(id);
  const target = resolveRange(book, rangeOf(ctx));
  if (!target || !withinGrid(target)) return badRequest(`Unable to parse range: ${rangeOf(ctx)}`, "invalidArgument");
  const dimension = ctx.url.searchParams.get("majorDimension") ?? "ROWS";
  if (dimension !== "ROWS") return badRequest("The fake supports majorDimension ROWS only.", "invalidArgument");
  const render = ctx.url.searchParams.get("valueRenderOption") ?? "FORMATTED_VALUE";
  if (!["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"].includes(render)) return badRequest(`Invalid valueRenderOption: ${render}`, "invalidArgument");

  const { r0, c0, r1, c1 } = bounds(target);
  const grid = await loadGrid(ctx, id, target.sheet.properties.sheetId);
  const slice = trim(grid.slice(r0, r1 + 1).map((row) => row.slice(c0, c1 + 1)));
  const out: Record<string, JsonValue> = { range: formatRange(target.sheet, r0, c0, r1, c1), majorDimension: "ROWS" };
  if (slice.length > 0) out.values = slice.map((row) => row.map((c) => (render === "FORMATTED_VALUE" ? formatted(c) : c)));
  return Response.json(out);
}

async function appendValues(ctx: FakeContext): Promise<Response> {
  const id = idOf(ctx);
  const book = await loadBook(ctx, id);
  if (!book) return notFound(id);
  const option = ctx.url.searchParams.get("valueInputOption");
  if (option === null) return badRequest("'valueInputOption' is required but not specified", "required");
  if (option !== "RAW" && option !== "USER_ENTERED") return badRequest(`Invalid value for valueInputOption: ${option}`, "invalidArgument");
  const insert = ctx.url.searchParams.get("insertDataOption");
  if (insert !== null && insert !== "OVERWRITE" && insert !== "INSERT_ROWS") return badRequest(`Invalid value for insertDataOption: ${insert}`, "invalidArgument");
  const target = resolveRange(book, rangeOf(ctx));
  if (!target || !withinGrid(target)) return badRequest(`Unable to parse range: ${rangeOf(ctx)}`, "invalidArgument");

  let body: unknown;
  try {
    body = JSON.parse((await ctx.req.text()) || "{}");
  } catch {
    return badRequest("Invalid JSON payload received.");
  }
  const rows = (body as { values?: unknown } | null)?.values;
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every((r) => Array.isArray(r))) return badRequest("Invalid values[][]: expected a non-empty list of rows.");
  const cells: Grid = (rows as unknown[][]).map((r) => r.map((v) => entered(v, option === "USER_ENTERED")));
  const width = Math.max(...cells.map((r) => r.length));
  if (width === 0) return badRequest("Invalid values[][]: rows are empty.");

  const sheet = target.sheet.properties;
  const grid = await loadGrid(ctx, id, sheet.sheetId);
  const lastRow = trim(grid).length; // rows holding data; the new rows start right after
  const col0 = target.rect.c0 ?? 0;
  const tableWidth = Math.max(0, ...trim(grid).map((r) => r.length));
  const out: Record<string, JsonValue> = { spreadsheetId: id };
  if (lastRow > 0) out.tableRange = formatRange(target.sheet, 0, col0, lastRow - 1, Math.max(col0, tableWidth - 1));

  const next = grid.map((r) => [...r]);
  cells.forEach((row, i) => {
    const line = (next[lastRow + i] ??= []);
    while (line.length < col0) line.push("");
    row.forEach((c, j) => {
      line[col0 + j] = c;
    });
  });
  if (lastRow + cells.length > sheet.gridProperties.rowCount) {
    sheet.gridProperties.rowCount = lastRow + cells.length;
    await ctx.store.put(spreadsheetKey(ctx.email, id), book);
  }
  await saveGrid(ctx, id, sheet.sheetId, next);
  out.updates = {
    spreadsheetId: id,
    updatedRange: formatRange(target.sheet, lastRow, col0, lastRow + cells.length - 1, col0 + width - 1),
    updatedRows: cells.length,
    updatedColumns: width,
    updatedCells: cells.length * width,
  };
  return Response.json(out);
}

async function clearValues(ctx: FakeContext): Promise<Response> {
  const id = idOf(ctx);
  const book = await loadBook(ctx, id);
  if (!book) return notFound(id);
  const target = resolveRange(book, rangeOf(ctx));
  if (!target || !withinGrid(target)) return badRequest(`Unable to parse range: ${rangeOf(ctx)}`, "invalidArgument");
  const { r0, c0, r1, c1 } = bounds(target);
  const sheetId = target.sheet.properties.sheetId;
  const grid = (await loadGrid(ctx, id, sheetId)).map((r) => [...r]);
  for (let r = r0; r <= Math.min(r1, grid.length - 1); r++) {
    const row = grid[r];
    if (!row) continue;
    for (let c = c0; c <= Math.min(c1, row.length - 1); c++) row[c] = "";
  }
  await saveGrid(ctx, id, sheetId, grid);
  return Response.json({ spreadsheetId: id, clearedRange: formatRange(target.sheet, r0, c0, r1, c1) });
}

// ---------- routes ----------

const G = "https://www.googleapis.com/auth/";
const V4 = "^/sheets\\.googleapis\\.com/v4/spreadsheets";
const ID = "([^/]+)";
const RANGE = "([^/]+)";

/** Scopes per route: the Discovery `scopes` of the method (checked against the generated SDK in tests). */
const SCOPES = {
  create: [`${G}drive`, `${G}drive.file`, `${G}spreadsheets`],
  read: [`${G}drive`, `${G}drive.file`, `${G}drive.readonly`, `${G}spreadsheets`, `${G}spreadsheets.readonly`],
  write: [`${G}drive`, `${G}drive.file`, `${G}spreadsheets`],
};

export const routes: FakeRoute[] = [
  { method: "POST", pattern: new RegExp(`${V4}$`), scopes: SCOPES.create, handle: createSpreadsheet },
  { method: "GET", pattern: new RegExp(`${V4}/${ID}$`), scopes: SCOPES.read, handle: getSpreadsheet },
  { method: "GET", pattern: new RegExp(`${V4}/${ID}/values/${RANGE}$`), scopes: SCOPES.read, handle: getValues },
  { method: "POST", pattern: new RegExp(`${V4}/${ID}/values/${RANGE}:append$`), scopes: SCOPES.write, handle: appendValues },
  { method: "POST", pattern: new RegExp(`${V4}/${ID}/values/${RANGE}:clear$`), scopes: SCOPES.write, handle: clearValues },
];

// ---------- seed preset ----------

const SEED_ID = "seed-sheet-budget";

export const presets: SeedPresets = {
  default: [
    {
      key: `sheets:spreadsheet:{email}:${SEED_ID}`,
      value: {
        spreadsheetId: SEED_ID,
        properties: { title: "Budget", locale: "en_US", autoRecalc: "ON_CHANGE", timeZone: "Asia/Saigon" },
        sheets: [newSheet(0, "Sheet1", 0)],
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${SEED_ID}/edit`,
      },
    },
    { key: `sheets:values:{email}:${SEED_ID}/0`, value: { values: [["Item", "Amount"], ["Coffee", 4]] } },
  ],
};
