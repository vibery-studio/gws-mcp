import { z } from "zod";
import { PENDING_TOKEN_PREFIX, type FnDef } from "../../contracts";
import { GwsError } from "../../errors";

const Ref = z.string().min(1).max(320);
// A key is the text between "{{" and "}}" in the template, so it cannot hold braces itself.
const Key = z.string().min(1).max(100).regex(/^[^{}]+$/, "a key holds no braces: use name for {{name}}");

const InputSchema = z.strictObject({
  account: Ref.optional(),
  templateId: z.string().min(1).max(256),
  values: z
    .record(Key, z.string().max(10_000))
    .refine((v) => Object.keys(v).length >= 1, "give at least one value")
    .refine((v) => Object.keys(v).length <= 200, "at most 200 values"),
  copyTitle: z.string().min(1).max(255).optional(),
});
type Input = z.output<typeof InputSchema>;

const Planned = z.strictObject({ applied: z.literal(false), steps: z.array(z.string()) });
const Filled = z.strictObject({
  applied: z.literal(true),
  presentationId: z.string(),
  name: z.string().optional(),
  webViewLink: z.string().optional(),
  replaced: z.record(z.string(), z.number().int()),
});
const OutputSchema = z.union([Planned, Filled]);
type Output = z.output<typeof OutputSchema>;

const DriveFile = z.looseObject({ id: z.string(), name: z.string().optional(), webViewLink: z.string().optional() });
const BatchUpdateResponse = z.looseObject({
  replies: z.array(z.looseObject({ replaceAllText: z.looseObject({ occurrencesChanged: z.number().int().optional() }).optional() })).optional(),
});

const isPending = (v: unknown): v is { __gwsPending: string } => typeof v === "object" && v !== null && "__gwsPending" in v;

const def: FnDef<Input, Output> = {
  kind: "host",
  name: "slides.fillTemplate",
  service: "helpers",
  effect: "write",
  description:
    "Fills a Google Slides template: copies the presentation (named copyTitle), then replaces every {{key}} in the copy with values[key] (case-sensitive). The template itself is never changed. Dry-run plans the copy and the fill (marked incomplete: it needs the copy's id); apply:true runs both. If the fill fails, the copy remains.",
  signature:
    "slides.fillTemplate({ templateId: string, values: Record<string, string>, copyTitle?: string, account?: string }): Promise<{ applied: false, steps: string[] } | { applied: true, presentationId: string, name?: string, webViewLink?: string, replaced: Record<string, number> }>",
  tsDecl: [
    "type Input = {",
    "  templateId: string; // presentation (Drive file) id of the template",
    '  values: Record<string, string>; // { name: "Dana" } replaces every "{{name}}"; keys hold no braces',
    "  copyTitle?: string; // name of the copy; Google's default (\"Copy of ...\") when omitted",
    "  account?: string;",
    "};",
    "type Output = { applied: false; steps: string[] } // dry-run: re-run with apply:true",
    "  | { applied: true; presentationId: string; name?: string; webViewLink?: string; replaced: Record<string, number> }; // replaced: occurrences per key",
  ].join("\n"),
  example: 'await sdk.slides.fillTemplate({ templateId: "<presentationId>", values: { name: "Dana", date: "10 Nov 2026" }, copyTitle: "Certificate for Dana" })',
  tags: ["helpers", "slides", "presentation", "deck", "template", "fill", "replace", "placeholders", "copy", "write"],
  scopes: ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/presentations"],
  input: InputSchema,
  output: OutputSchema,
  async run(input, ctx) {
    const { account, templateId, values, copyTitle } = input;
    const acct = account === undefined ? {} : { account };
    const keys = Object.keys(values);

    const copied = await ctx.call("drive.files.copy", {
      fileId: templateId,
      ...(copyTitle === undefined ? {} : { requestBody: { name: copyTitle } }),
      fields: "id,name,webViewLink",
      ...acct,
    });
    let presentationId: string;
    let file: z.output<typeof DriveFile> | undefined;
    if (isPending(copied)) {
      // Dry-run: the fill names the unexecuted copy, so the dispatcher plans it as incomplete and never sends it.
      presentationId = `${PENDING_TOKEN_PREFIX}${copied.__gwsPending}.id`;
    } else {
      const parsed = DriveFile.safeParse(copied);
      if (!parsed.success) throw new GwsError("GWS_RESPONSE_SHAPE", "drive.files.copy returned no file id");
      file = parsed.data;
      presentationId = file.id;
    }

    const filled = await ctx.call("slides.presentations.batchUpdate", {
      presentationId,
      requestBody: {
        requests: keys.map((key) => ({ replaceAllText: { containsText: { text: `{{${key}}}`, matchCase: true }, replaceText: values[key] } })),
      },
      ...acct,
    });
    if (isPending(filled)) return { applied: false, steps: isPending(copied) ? [copied.__gwsPending, filled.__gwsPending] : [filled.__gwsPending] };
    if (file === undefined) throw new GwsError("GWS_INTERNAL", "the fill ran before its copy");

    const res = BatchUpdateResponse.safeParse(filled);
    if (!res.success) throw new GwsError("GWS_RESPONSE_SHAPE", "slides.presentations.batchUpdate returned an unexpected shape");
    // Replies are in request order; Google omits occurrencesChanged when nothing matched.
    const replies = res.data.replies ?? [];
    const replaced = Object.fromEntries(keys.map((key, i) => [key, replies[i]?.replaceAllText?.occurrencesChanged ?? 0]));
    return {
      applied: true,
      presentationId: file.id,
      ...(file.name === undefined ? {} : { name: file.name }),
      ...(file.webViewLink === undefined ? {} : { webViewLink: file.webViewLink }),
      replaced,
    };
  },
};

// The registry holds FnDef<unknown>; this definition is typed with its own input and output.
export const fillTemplate = def as FnDef;
