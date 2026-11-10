import { GOOGLE_HOSTS, type Config } from "../config";
import { GwsError } from "../errors";

/** The single upstream HTTP seam. Only this module chooses where a Google request really goes. */
export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

/** What the transport needs of the fake's binding: a fetch. Structural, so this module stays platform-free. */
export interface FakeGoogleFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/**
 * FAKE_GOOGLE is bound only where the upstream is the fake (tests, a fake-mode deployment); `google` mode never
 * reads it. `object &` accepts an env without the binding, which an all-optional type alone would reject.
 */
export type TransportEnv = object & { readonly FAKE_GOOGLE?: FakeGoogleFetcher };

/** Origin used for the FAKE_GOOGLE service binding; the binding ignores the host. */
const FAKE_ORIGIN = "http://fake-google";

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(GOOGLE_HOSTS);

/**
 * Parses `url` and asserts it targets an allowlisted Google host over plain https on the default
 * port, without credentials. Shared by the request builder (after template expansion) and the transport.
 */
export function assertGoogleUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GwsError("GWS_INTERNAL", "upstream URL is not valid", { details: { reason: "host-not-allowed" } });
  }
  const ok =
    parsed.protocol === "https:" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    ALLOWED_HOSTS.has(parsed.hostname);
  if (!ok) throw new GwsError("GWS_INTERNAL", "upstream host is not an allowed Google host", { details: { reason: "host-not-allowed" } });
  return parsed;
}

/**
 * `google` mode: the global fetch, only for allowlisted Google hosts. `fake` mode: the same allowlist, then
 * `https://{host}/{path}?q` is sent to `http://fake-google/{host}/{path}?q` through the FAKE_GOOGLE binding.
 *
 * Every call uses `redirect: "manual"`: requests carry bearer tokens, and a followed redirect would hand the
 * token to whatever host the redirect names. The transport never retries (a retried write could run twice)
 * and never logs.
 */
export function createTransport(env: TransportEnv, config: Pick<Config, "GOOGLE_UPSTREAM">): Transport {
  return async (url, init) => {
    const target = assertGoogleUrl(url);
    const safeInit: RequestInit = { ...init, redirect: "manual" };
    if (config.GOOGLE_UPSTREAM === "google") return globalThis.fetch(target.href, safeInit);
    if (!env.FAKE_GOOGLE) {
      throw new GwsError("GWS_INTERNAL", "fake upstream mode needs the FAKE_GOOGLE binding", {
        details: { reason: "fake-binding-missing" },
      });
    }
    return env.FAKE_GOOGLE.fetch(`${FAKE_ORIGIN}/${target.hostname}${target.pathname}${target.search}`, safeInit);
  };
}
