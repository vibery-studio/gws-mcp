// The MCP side of the harness: the official MCP client over Streamable HTTP with a bearer token, plus raw
// JSON-RPC posts for the HTTP-status assertions (401 without or after a revoked token).
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ExecuteOutput } from "../../src/contracts";
import type { SearchResult } from "../../src/core/search";

/** What `execute` returns (ExecuteOutput plus the count of refusals that got no audit row). */
export type ExecuteReport = ExecuteOutput & { unauditedRefusals: number };

/** An MCP session for one access token. */
export class McpSession {
  private constructor(
    private readonly client: Client,
    readonly accessToken: string,
  ) {}

  static async open(base: string, accessToken: string): Promise<McpSession> {
    const client = new Client({ name: "gws-mcp-e2e", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", base), {
      authProvider: { token: async () => accessToken },
    });
    await client.connect(transport);
    return new McpSession(client, accessToken);
  }

  async toolNames(): Promise<string[]> {
    const { tools } = await this.client.listTools();
    return tools.map((t) => t.name).sort();
  }

  /** Calls a tool and returns its single text content parsed as JSON, and whether it was an error result. */
  async call(name: string, args: Record<string, unknown>): Promise<{ value: unknown; text: string; isError: boolean }> {
    const res = await this.client.callTool({ name, arguments: args });
    const content = Array.isArray(res.content) ? res.content : [];
    const first = content[0] as { type?: unknown; text?: unknown } | undefined;
    if (content.length !== 1 || first?.type !== "text" || typeof first.text !== "string") {
      throw new Error(`${name}: expected one text content`);
    }
    return { value: JSON.parse(first.text) as unknown, text: first.text, isError: res.isError === true };
  }

  async search(query: string, service?: string): Promise<{ results: SearchResult[]; bytes: number; isError: boolean }> {
    const { value, text, isError } = await this.call("search", { query, ...(service ? { service } : {}) });
    return { results: Array.isArray(value) ? (value as SearchResult[]) : [], bytes: Buffer.byteLength(text, "utf8"), isError };
  }

  /** Runs a snippet; `text` is the raw tool output (what a client sees), for secret scans. */
  async execute(code: string, apply = false): Promise<{ out: ExecuteReport; text: string; ms: number }> {
    const started = Date.now();
    const { value, text } = await this.call("execute", { code, apply });
    return { out: value as ExecuteReport, text, ms: Date.now() - started };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** HTTP status and WWW-Authenticate header of a raw `tools/list` POST to /mcp, with or without a token. */
export async function rawToolsList(base: string, accessToken?: string): Promise<{ status: number; wwwAuthenticate: string | null }> {
  const res = await fetch(new URL("/mcp", base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  await res.body?.cancel();
  return { status: res.status, wwwAuthenticate: res.headers.get("www-authenticate") };
}

/** The error code of an execute report, or "none". */
export function codeOf(out: ExecuteReport): string {
  return out.error?.code ?? "none";
}
