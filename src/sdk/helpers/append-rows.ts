import { z } from "zod";
import type { FnDef } from "../../contracts";
import { GwsError } from "../../errors";

const Ref = z.string().min(1).max(320);
const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const InputSchema = z.strictObject({
  account: Ref.optional(),
  spreadsheetId: z.string().min(1).max(256),
  range: z.string().min(1).max(256),
  rows: z.array(z.array(Cell).max(1000)).min(1).max(10_000),
  valueInputOption: z.enum(["USER_ENTERED", "RAW"]).default("USER_ENTERED"),
});
type Input = z.output<typeof InputSchema>;

const Planned = z.strictObject({ applied: z.literal(false), step: z.string() });
const Appended = z.strictObject({
  applied: z.literal(true),
  spreadsheetId: z.string(),
  tableRange: z.string().optional(),
  updatedRange: z.string().optional(),
  updatedRows: z.number().int().optional(),
  updatedColumns: z.number().int().optional(),
  updatedCells: z.number().int().optional(),
});
const OutputSchema = z.union([Planned, Appended]);
type Output = z.output<typeof OutputSchema>;

const AppendResponse = z.looseObject({
  spreadsheetId: z.string().optional(),
  tableRange: z.string().optional(),
  updates: z
    .looseObject({
      updatedRange: z.string().optional(),
      updatedRows: z.number().int().optional(),
      updatedColumns: z.number().int().optional(),
      updatedCells: z.number().int().optional(),
    })
    .optional(),
});

const def: FnDef<Input, Output> = {
  kind: "host",
  name: "helpers.appendSheetRows",
  service: "helpers",
  effect: "write",
  description:
    "Appends rows after the last row of a Google Sheet table (range like \"Sheet1\" or \"Sheet1!A1\"). Numbers, booleans and strings are written as typed; with USER_ENTERED (default) strings are parsed like typing into a cell. Dry-run plans the append; apply:true writes it.",
  signature:
    "helpers.appendSheetRows({ spreadsheetId: string, range: string, rows: (string | number | boolean | null)[][], valueInputOption?: \"USER_ENTERED\" | \"RAW\", account?: string }): Promise<{ applied: false, step: string } | { applied: true, spreadsheetId: string, updatedRange?: string, updatedRows?: number }>",
  tsDecl: [
    "type Input = {",
    "  spreadsheetId: string;",
    '  range: string; // sheet or A1 range that locates the table, e.g. "Sheet1" or "Sheet1!A1"',
    "  rows: (string | number | boolean | null)[][]; // null leaves a cell empty",
    '  valueInputOption?: "USER_ENTERED" | "RAW"; // default USER_ENTERED',
    "  account?: string;",
    "};",
    "type Output = { applied: false; step: string } // dry-run: re-run with apply:true",
    "  | { applied: true; spreadsheetId: string; tableRange?: string; updatedRange?: string; updatedRows?: number; updatedColumns?: number; updatedCells?: number };",
  ].join("\n"),
  example: 'await sdk.helpers.appendSheetRows({ spreadsheetId: "<spreadsheetId>", range: "Sheet1", rows: [["Tea", 3, true]] })',
  tags: ["helpers", "sheets", "spreadsheet", "append", "rows", "add", "row", "write"],
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  input: InputSchema,
  output: OutputSchema,
  async run(input, ctx) {
    const { account, spreadsheetId, range, rows, valueInputOption } = input;
    const res = await ctx.call("sheets.spreadsheets.values.append", {
      spreadsheetId,
      range,
      valueInputOption,
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
      ...(account === undefined ? {} : { account }),
    });
    if (typeof res === "object" && res !== null && "__gwsPending" in res) return { applied: false, step: String(res.__gwsPending) };
    const parsed = AppendResponse.safeParse(res);
    if (!parsed.success) throw new GwsError("GWS_RESPONSE_SHAPE", "sheets.spreadsheets.values.append returned an unexpected shape");
    const { tableRange, updates } = parsed.data;
    return {
      applied: true,
      spreadsheetId: parsed.data.spreadsheetId ?? spreadsheetId,
      ...(tableRange === undefined ? {} : { tableRange }),
      ...(updates?.updatedRange === undefined ? {} : { updatedRange: updates.updatedRange }),
      ...(updates?.updatedRows === undefined ? {} : { updatedRows: updates.updatedRows }),
      ...(updates?.updatedColumns === undefined ? {} : { updatedColumns: updates.updatedColumns }),
      ...(updates?.updatedCells === undefined ? {} : { updatedCells: updates.updatedCells }),
    };
  },
};

// The registry holds FnDef<unknown>; this definition is typed with its own input and output.
export const appendSheetRows = def as FnDef;
