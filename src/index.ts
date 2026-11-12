import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { oauthServerOptions } from "./auth/oauth-server";
import { loadConfig, publicBaseUrl, type ConfigEnv } from "./config";
import { checkIpLimit } from "./web/ip-limit";

// Startup check, so a bad var fails the deploy rather than every request: the whole config is validated once, with
// a stand-in origin when PUBLIC_BASE_URL is unset (the real one comes from each request).
loadConfig({ ...(env as ConfigEnv), PUBLIC_BASE_URL: publicBaseUrl(env as ConfigEnv, "http://localhost") });

/** The Worker env with the public origin resolved for this request. */
type RequestEnv = Env & { PUBLIC_BASE_URL: string };

/**
 * One provider per public origin, because the provider's protected resource (`<origin>/mcp`, the token audience) is
 * fixed at construction. The origins are the hostnames routed to this Worker (or the one override), so the map
 * stays tiny; it is cleared if it ever grows past the bound.
 */
const MAX_PROVIDERS = 8;
const providers = new Map<string, OAuthProvider<RequestEnv>>();

function providerFor(requestEnv: RequestEnv): OAuthProvider<RequestEnv> {
  const base = requestEnv.PUBLIC_BASE_URL;
  let provider = providers.get(base);
  if (!provider) {
    if (providers.size >= MAX_PROVIDERS) providers.clear();
    provider = new OAuthProvider<RequestEnv>(oauthServerOptions(requestEnv));
    providers.set(base, provider);
  }
  return provider;
}

export default {
  // The public origin is resolved first (src/config.ts `publicBaseUrl`) and every handler below reads config from
  // the env passed here, never from the module-level env. Client registration's per-address limit runs before the
  // provider, because it serves registration itself. The web routes' limits run inside the web app (src/web/app.ts).
  async fetch(request, workerEnv, ctx) {
    const base = publicBaseUrl(workerEnv as ConfigEnv, request.url);
    if (base === null) {
      return new Response("This server accepts only https requests.\n", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const requestEnv: RequestEnv = (workerEnv as ConfigEnv).PUBLIC_BASE_URL === base ? (workerEnv as RequestEnv) : { ...workerEnv, PUBLIC_BASE_URL: base };
    return (await checkIpLimit(requestEnv, request)) ?? providerFor(requestEnv).fetch(request, requestEnv, ctx);
  },
} satisfies ExportedHandler<Env>;
