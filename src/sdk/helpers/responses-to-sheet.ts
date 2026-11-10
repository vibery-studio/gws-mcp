import { z } from "zod";
import type { FnDef } from "../../contracts";
import { GwsError } from "../../errors";

const Ref = z.string().min(1).max(320);

const InputSchema = z.strictObject({
  account: Ref.optional(),
  formId: z.string().min(1).max(256),
  spreadsheetId: z.string().min(1).max(256),
  range: z.string().min(1).max(256).default("A1"),
  // Responses per read call. Google's maximum when omitted; lower it when a page of large responses exceeds the response size limit.
  pageSize: z.number().int().min(1).max(5000).optional(),
});
type Input = z.output<typeof InputSchema>;

const Planned = z.strictObject({ applied: z.literal(false), step: z.string(), responses: z.number().int() });
const Copied = z.strictObject({
  applied: z.literal(true),
  spreadsheetId: z.string(),
  responses: z.number().int(),
  updatedRange: z.string().optional(),
  updatedRows: z.number().int().optional(),
});
const OutputSchema = z.union([Planned, Copied]);
type Output = z.output<typeof OutputSchema>;

const Question = z.looseObject({ questionId: z.string().optional(), rowQuestion: z.looseObject({ title: z.string().optional() }).optional() });
const Form = z.looseObject({
  items: z
    .array(
      z.looseObject({
        title: z.string().optional(),
        questionItem: z.looseObject({ question: Question.optional() }).optional(),
        questionGroupItem: z.looseObject({ questions: z.array(Question).optional() }).optional(),
      }),
    )
    .optional(),
});
const Answer = z.looseObject({
  textAnswers: z.looseObject({ answers: z.array(z.looseObject({ value: z.string().optional() })).optional() }).optional(),
  fileUploadAnswers: z
    .looseObject({ answers: z.array(z.looseObject({ fileId: z.string().optional(), fileName: z.string().optional() })).optional() })
    .optional(),
});
const ResponsePage = z.looseObject({
  responses: z
    .array(
      z.looseObject({
        createTime: z.string().optional(),
        lastSubmittedTime: z.string().optional(),
        respondentEmail: z.string().optional(),
        answers: z.record(z.string(), Answer).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});
type FormResponse = NonNullable<z.output<typeof ResponsePage>["responses"]>[number];
const AppendResponse = z.looseObject({
  spreadsheetId: z.string().optional(),
  updates: z.looseObject({ updatedRange: z.string().optional(), updatedRows: z.number().int().optional() }).optional(),
});

interface Column {
  questionId: string;
  title: string;
}

/** One column per question in form order; a grid question gives one column per row ("Item [Row]"). */
function columns(form: z.output<typeof Form>): Column[] {
  const out: Column[] = [];
  for (const item of form.items ?? []) {
    const title = item.title ?? "";
    const id = item.questionItem?.question?.questionId;
    if (id !== undefined) out.push({ questionId: id, title });
    for (const q of item.questionGroupItem?.questions ?? []) {
      if (q.questionId !== undefined) out.push({ questionId: q.questionId, title: `${title} [${q.rowQuestion?.title ?? ""}]` });
    }
  }
  return out;
}

/** Several answers (checkboxes, uploads) are joined with ", ", as in Google's own response sheet. */
function cell(answer: z.output<typeof Answer> | undefined): string {
  if (answer === undefined) return "";
  const text = answer.textAnswers?.answers?.map((a) => a.value ?? "") ?? [];
  const files = answer.fileUploadAnswers?.answers?.map((a) => a.fileName ?? a.fileId ?? "") ?? [];
  return [...text, ...files].join(", ");
}

function row(response: FormResponse, cols: readonly Column[]): string[] {
  return [
    response.lastSubmittedTime ?? response.createTime ?? "",
    response.respondentEmail ?? "",
    ...cols.map((c) => cell(response.answers?.[c.questionId])),
  ];
}

const def: FnDef<Input, Output> = {
  kind: "host",
  name: "forms.responsesToSheet",
  service: "helpers",
  effect: "write",
  description:
    "Copies all responses of a Google Form into a Google Sheet: one header row (Timestamp, Email Address, then the question titles) and one row per response, appended after the table at range (default: the first sheet). Values are written as plain text, never as formulas. The form and its responses are read in a dry-run too, which plans the append; apply:true writes it.",
  signature:
    "forms.responsesToSheet({ formId: string, spreadsheetId: string, range?: string, pageSize?: number, account?: string }): Promise<{ applied: false, step: string, responses: number } | { applied: true, spreadsheetId: string, responses: number, updatedRange?: string, updatedRows?: number }>",
  tsDecl: [
    "type Input = {",
    "  formId: string;",
    "  spreadsheetId: string;",
    '  range?: string; // sheet or A1 range that locates the table, e.g. "Responses"; default "A1" (first sheet)',
    "  pageSize?: number; // responses per read call, 1-5000; default Google's maximum",
    "  account?: string;",
    "};",
    "type Output = { applied: false; step: string; responses: number } // dry-run: re-run with apply:true",
    "  | { applied: true; spreadsheetId: string; responses: number; updatedRange?: string; updatedRows?: number };",
  ].join("\n"),
  example: 'await sdk.forms.responsesToSheet({ formId: "<formId>", spreadsheetId: "<spreadsheetId>", range: "Responses" })',
  tags: ["helpers", "forms", "form", "responses", "survey", "export", "sheets", "spreadsheet", "copy", "write"],
  scopes: [
    "https://www.googleapis.com/auth/forms.body",
    "https://www.googleapis.com/auth/forms.responses.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
  ],
  input: InputSchema,
  output: OutputSchema,
  async run(input, ctx) {
    const { account, formId, spreadsheetId, range, pageSize } = input;
    const acct = account === undefined ? {} : { account };

    const form = Form.safeParse(await ctx.call("forms.forms.get", { formId, ...acct }));
    if (!form.success) throw new GwsError("GWS_RESPONSE_SHAPE", "forms.forms.get returned an unexpected shape");
    const cols = columns(form.data);

    // Each page is one dispatcher call, so the per-execute call budget bounds the loop.
    const responses: FormResponse[] = [];
    let pageToken: string | undefined;
    do {
      const page = ResponsePage.safeParse(
        await ctx.call("forms.forms.responses.list", {
          formId,
          ...(pageSize === undefined ? {} : { pageSize }),
          ...(pageToken === undefined ? {} : { pageToken }),
          ...acct,
        }),
      );
      if (!page.success) throw new GwsError("GWS_RESPONSE_SHAPE", "forms.forms.responses.list returned an unexpected shape");
      responses.push(...(page.data.responses ?? []));
      pageToken = page.data.nextPageToken || undefined;
    } while (pageToken !== undefined);

    const values = [["Timestamp", "Email Address", ...cols.map((c) => c.title)], ...responses.map((r) => row(r, cols))];
    const res = await ctx.call("sheets.spreadsheets.values.append", {
      spreadsheetId,
      range,
      // Respondents control the answers: RAW keeps "=..." from being parsed as a formula.
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
      ...acct,
    });
    if (typeof res === "object" && res !== null && "__gwsPending" in res) {
      return { applied: false, step: String(res.__gwsPending), responses: responses.length };
    }
    const parsed = AppendResponse.safeParse(res);
    if (!parsed.success) throw new GwsError("GWS_RESPONSE_SHAPE", "sheets.spreadsheets.values.append returned an unexpected shape");
    const { updates } = parsed.data;
    return {
      applied: true,
      spreadsheetId: parsed.data.spreadsheetId ?? spreadsheetId,
      responses: responses.length,
      ...(updates?.updatedRange === undefined ? {} : { updatedRange: updates.updatedRange }),
      ...(updates?.updatedRows === undefined ? {} : { updatedRows: updates.updatedRows }),
    };
  },
};

// The registry holds FnDef<unknown>; this definition is typed with its own input and output.
export const responsesToSheet = def as FnDef;
