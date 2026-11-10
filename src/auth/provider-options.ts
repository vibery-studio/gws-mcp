import { loadConfig, type ConfigEnv } from "../config";

/** MCP access tokens live one hour; refresh tokens 30 days. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 86400;
/** The one MCP scope; what a client may reach is decided by its account allowlist, not by scopes. */
export const MCP_SCOPES: readonly string[] = ["gws"];

/**
 * OAuthProvider endpoints and resource metadata shared by the Worker entry and tests. Clients register
 * dynamically at /oauth/register; Client ID Metadata Documents stay off.
 */
export function providerOptions(env: ConfigEnv) {
  const config = loadConfig(env);
  return {
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [...MCP_SCOPES],
    resourceMetadata: { resource: config.mcpResource },
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    clientIdMetadataDocumentEnabled: false,
  };
}
