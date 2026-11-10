import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { GOOGLE_SERVICES, type Config } from "../config";
import type { AuthProps, FnDef } from "../contracts";
import { runExecute } from "../core/execute";
import type { CorePorts } from "../core/ports";
import { buildRegistry, getRegistry, type Registry } from "../core/registry";
import { EXECUTE_DESCRIPTION, ExecuteInput, SEARCH_DESCRIPTION, SearchInput, searchTool, toolError, toolResult } from "../core/tools";
import { GwsError, isGwsError, type WireError } from "../errors";
import pkg from "../../package.json";
import { shellQuote } from "./invocation";
import { LOCAL_USER_ID } from "./store";

/** Who calls the local server: the single local user, through the one stdio client that started it. */
export const LOCAL_AUTH: AuthProps = Object.freeze({ userId: LOCAL_USER_ID, clientId: "local" });

const SERVICE_TS = `type Service = ${GOOGLE_SERVICES.map((s) => JSON.stringify(s)).join(" | ")};`;
const MAX_REF = 320;

/** The local text for an account the server cannot use: there is no /connections page, only the CLI. */
function notConnected(self: string, ref: string | undefined): GwsError {
  return new GwsError("GWS_ACCOUNT_DENIED", `this account is not connected to this gws-mcp. To connect one, the user runs: ${self} accounts add`, {
    details: { account: ref === undefined || ref.trim() === "" ? "default" : ref.slice(0, MAX_REF) },
  });
}

/**
 * The local `accounts.connect`. The stdio server has no web page to send a link to, and a snippet must not start a
 * browser sign-in on its own, so it returns the CLI command (this CLI's own invocation, never `npx`) that connects
 * the account or adds the services in the user's terminal. An account to pre-select must be connected; its email
 * comes from the store and is shell-quoted.
 */
function localConnect(self: string): FnDef {
  return {
    kind: "host",
    name: "accounts.connect",
    service: "accounts",
    effect: "read",
    description:
      "Returns the terminal command that connects a Google account to this local gws-mcp, or adds services' scopes to a connected one (pass the account). The user runs it on this computer; it opens Google in their browser. Changes nothing by itself.",
    signature: "accounts.connect({ services: Service[], account?: string }): Promise<{ command: string, note: string }>",
    tsDecl: `type Input = { services: Service[]; account?: string };\ntype Output = { command: string; note: string };\n${SERVICE_TS}`,
    example: 'await sdk.accounts.connect({ services: ["sheets"] })',
    tags: ["accounts", "connect", "add", "scopes", "services", "oauth", "read"],
    scopes: [],
    input: z.strictObject({ services: z.array(z.enum(GOOGLE_SERVICES)).min(1).max(GOOGLE_SERVICES.length), account: z.string().min(1).max(MAX_REF).optional() }),
    output: z.strictObject({ command: z.string(), note: z.string() }),
    async run(input, ctx) {
      if (!ctx.accounts) throw new GwsError("GWS_INTERNAL", "accounts capability unavailable");
      const { services, account } = input as { services: string[]; account?: string };
      let email: string | undefined;
      if (account !== undefined) {
        try {
          email = (await ctx.accounts.get(account)).email;
        } catch (e) {
          if (!isGwsError(e) || e.code !== "GWS_ACCOUNT_DENIED") throw e;
          throw notConnected(self, account);
        }
      }
      const command = `${self} accounts add --services ${[...new Set(services)].join(",")}${email === undefined ? "" : ` --account ${shellQuote(email)}`}`;
      return {
        command,
        note: "Ask the user to run this command in a terminal on this computer. It opens Google in their browser; once they consent, run your snippet again.",
      };
    },
  };
}

/**
 * The local `accounts.grant`. Every connected account is available to the local server (there is no per-app list
 * and no /connections page), so it never returns a confirmation link: a connected account is already granted, and
 * any other reference gets the local denial, pointing at accounts.connect.
 */
function localGrant(self: string): FnDef {
  return {
    kind: "host",
    name: "accounts.grant",
    service: "accounts",
    effect: "read",
    description:
      "Locally every connected Google account is already available, so this only confirms it. For an account that is not connected, use accounts.connect.",
    signature: 'accounts.grant({ account: string }): Promise<{ applied: false, status: "already_granted", email: string }>',
    tsDecl: 'type Input = { account: string };\ntype Output = { applied: false; status: "already_granted"; email: string };',
    example: 'await sdk.accounts.grant({ account: "personal@example.com" })',
    tags: ["accounts", "grant", "allow", "access", "permission", "read"],
    scopes: [],
    input: z.strictObject({ account: z.string().min(1).max(MAX_REF) }),
    output: z.strictObject({ applied: z.literal(false), status: z.literal("already_granted"), email: z.string() }),
    async run(input, ctx) {
      if (!ctx.accounts) throw new GwsError("GWS_INTERNAL", "accounts capability unavailable");
      const { account } = input as { account: string };
      try {
        return { applied: false, status: "already_granted", email: (await ctx.accounts.get(account)).email };
      } catch (e) {
        if (!isGwsError(e) || e.code !== "GWS_ACCOUNT_DENIED") throw e;
        throw notConnected(self, account);
      }
    },
  };
}

const registries = new Map<string, Registry>();
/** The SDK registry with the local `accounts.connect` and `accounts.grant` (hinting `self`) in place of the remote ones. */
export function localRegistry(self: string): Registry {
  let registry = registries.get(self);
  if (registry === undefined) {
    const local = new Map([localConnect(self), localGrant(self)].map((f) => [f.name, f]));
    registry = buildRegistry([...getRegistry().values()].map((f) => local.get(f.name) ?? f));
    registries.set(self, registry);
  }
  return registry;
}

/**
 * The execute's error with local wording: the shared core speaks of the remote /connections page for an account the
 * client may not use or must reconnect; locally the user does both with this CLI.
 */
export function localizeError(e: WireError, self: string): WireError {
  if (e.code === "GWS_ACCOUNT_DENIED" && e.message.includes("/connections")) {
    const account = typeof e.details?.account === "string" ? e.details.account : undefined;
    const w = notConnected(self, account);
    return { ...e, message: w.message };
  }
  if (e.code === "GWS_RECONNECT_REQUIRED") {
    const again = e.account === undefined ? `${self} accounts add` : `${self} accounts add --account ${shellQuote(e.account)}`;
    const what = e.message.includes("disconnected") ? "this account was disconnected" : "this account must be reconnected";
    return { ...e, message: `${what}; the user reconnects it with: ${again}` };
  }
  return e;
}

export interface LocalServerOptions {
  ports: CorePorts;
  config: Config;
  /** How to run this CLI, for the commands and hints the tools return (`selfCommand()`). */
  self: string;
}

/**
 * The local MCP server: exactly the remote's two tools, `search` and `execute`, with the remote's descriptions and
 * input schemas, over the local ports (QuickJS sandbox, SQLite store, keychain secrets), as the single local user.
 */
export function createLocalServer(o: LocalServerOptions): McpServer {
  const server = new McpServer({ name: "gws-mcp", version: pkg.version });
  const registry = localRegistry(o.self);
  server.registerTool("search", { description: SEARCH_DESCRIPTION, inputSchema: SearchInput }, async (args) => {
    try {
      return searchTool(args, o.config, registry);
    } catch (e) {
      return toolError(e);
    }
  });
  server.registerTool("execute", { description: EXECUTE_DESCRIPTION, inputSchema: ExecuteInput }, async (args) => {
    try {
      const out = await runExecute({ code: args.code, apply: args.apply === true, auth: LOCAL_AUTH, ports: o.ports, config: o.config, registry });
      if (out.error !== undefined) out.error = localizeError(out.error, o.self);
      return toolResult(out, !out.ok);
    } catch (e) {
      return toolError(e);
    }
  });
  return server;
}

export interface ServeStdioOptions extends LocalServerOptions {
  stdin?: Readable;
  stdout?: Writable;
}

/**
 * Serves MCP over stdio until the client closes stdin. Resolves when the connection has closed. Nothing but MCP
 * messages is ever written to `stdout`.
 */
export async function serveStdio(o: ServeStdioOptions): Promise<void> {
  const server = createLocalServer(o);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  await server.connect(new StdioServerTransport(o.stdin, o.stdout));
  await closed;
}
