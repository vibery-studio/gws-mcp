import { getOAuthApi, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { ConfigEnv } from "../config";
import { mcpApiHandler } from "../mcp/server";
import { webApp } from "../web/app";
import { providerOptions } from "./provider-options";

/**
 * The OAuth provider's whole configuration: its endpoints, TTLs and resource metadata (`providerOptions`), the MCP
 * API behind the bearer check and the web app for every other path. The one builder for every host: the Worker
 * entry (src/index.ts, also what the Node host serves) and the Node host's access command, so both see the same
 * provider.
 */
export function oauthServerOptions(env: ConfigEnv) {
  return { ...providerOptions(env), apiRoute: "/mcp", apiHandler: mcpApiHandler, defaultHandler: webApp };
}

/**
 * The provider's helpers outside a request (the provider adds the same ones to each request's env as
 * `OAUTH_PROVIDER`): grant listing and revocation over `env.OAUTH_KV`.
 */
export function oauthHelpers(env: Env): OAuthHelpers {
  return getOAuthApi(oauthServerOptions(env), env);
}
