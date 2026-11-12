import { z } from "zod";
import type { AccessCapability, CallCtx, CapabilityWrite, FnDef } from "../contracts";
import { GwsError } from "../errors";

/**
 * `access.*` host functions: the list of who may use this gws-mcp (exact emails and whole `@domain`s, each `admin` or
 * `user`). They act only through `ctx.access`, bound to the calling user, and every one requires that user to be an
 * admin (else GWS_ACCESS_ADMIN_REQUIRED). Writes are planned in dry-run and run only under apply. Remote only: the
 * local runtime serves one person and has no such list.
 */

const Pattern = z.string().min(2).max(320);
const Role = z.enum(["admin", "user"]);
const RuleSchema = z.strictObject({
  pattern: z.string(),
  kind: z.enum(["email", "domain"]),
  role: Role,
  note: z.string().optional(),
  addedAt: z.string(),
});
const Planned = z.strictObject({ applied: z.literal(false), step: z.string() });

const RULE_TS = 'type Rule = { pattern: string; kind: "email" | "domain"; role: "admin" | "user"; note?: string; addedAt: string };';
const PLANNED_TS = "type Planned = { applied: false; step: string }; // dry-run: re-run with apply:true";

interface Spec<I, O> {
  name: `access.${string}`;
  effect: FnDef["effect"];
  description: string;
  signature: string;
  tsDecl: string;
  example: string;
  tags: string[];
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  run(input: I, access: AccessCapability): Promise<O>;
}

function fn<I, O>(spec: Spec<I, O>): FnDef {
  const def: FnDef<I, O> = {
    kind: "host",
    name: spec.name,
    service: "access",
    effect: spec.effect,
    description: spec.description,
    signature: spec.signature,
    tsDecl: spec.tsDecl,
    example: spec.example,
    tags: ["access", ...spec.tags, spec.effect],
    scopes: [],
    input: spec.input,
    output: spec.output,
    async run(input, ctx: CallCtx) {
      // The dispatcher hands the capability to every access.* fn; without it there is nothing safe to do.
      if (!ctx.access) throw new GwsError("GWS_INTERNAL", "access capability unavailable");
      return spec.run(input, ctx.access);
    },
  };
  return def as FnDef;
}

function rule(r: { pattern: string; kind: "email" | "domain"; role: "admin" | "user"; note?: string; createdAt: number }) {
  return {
    pattern: r.pattern,
    kind: r.kind,
    role: r.role,
    ...(r.note !== undefined ? { note: r.note } : {}),
    addedAt: new Date(r.createdAt).toISOString(),
  };
}

function outcome<T, O>(w: CapabilityWrite<T>, applied: (value: T) => O): O | z.output<typeof Planned> {
  return w.applied ? applied(w.value) : { applied: false, step: w.step };
}

export const accessFns: FnDef[] = [
  fn({
    name: "access.list",
    effect: "read",
    description: "Admins only: lists who may use this gws-mcp, as exact emails and whole @domains, each admin or user.",
    signature: "access.list(): Promise<{ rules: Rule[] }>",
    tsDecl: `type Input = {};\ntype Output = { rules: Rule[] };\n${RULE_TS}`,
    example: "await sdk.access.list()",
    tags: ["list", "allowlist", "who", "users", "admins"],
    input: z.strictObject({}),
    output: z.strictObject({ rules: z.array(RuleSchema) }),
    run: async (_input, access) => ({ rules: (await access.list()).map(rule) }),
  }),

  fn({
    name: "access.add",
    effect: "write",
    description:
      "Admins only: lets an email (name@example.com) or every email of a domain (@example.com) use this gws-mcp, as admin or user; on an existing rule it sets the role. The last admin cannot be made a user.",
    signature:
      'access.add({ pattern: string, role: "admin" | "user", note?: string }): Promise<Planned | { applied: true, outcome: "added" | "role" | "unchanged", rule: Rule }>',
    tsDecl: `type Input = { pattern: string; role: "admin" | "user"; note?: string };\ntype Output = Planned | { applied: true; outcome: "added" | "role" | "unchanged"; rule: Rule };\n${PLANNED_TS}\n${RULE_TS}`,
    example: 'await sdk.access.add({ pattern: "@example.com", role: "user" })',
    tags: ["add", "allow", "allowlist", "invite", "role", "admin"],
    input: z.strictObject({ pattern: Pattern, role: Role, note: z.string().max(200).optional() }),
    output: z.union([Planned, z.strictObject({ applied: z.literal(true), outcome: z.enum(["added", "role", "unchanged"]), rule: RuleSchema })]),
    run: async (input, access) =>
      outcome(await access.add(input.pattern, input.role, input.note), (v) => ({ applied: true as const, outcome: v.outcome, rule: rule(v.rule) })),
  }),

  fn({
    name: "access.remove",
    effect: "write",
    description:
      "Destructive, admins only: removes a rule. Everyone it shuts out can no longer sign in, and their AI apps are cut off at once; `warning` is set when revoking their grants did not finish. The last admin cannot be removed.",
    signature:
      "access.remove({ pattern: string }): Promise<Planned | { applied: true, removed: boolean, usersShutOut: number, appsEnded: number, appsFailed: number, warning?: string }>",
    tsDecl: `type Input = { pattern: string };\ntype Output = Planned | { applied: true; removed: boolean; usersShutOut: number; appsEnded: number; appsFailed: number; warning?: string };\n${PLANNED_TS}`,
    example: 'await sdk.access.remove({ pattern: "old@example.com" })',
    tags: ["remove", "delete", "allowlist", "revoke", "deny"],
    input: z.strictObject({ pattern: Pattern }),
    output: z.union([
      Planned,
      z.strictObject({
        applied: z.literal(true),
        removed: z.boolean(),
        usersShutOut: z.number().int().nonnegative(),
        appsEnded: z.number().int().nonnegative(),
        appsFailed: z.number().int().nonnegative(),
        warning: z.string().optional(),
      }),
    ]),
    run: async (input, access) => outcome(await access.remove(input.pattern), (v) => ({ applied: true as const, ...v })),
  }),
];
