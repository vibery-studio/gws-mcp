import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { isGrantApproved } from "../auth/clients";
import { loadConfig } from "../config";
import type { AuthProps } from "../contracts";
import { EXECUTE_DESCRIPTION, ExecuteInput, SEARCH_DESCRIPTION, SearchInput, executeTool, searchTool, toolError } from "../core/tools";
import { GwsError } from "../errors";
import { workersPorts } from "../runtime/workers/ports";

export { EXECUTE_DESCRIPTION, SEARCH_DESCRIPTION };

const Props = z.object({ userId: z.string().min(1), clientId: z.string().min(1) });

/** The user and client the bearer token was issued for, from the grant props. Never the token itself. */
function authProps(): AuthProps {
  const parsed = Props.safeParse(getMcpAuthContext()?.props);
  if (!parsed.success) throw new GwsError("GWS_INTERNAL", "the access token carries no user and client");
  return { userId: parsed.data.userId, clientId: parsed.data.clientId };
}

/**
 * The MCP server: exactly two tools, `search` and `execute`, over the Workers ports. Built per request (stateless),
 * from that request's env: the Worker entry resolved its public origin (PUBLIC_BASE_URL) there.
 */
export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "gws-mcp", version: "0.1.0" });

  server.registerTool("search", { description: SEARCH_DESCRIPTION, inputSchema: SearchInput }, async (args) => {
    try {
      authProps();
      return searchTool(args, loadConfig(env));
    } catch (e) {
      return toolError(e);
    }
  });

  server.registerTool("execute", { description: EXECUTE_DESCRIPTION, inputSchema: ExecuteInput }, async (args) => {
    try {
      const auth = authProps();
      return await executeTool(args, auth, workersPorts(env), loadConfig(env));
    } catch (e) {
      return toolError(e);
    }
  });

  return server;
}

/** What the provider verified from its own token record (`ctx.auth`), beside the grant's props. */
const VerifiedToken = z.object({ token: z.string().min(1), userId: z.string().min(1), clientId: z.string().min(1) });

/**
 * The provider-verified token identity, only when the grant's props name exactly the user and client the
 * provider issued the token to; else null. Props are application data written at consent; a props/identity
 * mismatch (a consent bug, or props minted for another client) must never let a token act under another
 * client's allowlist or another user.
 */
function verifiedIdentity(ctx: ExecutionContext): z.output<typeof VerifiedToken> | null {
  const verified = VerifiedToken.safeParse((ctx as ExecutionContext & { auth?: unknown }).auth);
  const props = Props.safeParse((ctx as ExecutionContext & { props?: unknown }).props);
  return verified.success && props.success && props.data.userId === verified.data.userId && props.data.clientId === verified.data.clientId
    ? verified.data
    : null;
}

function invalidToken(description: string): Response {
  return new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' },
  });
}

/**
 * MCP endpoint behind the OAuth bearer check (the provider answers 401 before this runs). It also requires
 * the token's grant to be a recorded approval of its user and client, so a client revoke ends every token
 * at once (see isGrantApproved).
 */
export const mcpApiHandler = {
  async fetch(request: Request, workerEnv: Env, ctx: ExecutionContext): Promise<Response> {
    const verified = verifiedIdentity(ctx);
    if (!verified) return invalidToken("the token's grant does not match its identity");
    if (!(await isGrantApproved(workerEnv, verified))) return invalidToken("the token's grant is not approved");
    return createMcpHandler(() => createServer(workerEnv), { route: "/mcp" })(request, workerEnv, ctx);
  },
};
