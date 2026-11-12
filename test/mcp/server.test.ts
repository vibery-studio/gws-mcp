import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { revokeClient } from "../../src/auth/clients";
import { providerOptions } from "../../src/auth/provider-options";
import { loadConfig } from "../../src/config";
import { EXECUTE_DESCRIPTION, mcpApiHandler, remoteExecuteDescription } from "../../src/mcp/server";
import { webApp } from "../../src/web/app";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";
import { mintMcpToken, type McpToken } from "../helpers/mcp-token";

const G = "https://www.googleapis.com/auth/";
const config = loadConfig(env);

interface RpcReply {
  status: number;
  body: string;
  message?: { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

let seq = 0;

/** One JSON-RPC request to /mcp through the Worker (OAuth provider in front), as a 2025-era stateless client. */
async function rpc(method: string, params: Record<string, unknown>, token?: string): Promise<RpcReply> {
  const res = await exports.default.fetch("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      // A real HTTP request always carries Host; the MCP handler validates it.
      host: "localhost",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
  });
  const body = await res.text();
  const json = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? body
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .at(-1)
    : body;
  let message: RpcReply["message"];
  try {
    message = json ? (JSON.parse(json) as RpcReply["message"]) : undefined;
  } catch {
    message = undefined;
  }
  return { status: res.status, body, message };
}

interface ToolReply {
  isError: boolean;
  value: unknown;
  raw: string;
}

async function callTool(token: string, name: string, args: Record<string, unknown>): Promise<ToolReply> {
  const r = await rpc("tools/call", { name, arguments: args }, token);
  const result = r.message?.result as { content?: Array<{ type: string; text: string }>; isError?: boolean } | undefined;
  if (!result?.content?.[0]) throw new Error(`no tool result: ${r.status} ${r.body.slice(0, 300)}`);
  return { isError: result.isError === true, value: JSON.parse(result.content[0].text), raw: r.body };
}

/** True when the MCP SDK refused the tool arguments as too long, before the tool handler ran. */
function rejectedInput(r: RpcReply): boolean {
  const result = r.message?.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  return result?.isError === true && /^Input validation error: .*Too big/.test(result.content?.[0]?.text ?? "");
}

let token: McpToken;

beforeAll(async () => {
  const email = uniqueEmail("mcp");
  const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}drive.file`], isDefault: true });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }] });
  token = await mintMcpToken({ userId: seeded.userId, accountIds: [seeded.account.id] });
});

describe("MCP endpoint", () => {
  it("answers an unauthenticated call with 401", async () => {
    const r = await rpc("tools/list", {});
    expect(r.status).toBe(401);
    expect(r.message?.result).toBeUndefined();
  });

  it("lists exactly the two tools search and execute", async () => {
    const r = await rpc("tools/list", {}, token.accessToken);
    expect(r.status).toBe(200);
    const tools = (r.message?.result?.tools ?? []) as Array<{ name: string; description: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual(["execute", "search"]);
    // The remote description adds the human approval flow for this deployment's list (the default here).
    const description = tools.find((t) => t.name === "execute")?.description;
    expect(description).toBe(remoteExecuteDescription(env));
    expect(description).toContain("Steps with reason spend, public-share, owner-transfer, permission-change, publish are marked needsApproval");
    expect(description).toContain("GWS_APPROVAL_REQUIRED");
    expect(EXECUTE_DESCRIPTION).not.toContain("needsApproval");
  });

  it("states the dry-run default and that the plan is advisory in the execute description", () => {
    expect(EXECUTE_DESCRIPTION).toContain("Writes are DRY-RUN unless apply:true");
    expect(EXECUTE_DESCRIPTION).toContain("dry-run returns the request plan and flags destructive steps");
    expect(EXECUTE_DESCRIPTION).toContain("Only `sdk` and `console` exist; there is no fetch/network");
    expect(EXECUTE_DESCRIPTION).toMatch(/plan is advisory/);
  });

  it("search returns at most 10 compact signatures under the byte cap", async () => {
    const r = await callTool(token.accessToken, "search", { query: "gmail messages list" });
    expect(r.isError).toBe(false);
    const results = r.value as Array<{ name: string; signature: string; effect: string; example: string }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(10);
    expect(results.map((x) => x.name)).toContain("gmail.users.messages.list");
    expect(new TextEncoder().encode(JSON.stringify(results)).length).toBeLessThanOrEqual(config.SEARCH_MAX_BYTES);
    expect(results.every((x) => !("tsDecl" in x))).toBe(true);
  });

  it("search filters by service and returns the full declaration of one fn on demand", async () => {
    const filtered = await callTool(token.accessToken, "search", { query: "list", service: "drive" });
    expect((filtered.value as Array<{ name: string }>).every((x) => x.name.startsWith("drive."))).toBe(true);
    const detail = await callTool(token.accessToken, "search", { query: "", fn: "gmail.users.messages.list" });
    expect(detail.value).toMatchObject({ name: "gmail.users.messages.list", effect: "read" });
    expect(typeof (detail.value as { tsDecl: unknown }).tsDecl).toBe("string");
    const unknown = await callTool(token.accessToken, "search", { query: "", fn: "gmail.nope" });
    expect(unknown).toMatchObject({ isError: true, value: { error: { code: "GWS_UNKNOWN_METHOD" } } });
  });

  it("execute runs a read snippet for the token's user and client", async () => {
    const r = await callTool(token.accessToken, "execute", { code: "async () => (await sdk.drive.files.list({})).files.length > 0" });
    expect(r.isError).toBe(false);
    expect(r.value).toMatchObject({ ok: true, applied: false, result: true });
  });

  it("execute marks a failed snippet isError with its structured code", async () => {
    const r = await callTool(token.accessToken, "execute", { code: "async () => sdk.drive.files.nope({})" });
    expect(r).toMatchObject({ isError: true, value: { ok: false, error: { code: "GWS_UNKNOWN_METHOD" } } });
  });

  it("runs a 100,000-character snippet and rejects a 100,001-character one before it runs", async () => {
    const body = "async () => 'ran'";
    const sized = (n: number) => `${body}/*${"x".repeat(n - body.length - 4)}*/`;
    expect(sized(100_001)).toHaveLength(100_001);
    const atMax = await callTool(token.accessToken, "execute", { code: sized(100_000) });
    expect(atMax).toMatchObject({ isError: false, value: { ok: true, result: "ran" } });
    const over = await rpc("tools/call", { name: "execute", arguments: { code: sized(100_001) } }, token.accessToken);
    expect(rejectedInput(over)).toBe(true);
    expect(over.body).not.toContain("executeId");
  });

  it("searches with a 500-character query and rejects a 501-character one", async () => {
    const atMax = await callTool(token.accessToken, "search", { query: "a".repeat(500) });
    expect(atMax.isError).toBe(false);
    const over = await rpc("tools/call", { name: "search", arguments: { query: "a".repeat(501) } }, token.accessToken);
    expect(rejectedInput(over)).toBe(true);
  });

  it("never returns the bearer token, also when a snippet hunts for it", async () => {
    const replies = await Promise.all([
      callTool(token.accessToken, "execute", {
        code: "async () => ({ me: this && this.ctx ? Object.keys(this.ctx) : [], props: this?.ctx?.props ?? null, g: Object.keys(globalThis) })",
      }),
      callTool(token.accessToken, "search", { query: "token" }),
    ]);
    for (const r of replies) expect(r.raw.includes(token.accessToken)).toBe(false);
  });

  it("refuses with 401 a real token whose grant props were minted for another client or carry no identity", async () => {
    const other = await mintMcpToken({ userId: token.userId });
    for (const props of [{ userId: token.userId, clientId: other.clientId }, { userId: 42 }]) {
      const bad = await mintMcpToken({ userId: token.userId, props });
      for (const r of [
        await rpc("tools/call", { name: "execute", arguments: { code: "async () => 1" } }, bad.accessToken),
        await rpc("tools/list", {}, bad.accessToken),
      ]) {
        expect(r.status).toBe(401);
        expect(r.message?.result).toBeUndefined();
      }
    }
  });

  describe("binds the grant props to the provider-verified token identity", () => {
    const verified = { token: "t", audience: config.mcpResource, scope: ["gws"], userId: "u_1", clientId: "c_1" };
    /** The execution context the provider hands the API handler: `auth` from its token record, `props` from the grant. */
    function ctxWith(auth: unknown, props: unknown): ExecutionContext {
      return { auth, props, waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    }
    const request = () =>
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "localhost" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });

    it.each([
      ["another user", { userId: "u_2", clientId: "c_1" }],
      ["another client", { userId: "u_1", clientId: "c_2" }],
      ["no client", { userId: "u_1" }],
      ["no props", undefined],
    ])("answers 401 when the props name %s", async (_label, props) => {
      const res = await mcpApiHandler.fetch(request(), env, ctxWith(verified, props));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("invalid_token");
    });

    it("answers 401 when the provider verified no identity", async () => {
      const res = await mcpApiHandler.fetch(request(), env, ctxWith(undefined, { userId: "u_1", clientId: "c_1" }));
      expect(res.status).toBe(401);
    });
  });

  it("accepts a token whose props name exactly its own user and client", async () => {
    const r = await rpc("tools/list", {}, token.accessToken);
    expect(r.status).toBe(200);
  });

  describe("refuses a token whose grant has no recorded approval", () => {
    /** OAUTH_KV whose grant and token listings are empty, as Cloudflare's eventually consistent KV list can be. */
    const staleListingKv = new Proxy(env.OAUTH_KV, {
      get(target, key) {
        if (key === "list") {
          return (options?: KVNamespaceListOptions) =>
            /^(grant|token):/.test(options?.prefix ?? "") ? Promise.resolve({ keys: [], list_complete: true, cacheStatus: null }) : target.list(options);
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const providerConfig = { ...providerOptions(env), apiRoute: "/mcp", apiHandler: mcpApiHandler, defaultHandler: webApp };
    const staleHelpers = getOAuthApi(providerConfig, { ...env, OAUTH_KV: staleListingKv });

    it("answers 401 to the same token right after a revoke the provider's stale listing could not complete", async () => {
      const minted = await mintMcpToken({ userId: token.userId });
      expect((await rpc("tools/list", {}, minted.accessToken)).status).toBe(200);
      await revokeClient({ ...env, OAUTH_PROVIDER: staleHelpers } as Env, minted.userId, minted.clientId);
      // The provider's own revoke missed the just-issued token: its record still validates.
      expect(await getOAuthApi(providerConfig, env).unwrapToken(minted.accessToken)).not.toBeNull();
      const r = await rpc("tools/list", {}, minted.accessToken);
      expect(r.status).toBe(401);
      expect(r.message?.result).toBeUndefined();
    });

    it("answers 401 to a token whose approval row was deleted, and keeps serving an approved one", async () => {
      const minted = await mintMcpToken({ userId: token.userId });
      expect((await rpc("tools/list", {}, minted.accessToken)).status).toBe(200);
      await env.DB.prepare("DELETE FROM client_approvals WHERE user_id = ? AND client_id = ?").bind(minted.userId, minted.clientId).run();
      for (const r of [
        await rpc("tools/list", {}, minted.accessToken),
        await rpc("tools/call", { name: "execute", arguments: { code: "async () => 1" } }, minted.accessToken),
      ]) {
        expect(r.status).toBe(401);
        expect(r.message?.result).toBeUndefined();
      }
      expect((await rpc("tools/list", {}, token.accessToken)).status).toBe(200);
    });

    it("answers 401 when the verified token names a grant that was never approved", async () => {
      const verified = { token: `${token.userId}:neverApproved:secret`, audience: config.mcpResource, scope: ["gws"], userId: token.userId, clientId: token.clientId };
      const ctx = { auth: verified, props: { userId: token.userId, clientId: token.clientId }, waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
      const res = await mcpApiHandler.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "localhost" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("invalid_token");
    });
  });
});
