import { z } from "zod";
import type { FnDef } from "../../contracts";
import { GwsError } from "../../errors";

const Ref = z.string().min(1).max(320);

const InputSchema = z
  .strictObject({
    account: Ref.optional(),
    name: z.string().min(1).max(255),
    mimeType: z.string().min(3).max(255),
    dataBase64: z.string().optional(),
    text: z.string().optional(),
    parents: z.array(z.string().min(1).max(256)).max(10).optional(),
  })
  .refine((i) => (i.dataBase64 === undefined) !== (i.text === undefined), {
    message: "give exactly one of dataBase64 and text",
    path: ["dataBase64"],
  });
type Input = z.output<typeof InputSchema>;

const Planned = z.strictObject({ applied: z.literal(false), step: z.string() });
const Uploaded = z.strictObject({
  applied: z.literal(true),
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  webViewLink: z.string().optional(),
});
const OutputSchema = z.union([Planned, Uploaded]);
type Output = z.output<typeof OutputSchema>;

const DriveFile = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  webViewLink: z.string().optional(),
});

const def: FnDef<Input, Output> = {
  kind: "host",
  name: "helpers.uploadDriveFile",
  service: "helpers",
  effect: "write",
  description:
    "Uploads a file to Google Drive from base64 data or text (up to 5 MB), optionally into folders (parents: folder ids). Returns the file id, name, type and link. Dry-run plans the upload; apply:true stores it.",
  signature:
    "helpers.uploadDriveFile({ name: string, mimeType: string, dataBase64?: string, text?: string, parents?: string[], account?: string }): Promise<{ applied: false, step: string } | { applied: true, id: string, name: string, mimeType: string, webViewLink?: string }>",
  tsDecl: [
    "type Input = {",
    "  name: string;",
    "  mimeType: string;",
    "  dataBase64?: string; // exactly one of dataBase64 and text",
    "  text?: string; // stored as UTF-8",
    "  parents?: string[]; // folder ids; the Drive root when omitted",
    "  account?: string;",
    "};",
    "type Output = { applied: false; step: string } // dry-run: re-run with apply:true",
    "  | { applied: true; id: string; name: string; mimeType: string; webViewLink?: string };",
  ].join("\n"),
  example: 'await sdk.helpers.uploadDriveFile({ name: "notes.txt", mimeType: "text/plain", text: "hello" })',
  tags: ["helpers", "drive", "upload", "file", "create", "store", "save", "write"],
  scopes: ["https://www.googleapis.com/auth/drive.file"],
  input: InputSchema,
  output: OutputSchema,
  async run(input, ctx) {
    const { account, name, mimeType, dataBase64, text, parents } = input;
    const created = await ctx.call("drive.files.create", {
      requestBody: { name, ...(parents === undefined ? {} : { parents }) },
      media: dataBase64 === undefined ? { mimeType, text: text ?? "" } : { mimeType, dataBase64 },
      // Drive v3 returns only a few fields by default; ask for the ones this helper reports.
      fields: "id,name,mimeType,webViewLink",
      ...(account === undefined ? {} : { account }),
    });
    if (typeof created === "object" && created !== null && "__gwsPending" in created) return { applied: false, step: String(created.__gwsPending) };
    const file = DriveFile.safeParse(created);
    if (!file.success) throw new GwsError("GWS_RESPONSE_SHAPE", "drive.files.create returned no file id");
    const { id, webViewLink } = file.data;
    return {
      applied: true,
      id,
      name: file.data.name ?? name,
      mimeType: file.data.mimeType ?? mimeType,
      ...(webViewLink === undefined ? {} : { webViewLink }),
    };
  },
};

// The registry holds FnDef<unknown>; this definition is typed with its own input and output.
export const uploadDriveFile = def as FnDef;
