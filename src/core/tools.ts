import { z } from "zod";
import { GOOGLE_SERVICES, type Config } from "../config";
import type { AuthProps, FnMeta } from "../contracts";
import { toWire } from "../errors";
import { runExecute } from "./execute";
import type { CorePorts } from "./ports";
import { getRegistry, type Registry } from "./registry";
import { search } from "./search";

/**
 * The MCP tool definitions both runtimes serve: exactly two tools, `search` and `execute`. Each runtime's MCP
 * wiring registers them, establishes who is calling (`AuthProps`) and supplies its ports.
 */

export const SEARCH_SERVICES = [...GOOGLE_SERVICES, "helpers", "accounts"] as const;
/** Input bounds at the MCP boundary. */
const MAX_QUERY = 500;
const MAX_FN_NAME = 300;
const MAX_CODE = 100_000;

export const SEARCH_DESCRIPTION =
  "Find SDK functions for Gmail, Drive, Calendar, Sheets, Docs, helpers and accounts. Returns at most 10 compact " +
  "TypeScript signatures with effect (read/write), an example and a destructive hint. Pass `service` to filter. " +
  "Pass `fn` (an exact name from a result) to get its full TypeScript declaration and scopes instead.";

export const EXECUTE_DESCRIPTION =
  "Run a JavaScript snippet (an async arrow function) that calls the Google Workspace SDK: " +
  "`await sdk.<service>.<resource>.<method>(input)`, e.g. `await sdk.gmail.users.messages.list({ userId: 'me' })`. " +
  "Every input takes an optional `account` (email or alias; the default account otherwise), so one snippet can mix accounts. " +
  "Only `sdk` and `console` exist; there is no fetch/network, no env and no import. Find functions with the search tool first. " +
  "Await every sdk call: a call not yet started when the snippet returns is refused. " +
  "Writes are DRY-RUN unless apply:true; dry-run returns the request plan and flags destructive steps (delete, empty trash, " +
  "public share, ownership transfer). In dry-run a write returns a pending value; a write that uses it shows as incomplete in the plan. " +
  "The dry-run plan is advisory, not a guarantee: the snippet runs again under apply:true and code can behave differently there, " +
  "so review the code itself before applying, not only the plan. Failed calls throw a GwsError with `.code` (e.g. GWS_SCOPE_MISSING, " +
  "GWS_ACCOUNT_DENIED) and `.details`. Returns {ok, executeId, applied, destructive, result, error, logs, calls, plan, unauditedRefusals}; " +
  "the result must be JSON and is size-capped, and console output is redacted.";

export const SearchInput = z.object({
  query: z.string().max(MAX_QUERY),
  service: z.enum(SEARCH_SERVICES).optional(),
  fn: z.string().min(1).max(MAX_FN_NAME).optional(),
});

export const ExecuteInput = z.object({
  code: z.string().min(1).max(MAX_CODE),
  apply: z.boolean().optional(),
});

/** A tool's reply: one JSON text block. Structurally an MCP `CallToolResult` (a type alias, so it is indexable). */
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
};

const fnLists = new WeakMap<Registry, readonly FnMeta[]>();
/** One stable array per registry, so the search index built over it is memoized for the process. */
function searchableFns(registry: Registry): readonly FnMeta[] {
  let list = fnLists.get(registry);
  if (list === undefined) {
    list = [...registry.values()];
    fnLists.set(registry, list);
  }
  return list;
}

/** A tool reply holding `value` as its one JSON text block. */
export function toolResult(value: unknown, isError: boolean): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError };
}

/** A tool never throws: the MCP SDK would put a thrown error's raw message in the reply. */
export function toolError(e: unknown): ToolResult {
  let wire;
  try {
    wire = toWire(e);
  } catch {
    wire = { code: "GWS_INTERNAL", message: "internal error" };
  }
  return toolResult({ error: wire }, true);
}

/**
 * The `search` tool over `registry` (the SDK registry when omitted; a runtime passes its own when it replaces a
 * function). Throws on a config or registry failure; the wiring maps that with `toolError`.
 */
export function searchTool(args: z.output<typeof SearchInput>, config: Config, registry: Registry = getRegistry()): ToolResult {
  const fns = searchableFns(registry);
  const out =
    args.fn !== undefined
      ? search({ fn: args.fn }, fns, config)
      : search({ query: args.query, ...(args.service ? { service: args.service } : {}) }, fns, config);
  return toolResult(out, false);
}

/** The `execute` tool, as `auth` over the runtime's `ports`, calling the functions of `registry` (the SDK's by default). */
export async function executeTool(
  args: z.output<typeof ExecuteInput>,
  auth: AuthProps,
  ports: CorePorts,
  config: Config,
  registry?: Registry,
): Promise<ToolResult> {
  const out = await runExecute({ code: args.code, apply: args.apply === true, auth, ports, config, ...(registry ? { registry } : {}) });
  return toolResult(out, !out.ok);
}
