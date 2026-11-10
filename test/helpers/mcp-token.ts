import { getOAuthApi, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { env, exports } from "cloudflare:workers";
import { displayClientName, recordApproval } from "../../src/auth/clients";
import { providerOptions } from "../../src/auth/provider-options";
import { loadConfig } from "../../src/config";
import { mcpApiHandler } from "../../src/mcp/server";
import { openStore } from "../../src/store/db";
import worker from "../../src/index";
import { webApp } from "../../src/web/app";

const REDIRECT_URI = "https://mcp-client.example/callback";
const SCOPE = ["gws"];

export interface McpToken {
  accessToken: string;
  clientId: string;
  userId: string;
}

export interface MintOptions {
  /** The gws-mcp user the token acts for. */
  userId: string;
  /** Accounts the new client may use (written to client_grants). */
  accountIds?: readonly string[];
  /** Overrides the props stored with the grant; `{userId, clientId}` when omitted. */
  props?: Record<string, unknown>;
  /**
   * Mints for a Worker without the PUBLIC_BASE_URL override reached at this origin: the token's resource (audience)
   * is `<origin>/mcp` and the code is exchanged at `<origin>/oauth/token`. Default: the test env's configured URL.
   */
  origin?: string;
}

/** The test env without the PUBLIC_BASE_URL override, so the Worker derives its public origin from each request. */
export function envWithoutBaseUrl(): Env {
  const copy: Record<string, unknown> = { ...env };
  delete copy.PUBLIC_BASE_URL;
  return copy as unknown as Env;
}

/**
 * Calls the Worker entry directly with `workerEnv` (`exports.default` always runs with the test env), with a minimal
 * ExecutionContext. The request is cast to the incoming shape the handler type names; tests send no `cf` data.
 */
export function callWorker(request: Request, workerEnv: Env): Promise<Response> {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  return worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, workerEnv, ctx);
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mints a real MCP access token the way an approved client gets one: registers a public client, completes
 * the authorization with PKCE through the provider's helpers (the consent page's last step), then exchanges
 * the code at /oauth/token through the Worker. The grant's props are `{userId, clientId}`.
 */
export async function mintMcpToken(opts: MintOptions): Promise<McpToken> {
  const providerEnv = opts.origin === undefined ? env : { ...env, PUBLIC_BASE_URL: opts.origin };
  const helpers = getOAuthApi({ ...providerOptions(providerEnv), apiRoute: "/mcp", apiHandler: mcpApiHandler, defaultHandler: webApp }, env);
  const client = await helpers.createClient({
    redirectUris: [REDIRECT_URI],
    clientName: "test MCP client",
    tokenEndpointAuthMethod: "none",
  });
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const resource = loadConfig(providerEnv).mcpResource;
  const request: AuthRequest = {
    responseType: "code",
    clientId: client.clientId,
    redirectUri: REDIRECT_URI,
    scope: SCOPE,
    state: crypto.randomUUID(),
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    resource,
  };
  const { redirectTo } = await helpers.completeAuthorization({
    request,
    userId: opts.userId,
    metadata: {},
    scope: SCOPE,
    props: opts.props ?? { userId: opts.userId, clientId: client.clientId },
  });
  // As the consent route does: the approval is recorded before the code is used.
  await recordApproval({ ...env, OAUTH_PROVIDER: helpers } as Env, {
    userId: opts.userId,
    clientId: client.clientId,
    clientName: displayClientName(client.clientName, client.clientId),
    redirectTo,
  });
  const code = new URL(redirectTo).searchParams.get("code");
  if (!code) throw new Error("completeAuthorization returned no code");

  const tokenRequest = (url: string, init: RequestInit) =>
    opts.origin === undefined ? exports.default.fetch(url, init) : callWorker(new Request(url, init), envWithoutBaseUrl());
  const res = await tokenRequest(`${opts.origin ?? "http://localhost"}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.clientId,
      code_verifier: verifier,
      resource,
    }).toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const body: unknown = await res.json();
  const accessToken = (body as { access_token?: unknown }).access_token;
  if (typeof accessToken !== "string") throw new Error("token exchange returned no access_token");

  const store = openStore(env);
  for (const accountId of opts.accountIds ?? []) await store.grants.add(opts.userId, client.clientId, accountId);
  return { accessToken, clientId: client.clientId, userId: opts.userId };
}
