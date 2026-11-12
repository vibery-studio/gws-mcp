import { z } from "zod";
import type { CallCtx, FnDef, SettingsCapability } from "../contracts";
import { GwsError } from "../errors";
import { SETTINGS_SET_FN, SETTINGS_WHERE, SETTING_KEYS, settingLinkView, settingsSetRefused } from "../core/settings-capability";

/**
 * `settings.*` host functions: the calling user's saved settings (the Google Ads developer token and login customer
 * id). A snippet learns only whether a key is set and may clear one (planned in dry-run, run only under apply). Setting
 * a value is refused: it is entered on the account's page, on the page of a one-time link (`settings.requestLink`) or
 * with the local CLI, never pasted into a chat.
 */

const Key = z.enum(SETTING_KEYS);
const Planned = z.strictObject({ applied: z.literal(false), step: z.string() });
const KEY_TS = `type Key = ${SETTING_KEYS.map((k) => JSON.stringify(k)).join(" | ")};`;
const PLANNED_TS = "type Planned = { applied: false; step: string }; // dry-run: re-run with apply:true";

interface Spec<I, O> {
  name: `settings.${string}`;
  effect: FnDef["effect"];
  description: string;
  signature: string;
  tsDecl: string;
  example: string;
  tags: string[];
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  run(input: I, settings: SettingsCapability): Promise<O>;
}

function fn<I, O>(spec: Spec<I, O>): FnDef {
  const def: FnDef<I, O> = {
    kind: "host",
    name: spec.name,
    service: "settings",
    effect: spec.effect,
    description: spec.description,
    signature: spec.signature,
    tsDecl: spec.tsDecl,
    example: spec.example,
    tags: ["settings", ...spec.tags, spec.effect],
    scopes: [],
    input: spec.input,
    output: spec.output,
    async run(input, ctx: CallCtx) {
      // The dispatcher hands the capability to every settings.* fn; without it there is nothing safe to do.
      if (!ctx.settings) throw new GwsError("GWS_INTERNAL", "settings capability unavailable");
      return spec.run(input, ctx.settings);
    },
  };
  return def as FnDef;
}

export const settingsFns: FnDef[] = [
  fn({
    name: "settings.get",
    effect: "read",
    description: "Whether one of your saved settings is set, such as the Google Ads developer token. Never returns the value.",
    signature: "settings.get({ key: Key }): Promise<{ key: Key, isSet: boolean }>",
    tsDecl: `type Input = { key: Key };\ntype Output = { key: Key; isSet: boolean };\n${KEY_TS}`,
    example: 'await sdk.settings.get({ key: "ads.developer_token" })',
    tags: ["get", "ads", "developer", "token", "customer", "manager"],
    input: z.strictObject({ key: Key }),
    output: z.strictObject({ key: Key, isSet: z.boolean() }),
    run: async (input, settings) => ({ key: input.key, isSet: await settings.isSet(input.key) }),
  }),

  fn({
    name: "settings.clear",
    effect: "write",
    description:
      "Deletes one of your saved settings, such as the Google Ads developer token; Google Ads calls stop working until it is set again. `cleared` is false when nothing was saved.",
    signature: "settings.clear({ key: Key }): Promise<Planned | { applied: true, key: Key, cleared: boolean }>",
    tsDecl: `type Input = { key: Key };\ntype Output = Planned | { applied: true; key: Key; cleared: boolean };\n${PLANNED_TS}\n${KEY_TS}`,
    example: 'await sdk.settings.clear({ key: "ads.login_customer_id" })',
    tags: ["clear", "delete", "remove", "ads", "developer", "token", "customer"],
    input: z.strictObject({ key: Key }),
    output: z.union([Planned, z.strictObject({ applied: z.literal(true), key: Key, cleared: z.boolean() })]),
    run: async (input, settings) => {
      const w = await settings.clear(input.key);
      return w.applied ? { applied: true as const, key: input.key, cleared: w.value.cleared } : { applied: false as const, step: w.step };
    },
  }),

  fn({
    name: "settings.requestLink",
    effect: "read",
    description:
      "Returns a one-time link (10 min) for the person to set one of their settings, such as the Google Ads developer token, on a gws-mcp page while signed in. The value never passes through the AI app; check afterwards with settings.get. Not available when gws-mcp runs on the person's computer (GWS_UNSUPPORTED_RUNTIME): they use `gws-mcp settings set <key>` there.",
    signature: "settings.requestLink({ key: Key }): Promise<{ url: string, expiresAt: string }>",
    tsDecl: `type Input = { key: Key };\ntype Output = { url: string; expiresAt: string };\n${KEY_TS}`,
    example: 'await sdk.settings.requestLink({ key: "ads.developer_token" })',
    tags: ["link", "set", "save", "add", "enter", "ads", "developer", "token", "customer", "manager"],
    input: z.strictObject({ key: Key }),
    output: z.strictObject({ url: z.string(), expiresAt: z.string() }),
    run: async (input, settings) => settingLinkView(await settings.requestLink(input.key)),
  }),

  fn({
    name: SETTINGS_SET_FN as `settings.${string}`,
    effect: "write",
    description: `Always refused: settings are never set from an AI app, because anything pasted into a chat stays in its history. Set them ${SETTINGS_WHERE}, or hand the person a link from settings.requestLink (the refusal carries one in details.setLink).`,
    signature: "settings.set(): never (always refused)",
    tsDecl: "type Input = never; // always refused\ntype Output = never;",
    example: "// Not available to AI apps: use settings.requestLink and give the person the link.",
    tags: ["set", "save", "ads", "developer", "token"],
    // Any input reaches the refusal unvalidated, so nothing about it is ever reported back.
    input: z.unknown(),
    output: z.never(),
    run: async () => {
      throw settingsSetRefused();
    },
  }),
];
