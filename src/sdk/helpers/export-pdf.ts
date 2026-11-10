import { z } from "zod";
import type { FnDef } from "../../contracts";
import { GwsError } from "../../errors";

const Ref = z.string().min(1).max(320);

const InputSchema = z.strictObject({
  account: Ref.optional(),
  documentId: z.string().min(1).max(256),
});
type Input = z.output<typeof InputSchema>;

const OutputSchema = z.strictObject({
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  dataBase64: z.string(),
});
type Output = z.output<typeof OutputSchema>;

const def: FnDef<Input, Output> = {
  kind: "host",
  name: "helpers.exportDocPdf",
  service: "helpers",
  effect: "read",
  description:
    "Exports a Google Doc as a PDF and returns its bytes as base64 (mimeType, sizeBytes, dataBase64). Fails with GWS_RESPONSE_TOO_LARGE when the PDF is over the response size limit.",
  signature: "helpers.exportDocPdf({ documentId: string, account?: string }): Promise<{ mimeType: string, sizeBytes: number, dataBase64: string }>",
  tsDecl: [
    "type Input = { documentId: string; account?: string };",
    'type Output = { mimeType: "application/pdf"; sizeBytes: number; dataBase64: string };',
  ].join("\n"),
  example: 'await sdk.helpers.exportDocPdf({ documentId: "<documentId>" })',
  tags: ["helpers", "docs", "document", "export", "pdf", "download", "drive", "read"],
  scopes: ["https://www.googleapis.com/auth/drive.file"],
  input: InputSchema,
  output: OutputSchema,
  async run(input, ctx) {
    const { account, documentId } = input;
    const res = await ctx.call("drive.files.export", {
      fileId: documentId,
      mimeType: "application/pdf",
      ...(account === undefined ? {} : { account }),
    });
    const parsed = OutputSchema.safeParse(res);
    if (!parsed.success) throw new GwsError("GWS_RESPONSE_SHAPE", "drive.files.export returned an unexpected shape");
    return parsed.data;
  },
};

// The registry holds FnDef<unknown>; this definition is typed with its own input and output.
export const exportDocPdf = def as FnDef;
