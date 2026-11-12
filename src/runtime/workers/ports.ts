import { loadConfig } from "../../config";
import { SECRET_NAMES } from "../../contracts";
import type { HumanApprovalPort } from "../../core/human-approval";
import type { CorePorts, SecretSource } from "../../core/ports";
import type { SettingLinkPort } from "../../core/setting-links";
import { createTransport } from "../../google/transport";
import { openApprovals } from "../../store/approvals";
import { openStore } from "../../store/db";
import { getAccessToken, invalidate } from "../../store/token-cache";
import { openUserSettings } from "../../store/user-settings";
import { workersSandbox } from "./sandbox";

const SECRET_NAME_SET: ReadonlySet<string> = new Set(SECRET_NAMES);

function isSecretName(name: string): name is (typeof SECRET_NAMES)[number] {
  return SECRET_NAME_SET.has(name);
}

/**
 * The Workers adapters for every core port, over the Worker env: the Dynamic Worker sandbox (LOADER), the D1
 * store (DB), the encrypted KV token cache and link records (CACHE_KV), the Worker secrets and the upstream
 * transport (global fetch in google mode, the FAKE_GOOGLE binding in fake mode). Each port exposes exactly its
 * own methods, so the core never holds a binding, the env or a store method it has no port for.
 *
 * The env's config is validated here (GWS_INTERNAL naming the bad keys), and the transport and the token
 * cache's OAuth client both follow its upstream.
 */
export function workersPorts(env: Env): CorePorts {
  const config = loadConfig(env);
  const send = createTransport(env, config);
  const { accounts, grants, audit, rate } = openStore(env);
  const settings = openUserSettings(env);
  const kv = env.CACHE_KV;
  // Read on each use, never copied: a value is touched only by the code that needs it. Only secret names are
  // answered: the type alone does not stop a caller asking for a binding such as DB or LOADER.
  const secrets: SecretSource = { get: (name) => (isSecretName(name) ? env[name] : undefined) };
  return {
    sandbox: workersSandbox(env.LOADER),
    accounts: {
      resolve: accounts.resolve,
      listForUser: accounts.listForUser,
      setAlias: accounts.setAlias,
      setDefault: accounts.setDefault,
      getRefreshTokenForRevoke: accounts.getRefreshTokenForRevoke,
      wipeToken: accounts.wipeToken,
    },
    approval: { isAllowed: grants.isAllowed, list: grants.list, remove: grants.remove },
    tokens: {
      getAccessToken: (account) => getAccessToken(env, account, send),
      invalidate: (accountId) => invalidate(env, accountId),
    },
    links: {
      get: (key) => kv.get(key),
      put: (key, value, opts) => kv.put(key, value, opts),
      delete: (key) => kv.delete(key),
    },
    audit: { insertMany: audit.insertMany },
    rate: { hit: rate.hit },
    secrets,
    http: { upstream: config.GOOGLE_UPSTREAM, send },
    userSettings: { isSet: settings.isSet, get: settings.get, clear: settings.clear },
  };
}

/** The setting link page's port: the web app serves the page (src/web/pages/setting-link.ts) beside the MCP endpoint. */
export function workersSettingLinkPort(env: Env): SettingLinkPort {
  const settings = openUserSettings(env);
  return { version: settings.version };
}

/** The approval page's port: the web app serves the page (src/web/pages/approval-link.ts) beside the MCP endpoint. */
export function workersHumanApprovalPort(env: Env): HumanApprovalPort {
  const approvals = openApprovals(env);
  return { claim: approvals.claim };
}
