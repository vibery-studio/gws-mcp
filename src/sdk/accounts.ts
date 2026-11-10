import { z } from "zod";
import { GOOGLE_SERVICES, grantedServices, type GoogleService } from "../config";
import type { AccountView, AccountsCapability, CallCtx, CapabilityWrite, FnDef } from "../contracts";
import { GwsError, isGwsError } from "../errors";

/**
 * `accounts.*` host functions. They act only through `ctx.accounts`, the per-session capability bound to
 * the calling user and client: no user, client or account-id parameters, every target in the client's
 * allowlist (else GWS_ACCOUNT_DENIED, whether or not the account exists), writes planned in dry-run and run
 * only under apply. Nothing here adds to an allowlist: `grant` returns a link the user confirms on
 * /connections.
 */

const MAX_REF = 320;
const Ref = z.string().min(1).max(MAX_REF);
const Services = z.array(z.enum(GOOGLE_SERVICES)).min(1).max(GOOGLE_SERVICES.length);

const AccountViewSchema = z.strictObject({
  email: z.string(),
  alias: z.string().optional(),
  isDefault: z.boolean(),
  status: z.enum(["active", "reconnect"]),
  scopes: z.array(z.string()),
});

/** A write in dry-run: the plan step it recorded. Re-run with apply:true to make the change. */
const Planned = z.strictObject({ applied: z.literal(false), step: z.string() });

const ACCOUNT_VIEW_TS = "type AccountView = { email: string; alias?: string; isDefault: boolean; status: \"active\" | \"reconnect\"; scopes: string[] };";
/** Generated from the service list, so the declarations never lag behind the services the SDK has. */
const SERVICE_TS = `type Service = ${GOOGLE_SERVICES.map((s) => JSON.stringify(s)).join(" | ")};`;
const PLANNED_TS = "type Planned = { applied: false; step: string }; // dry-run: re-run with apply:true";

const CONNECT_NOTE =
  "Open this link in a browser signed in to gws-mcp within 10 minutes; it works once. Connecting gives no client access to a new account: the user allows it on /connections.";
const CONFIRM_NOTE = "Only the user can allow this: they open the link, signed in to gws-mcp, choose the account and confirm.";

interface Spec<I, O> {
  name: `accounts.${string}`;
  effect: FnDef["effect"];
  description: string;
  signature: string;
  tsDecl: string;
  example: string;
  tags: string[];
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  run(input: I, accounts: AccountsCapability, ctx: CallCtx): Promise<O>;
}

function fn<I, O>(spec: Spec<I, O>): FnDef {
  const def: FnDef<I, O> = {
    kind: "host",
    name: spec.name,
    service: "accounts",
    effect: spec.effect,
    description: spec.description,
    signature: spec.signature,
    tsDecl: spec.tsDecl,
    example: spec.example,
    tags: ["accounts", ...spec.tags, spec.effect],
    scopes: [],
    input: spec.input,
    output: spec.output,
    async run(input, ctx) {
      // The dispatcher hands the capability to every accounts.* fn; without it there is nothing safe to do.
      if (!ctx.accounts) throw new GwsError("GWS_INTERNAL", "accounts capability unavailable");
      return spec.run(input, ctx.accounts, ctx);
    },
  };
  return def as FnDef;
}

/** Maps a capability write to the fn output: the plan step in dry-run, else `applied(value)`. */
function outcome<T, O>(w: CapabilityWrite<T>, applied: (value: T) => O): O | z.output<typeof Planned> {
  return w.applied ? applied(w.value) : { applied: false, step: w.step };
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

const ServicesMap = z.strictObject(Object.fromEntries(GOOGLE_SERVICES.map((s) => [s, z.boolean()])) as Record<GoogleService, z.ZodBoolean>);
const ListedAccount = AccountViewSchema.extend({ services: ServicesMap });

const AppliedAccount = z.strictObject({ applied: z.literal(true), account: AccountViewSchema });
const AppliedEmail = z.strictObject({ applied: z.literal(true), email: z.string() });
const AccountInput = z.strictObject({ account: Ref });
const applyView = (account: AccountView) => ({ applied: true as const, account });

export const accountFns: FnDef[] = [
  fn({
    name: "accounts.list",
    effect: "read",
    description:
      "Lists the Google accounts this client may use (email, alias, default, status, scopes, and which services they cover) and how many other accounts the user has; the user manages those on /connections. A service shown false needs accounts.connect for it.",
    signature: "accounts.list(): Promise<{ accounts: Array<AccountView & { services: Record<Service, boolean> }>, hiddenCount: number }>",
    tsDecl: `type Input = {};\ntype Output = { accounts: Array<AccountView & { services: Record<Service, boolean> }>; hiddenCount: number };\n${ACCOUNT_VIEW_TS}\n${SERVICE_TS}`,
    example: "await sdk.accounts.list()",
    tags: ["list", "connected", "google", "default", "alias", "services"],
    input: z.strictObject({}),
    output: z.strictObject({ accounts: z.array(ListedAccount), hiddenCount: z.number().int().nonnegative() }),
    async run(_input, accounts, ctx) {
      const { accounts: views, hiddenCount } = await accounts.list();
      const preset = ctx.config.GOOGLE_SCOPE_PRESET;
      return { accounts: views.map((v) => ({ ...v, services: grantedServices(preset, v.scopes) })), hiddenCount };
    },
  }),

  fn({
    name: "accounts.scopes",
    effect: "read",
    description:
      "Shows the Google scopes granted for an allowed account (the default when omitted) and which services they cover; connect a service with accounts.connect.",
    signature: "accounts.scopes({ account?: string }): Promise<{ email: string, scopes: string[], services: Record<Service, boolean> }>",
    tsDecl:
      `type Input = { account?: string };\ntype Output = { email: string; scopes: string[]; services: Record<Service, boolean> };\n${SERVICE_TS}`,
    example: 'await sdk.accounts.scopes({ account: "work" })',
    tags: ["scopes", "permissions", "services"],
    input: z.strictObject({ account: Ref.optional() }),
    output: z.strictObject({ email: z.string(), scopes: z.array(z.string()), services: ServicesMap }),
    async run(input, accounts, ctx) {
      const view = await accounts.get(input.account);
      return { email: view.email, scopes: view.scopes, services: grantedServices(ctx.config.GOOGLE_SCOPE_PRESET, view.scopes) };
    },
  }),

  fn({
    name: "accounts.connect",
    effect: "read",
    description:
      "Returns a single-use link (10 min) the user opens to connect a Google account or add services' scopes to one (pass an allowed account to pre-select it). Changes nothing until the user consents at Google; a new account is allowed to no client.",
    signature: "accounts.connect({ services: Service[], account?: string }): Promise<{ url: string, expiresAt: string, note: string }>",
    tsDecl:
      `type Input = { services: Service[]; account?: string };\ntype Output = { url: string; expiresAt: string; note: string };\n${SERVICE_TS}`,
    example: 'await sdk.accounts.connect({ services: ["sheets"] })',
    tags: ["connect", "add", "scopes", "services", "link", "oauth"],
    input: z.strictObject({ services: Services, account: Ref.optional() }),
    output: z.strictObject({ url: z.string(), expiresAt: z.string(), note: z.string() }),
    async run(input, accounts) {
      // An account to pre-select must be one this client may use; its email is only a login hint for Google.
      const hint = input.account === undefined ? undefined : (await accounts.get(input.account)).email;
      const link = await accounts.connectUrl(input.services);
      const url = hint === undefined ? link.url : `${link.url}&hint=${encodeURIComponent(hint)}`;
      return { url, expiresAt: iso(link.expiresAt), note: CONNECT_NOTE };
    },
  }),

  fn({
    name: "accounts.disconnect",
    effect: "write",
    description:
      "Destructive: revokes the Google grant of an allowed account and deletes its stored token. Calls on it then fail with GWS_RECONNECT_REQUIRED; reconnecting removes it from every client's allowlist, so the user must allow it again on /connections.",
    signature: "accounts.disconnect({ account: string }): Promise<Planned | { applied: true, email: string }>",
    tsDecl: `type Input = { account: string };\ntype Output = Planned | { applied: true; email: string };\n${PLANNED_TS}`,
    example: 'await sdk.accounts.disconnect({ account: "old@example.com" })',
    tags: ["disconnect", "revoke", "remove", "delete"],
    input: AccountInput,
    output: z.union([Planned, AppliedEmail]),
    run: async (input, accounts) => outcome(await accounts.disconnect(input.account), (v) => ({ applied: true as const, email: v.email })),
  }),

  fn({
    name: "accounts.setDefault",
    effect: "write",
    description:
      "Makes an allowed account the user's default, used when a call names no account. Both it and the current default must be allowed for this client.",
    signature: "accounts.setDefault({ account: string }): Promise<Planned | { applied: true, account: AccountView }>",
    tsDecl: `type Input = { account: string };\ntype Output = Planned | { applied: true; account: AccountView };\n${PLANNED_TS}\n${ACCOUNT_VIEW_TS}`,
    example: 'await sdk.accounts.setDefault({ account: "work" })',
    tags: ["default", "set", "primary"],
    input: AccountInput,
    output: z.union([Planned, AppliedAccount]),
    run: async (input, accounts) => outcome(await accounts.setDefault(input.account), applyView),
  }),

  fn({
    name: "accounts.alias",
    effect: "write",
    description: "Sets (or clears with null) the alias of an allowed account; later calls can pass the alias as account.",
    signature: "accounts.alias({ account: string, alias: string | null }): Promise<Planned | { applied: true, account: AccountView }>",
    tsDecl: `type Input = { account: string; alias: string | null };\ntype Output = Planned | { applied: true; account: AccountView };\n${PLANNED_TS}\n${ACCOUNT_VIEW_TS}`,
    example: 'await sdk.accounts.alias({ account: "me@example.com", alias: "work" })',
    tags: ["alias", "rename", "name", "label"],
    input: z.strictObject({ account: Ref, alias: z.string().min(1).max(64).nullable() }),
    output: z.union([Planned, AppliedAccount]),
    run: async (input, accounts) => outcome(await accounts.setAlias(input.account, input.alias), applyView),
  }),

  fn({
    name: "accounts.grant",
    effect: "write",
    description:
      "Asks the user to allow this client to use one of their accounts. Never grants by itself: with apply:true it returns a single-use /connections link where the user chooses the account and confirms. A no-op when the account is already allowed.",
    signature:
      'accounts.grant({ account: string }): Promise<Planned | { applied: false, status: "already_granted", email: string } | { applied: true, status: "confirmation_required", code: "GWS_CONFIRMATION_REQUIRED", confirmUrl: string, expiresAt: string, note: string }>',
    tsDecl: `type Input = { account: string };\ntype Output = Planned | { applied: false; status: "already_granted"; email: string } | { applied: true; status: "confirmation_required"; code: "GWS_CONFIRMATION_REQUIRED"; confirmUrl: string; expiresAt: string; note: string };\n${PLANNED_TS}`,
    example: 'await sdk.accounts.grant({ account: "personal@example.com" })',
    tags: ["grant", "allow", "access", "permission", "request"],
    input: AccountInput,
    output: z.union([
      Planned,
      z.strictObject({ applied: z.literal(false), status: z.literal("already_granted"), email: z.string() }),
      z.strictObject({
        applied: z.literal(true),
        status: z.literal("confirmation_required"),
        code: z.literal("GWS_CONFIRMATION_REQUIRED"),
        confirmUrl: z.string(),
        expiresAt: z.string(),
        note: z.string(),
      }),
    ]),
    async run(input, accounts) {
      // Only an allowed account resolves here, and a denial looks the same whether or not the account
      // exists, so this check reveals nothing the client could not already list.
      try {
        const view = await accounts.get(input.account);
        return { applied: false as const, status: "already_granted" as const, email: view.email };
      } catch (e) {
        if (!isGwsError(e) || e.code !== "GWS_ACCOUNT_DENIED") throw e;
      }
      return outcome(await accounts.requestGrant(input.account), (link) => ({
        applied: true as const,
        status: "confirmation_required" as const,
        code: "GWS_CONFIRMATION_REQUIRED" as const,
        confirmUrl: link.url,
        expiresAt: iso(link.expiresAt),
        note: CONFIRM_NOTE,
      }));
    },
  }),

  fn({
    name: "accounts.ungrant",
    effect: "write",
    description: "Removes an account from this client's allowlist only; other clients and the account itself are unchanged.",
    signature: "accounts.ungrant({ account: string }): Promise<Planned | { applied: true, email: string }>",
    tsDecl: `type Input = { account: string };\ntype Output = Planned | { applied: true; email: string };\n${PLANNED_TS}`,
    example: 'await sdk.accounts.ungrant({ account: "work" })',
    tags: ["ungrant", "remove", "revoke", "access", "allowlist"],
    input: AccountInput,
    output: z.union([Planned, AppliedEmail]),
    run: async (input, accounts) => outcome(await accounts.ungrant(input.account), (v) => ({ applied: true as const, email: v.email })),
  }),
];
