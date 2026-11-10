import { z } from "zod";
import type { FnDef } from "../../contracts";
import { GwsError } from "../../errors";

const Ref = z.string().min(1).max(320);

const InputSchema = z.strictObject({
  account: Ref.optional(),
  title: z.string().min(1).max(1024),
  notes: z.string().max(8192).optional(),
  // Google Tasks keeps only the date part of `due`; a bare date is sent as midnight UTC.
  due: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
  tasklist: z.string().min(1).max(256).default("@default"),
});
type Input = z.output<typeof InputSchema>;

const Planned = z.strictObject({ applied: z.literal(false), step: z.string() });
const Added = z.strictObject({
  applied: z.literal(true),
  id: z.string(),
  title: z.string(),
  status: z.string().optional(),
  notes: z.string().optional(),
  due: z.string().optional(),
  webViewLink: z.string().optional(),
});
const OutputSchema = z.union([Planned, Added]);
type Output = z.output<typeof OutputSchema>;

const Task = z.looseObject({
  id: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
  notes: z.string().optional(),
  due: z.string().optional(),
  webViewLink: z.string().optional(),
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const def: FnDef<Input, Output> = {
  kind: "host",
  name: "tasks.addTask",
  service: "helpers",
  effect: "write",
  description:
    "Adds a task (to-do) to Google Tasks, to the default task list unless tasklist is given. due is a date (YYYY-MM-DD) or an RFC 3339 timestamp; Google keeps only the date. Dry-run plans the insert; apply:true creates it.",
  signature:
    "tasks.addTask({ title: string, notes?: string, due?: string, tasklist?: string, account?: string }): Promise<{ applied: false, step: string } | { applied: true, id: string, title: string, status?: string, due?: string, webViewLink?: string }>",
  tsDecl: [
    "type Input = {",
    "  title: string;",
    "  notes?: string;",
    '  due?: string; // "2026-11-20" or an RFC 3339 timestamp; only the date is kept',
    '  tasklist?: string; // task list id; default "@default" (the user\'s default list)',
    "  account?: string;",
    "};",
    "type Output = { applied: false; step: string } // dry-run: re-run with apply:true",
    "  | { applied: true; id: string; title: string; status?: string; notes?: string; due?: string; webViewLink?: string };",
  ].join("\n"),
  example: 'await sdk.tasks.addTask({ title: "Send the invoice", due: "2026-11-20" })',
  tags: ["helpers", "tasks", "task", "todo", "add", "create", "reminder", "write"],
  scopes: ["https://www.googleapis.com/auth/tasks"],
  input: InputSchema,
  output: OutputSchema,
  async run(input, ctx) {
    const { account, title, notes, due, tasklist } = input;
    const res = await ctx.call("tasks.tasks.insert", {
      tasklist,
      requestBody: {
        title,
        ...(notes === undefined ? {} : { notes }),
        ...(due === undefined ? {} : { due: DATE_ONLY.test(due) ? `${due}T00:00:00.000Z` : due }),
      },
      ...(account === undefined ? {} : { account }),
    });
    if (typeof res === "object" && res !== null && "__gwsPending" in res) return { applied: false, step: String(res.__gwsPending) };
    const task = Task.safeParse(res);
    if (!task.success) throw new GwsError("GWS_RESPONSE_SHAPE", "tasks.tasks.insert returned no task id");
    const t = task.data;
    return {
      applied: true,
      id: t.id,
      title: t.title ?? title,
      ...(t.status === undefined ? {} : { status: t.status }),
      ...(t.notes === undefined ? {} : { notes: t.notes }),
      ...(t.due === undefined ? {} : { due: t.due }),
      ...(t.webViewLink === undefined ? {} : { webViewLink: t.webViewLink }),
    };
  },
};

// The registry holds FnDef<unknown>; this definition is typed with its own input and output.
export const addTask = def as FnDef;
