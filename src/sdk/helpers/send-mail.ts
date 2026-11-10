import { z } from "zod";
import type { FnDef } from "../../contracts";
import { GwsError } from "../../errors";
import { buildMime, toRaw } from "./mime";

const Ref = z.string().min(1).max(320);

const Attachment = z.strictObject({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(3).max(127),
  dataBase64: z.string(),
});

const InputSchema = z
  .strictObject({
    account: Ref.optional(),
    to: z.array(z.string().min(3).max(254)).min(1).max(100),
    cc: z.array(z.string().min(3).max(254)).max(100).optional(),
    subject: z.string().max(500),
    text: z.string().optional(),
    html: z.string().optional(),
    attachments: z.array(Attachment).min(1).max(20),
  })
  .refine((i) => i.text !== undefined || i.html !== undefined, { message: "a text or html body is required", path: ["text"] });
type Input = z.output<typeof InputSchema>;

const Planned = z.strictObject({ applied: z.literal(false), step: z.string() });
const Sent = z.strictObject({ applied: z.literal(true), id: z.string(), threadId: z.string().optional(), labelIds: z.array(z.string()).optional() });
const OutputSchema = z.union([Planned, Sent]);
type Output = z.output<typeof OutputSchema>;

const GmailMessage = z.looseObject({ id: z.string(), threadId: z.string().optional(), labelIds: z.array(z.string()).optional() });

const def: FnDef<Input, Output> = {
  kind: "host",
  name: "helpers.sendMailWithAttachment",
  service: "helpers",
  effect: "write",
  description:
    "Sends an email with one or more file attachments through Gmail: builds a safe MIME message (UTF-8 subject, base64 attachments, up to 25 MB) and sends it as the account. Dry-run plans the send; apply:true sends it.",
  signature:
    "helpers.sendMailWithAttachment({ to: string[], cc?: string[], subject: string, text?: string, html?: string, attachments: { filename: string, mimeType: string, dataBase64: string }[], account?: string }): Promise<{ applied: false, step: string } | { applied: true, id: string, threadId?: string, labelIds?: string[] }>",
  tsDecl: [
    "type Input = {",
    "  to: string[]; // bare addresses like user@example.com",
    "  cc?: string[];",
    "  subject: string;",
    "  text?: string; // text or html (or both) is required",
    "  html?: string;",
    "  attachments: { filename: string; mimeType: string; dataBase64: string }[]; // 1 to 20, mimeType without parameters",
    "  account?: string;",
    "};",
    "type Output = { applied: false; step: string } // dry-run: re-run with apply:true",
    "  | { applied: true; id: string; threadId?: string; labelIds?: string[] };",
  ].join("\n"),
  example:
    'await sdk.helpers.sendMailWithAttachment({ to: ["bob@example.com"], subject: "Report", text: "Attached.", attachments: [{ filename: "report.pdf", mimeType: "application/pdf", dataBase64: "<base64>" }] })',
  tags: ["helpers", "gmail", "email", "mail", "send", "attachment", "attach", "compose", "write"],
  scopes: ["https://www.googleapis.com/auth/gmail.send"],
  input: InputSchema,
  output: OutputSchema,
  async run(input, ctx) {
    const { account, to, cc, subject, text, html, attachments } = input;
    const mime = buildMime({ to, subject, attachments, ...(cc ? { cc } : {}), ...(text !== undefined ? { text } : {}), ...(html !== undefined ? { html } : {}) });
    const sent = await ctx.call("gmail.users.messages.send", {
      userId: "me",
      requestBody: { raw: toRaw(mime) },
      ...(account === undefined ? {} : { account }),
    });
    if (typeof sent === "object" && sent !== null && "__gwsPending" in sent) return { applied: false, step: String(sent.__gwsPending) };
    const message = GmailMessage.safeParse(sent);
    if (!message.success) throw new GwsError("GWS_RESPONSE_SHAPE", "gmail.users.messages.send returned no message id");
    const { id, threadId, labelIds } = message.data;
    return { applied: true, id, ...(threadId === undefined ? {} : { threadId }), ...(labelIds === undefined ? {} : { labelIds }) };
  },
};

// The registry holds FnDef<unknown>; this definition is typed with its own input and output.
export const sendMailWithAttachment = def as FnDef;
