import type { Config } from "../config";
import type { ApprovalPort, CorePorts, SandboxPort } from "../core/ports";
import { GwsError } from "../errors";
import { createGoogleOAuth } from "../google/oauth";
import { createTransport, type FakeGoogleFetcher, type Transport } from "../google/transport";
import { localSandbox } from "./sandbox";
import type { LocalSecrets, Redactor } from "./secrets";
import type { LocalStore } from "./store";

/** Form fields of an OAuth request that carry a credential. */
const CREDENTIAL_FIELDS = ["refresh_token", "token", "code", "code_verifier", "client_secret"] as const;
const OAUTH_HOST = "oauth2.googleapis.com";

/** Remembers every credential a request carries (bearer token, OAuth form fields) for redaction. */
function rememberCredentials(url: string, init: RequestInit | undefined, redactor: Redactor): void {
  const auth = new Headers(init?.headers).get("authorization");
  const bearer = auth === null ? null : /^Bearer\s+(\S+)$/i.exec(auth);
  if (bearer?.[1] !== undefined) redactor.remember(bearer[1]);
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  if (host !== OAUTH_HOST || typeof init?.body !== "string") return;
  const form = new URLSearchParams(init.body);
  for (const field of CREDENTIAL_FIELDS) {
    const value = form.get(field);
    if (value) redactor.remember(value);
  }
}

/**
 * The local upstream transport, derived from `config` alone: `google` mode sends to Google with the global fetch;
 * `fake` mode sends to the fake Google at FAKE_GOOGLE_PUBLIC_URL (the transport's `http://fake-google/{host}/{path}`
 * form, re-based there). The Google host allowlist and `redirect: "manual"` of the shared transport apply in both.
 */
function localTransport(config: Config, redactor: Redactor): Transport {
  const fakeUrl = config.GOOGLE_UPSTREAM === "fake" ? config.FAKE_GOOGLE_PUBLIC_URL : undefined;
  const fake: FakeGoogleFetcher | undefined =
    fakeUrl === undefined
      ? undefined
      : {
          fetch: (input, init) => {
            const u = new URL(input);
            return globalThis.fetch(new URL(`${u.pathname}${u.search}`, fakeUrl), init);
          },
        };
  const inner = createTransport(fake === undefined ? {} : { FAKE_GOOGLE: fake }, config);
  return (url, init) => {
    rememberCredentials(url, init, redactor);
    return inner(url, init);
  };
}

/**
 * The single local user's approval: every account of the user is available to the local process (stdio is the
 * user's own process; there are no MCP clients to approve). `list` is all of the user's accounts. `remove`
 * refuses: there is no per-app list to remove from, and pretending to would leave the account in use.
 */
function localApproval(accounts: LocalStore["accounts"]): ApprovalPort {
  return {
    isAllowed: async (userId, _clientId, accountId) => (await accounts.listForUser(userId)).some((a) => a.id === accountId),
    list: async (userId) => (await accounts.listForUser(userId)).map((a) => a.id),
    remove: async () => {
      throw new GwsError(
        "GWS_INVALID_INPUT",
        "the local server has no per-app access list: every connected account is available to it. Disconnect the account to stop using it",
      );
    },
  };
}

export interface LocalPortsOptions {
  /**
   * The one config value the HTTP port, the token cache's OAuth client and the session must share. The HTTP
   * port's upstream is read from it, never passed separately, so it always names where `send` really goes.
   */
  config: Config;
  store: LocalStore;
  secrets: LocalSecrets;
  /** The QuickJS sandbox, redacting through the secrets' redactor and sized by `config`, when omitted. */
  sandbox?: SandboxPort;
}

/**
 * The local adapters for every core port: the QuickJS sandbox, the SQLite store (accounts, link records, audit,
 * rate counters), the in-memory encrypted token cache, the keychain secrets and the upstream transport. Like the
 * Workers composition, each port exposes exactly its own methods, and the transport, the token cache's OAuth client
 * and the upstream label all follow `config`.
 */
export function localPorts(opts: LocalPortsOptions): CorePorts {
  const { config, store, secrets } = opts;
  if (store.upstream !== config.GOOGLE_UPSTREAM) {
    throw new GwsError("GWS_INTERNAL", `the database belongs to the ${store.upstream} upstream, but the config names ${config.GOOGLE_UPSTREAM}`);
  }
  const send = localTransport(config, secrets.redactor);
  const tokens = store.tokenCache(createGoogleOAuth(config, secrets.source, send));
  const { accounts } = store;
  return {
    // The bridge caps follow the active config, like every other limit.
    sandbox: opts.sandbox ?? localSandbox({ redact: secrets.redactor.redact, callInputMaxBytes: config.CALL_INPUT_MAX_BYTES }),
    accounts: {
      resolve: accounts.resolve,
      listForUser: accounts.listForUser,
      setAlias: accounts.setAlias,
      setDefault: accounts.setDefault,
      getRefreshTokenForRevoke: accounts.getRefreshTokenForRevoke,
      wipeToken: accounts.wipeToken,
    },
    approval: localApproval(accounts),
    tokens,
    links: store.links,
    audit: store.audit,
    rate: store.rate,
    secrets: secrets.source,
    http: { upstream: config.GOOGLE_UPSTREAM, send },
  };
}
