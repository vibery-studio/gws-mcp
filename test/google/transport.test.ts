import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GwsError } from "../../src/errors";
import type { Transport as OAuthTransport } from "../../src/google/oauth";
import { createTransport } from "../../src/google/transport";
import { fake } from "../helpers/fake";

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

/** A FAKE_GOOGLE stand-in that records each call and answers with `respond`. */
function capturingBinding(respond: () => Response = () => new Response("ok")) {
  const calls: Captured[] = [];
  return {
    calls,
    env: {
      FAKE_GOOGLE: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          calls.push({ url: String(input), init });
          return respond();
        },
      },
    },
  };
}

/** Replaces the global fetch for google-mode tests; never lets a test reach the network. */
function stubGlobalFetch(respond: () => Response = () => new Response("ok")) {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  });
  return calls;
}

async function rejection(p: Promise<unknown>): Promise<GwsError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof GwsError) return e;
    throw e;
  }
  throw new Error("expected a GwsError");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fake mode", () => {
  it("rewrites https://{host}/{path}?q to the host-prefixed fake path", async () => {
    const b = capturingBinding();
    const t = createTransport(b.env, { GOOGLE_UPSTREAM: "fake" });
    const res = await t("https://www.googleapis.com/drive/v3/files/a%2Fb?q=name%20contains%20%27x%27&pageSize=2", {
      method: "GET",
    });
    expect(await res.text()).toBe("ok");
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0]?.url).toBe(
      "http://fake-google/www.googleapis.com/drive/v3/files/a%2Fb?q=name%20contains%20%27x%27&pageSize=2",
    );
  });

  it("reaches the FAKE_GOOGLE service binding", async () => {
    const id = crypto.randomUUID();
    await fake.fault({
      method: "GET",
      pathRegex: `^/gmail\\.googleapis\\.com/gmail/v1/transport-probe-${id}$`,
      times: 1,
      response: { status: 418, body: { probe: id } },
    });
    const t = createTransport(env, { GOOGLE_UPSTREAM: "fake" });
    const res = await t(`https://gmail.googleapis.com/gmail/v1/transport-probe-${id}`, { method: "GET" });
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ probe: id });
  });

  it("does not retry a write when the upstream fault fires once", async () => {
    const id = crypto.randomUUID();
    await fake.fault({
      method: "POST",
      pathRegex: `^/www\\.googleapis\\.com/drive/v3/transport-write-${id}$`,
      times: 1,
      response: { status: 503, body: { error: { code: 503, message: "unavailable", status: "UNAVAILABLE" } } },
    });
    const t = createTransport(env, { GOOGLE_UPSTREAM: "fake" });
    const url = `https://www.googleapis.com/drive/v3/transport-write-${id}`;
    // A retry would consume the fault and return the route's 404 instead of the 503.
    const first = await t(url, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(first.status).toBe(503);
    const second = await t(url, { method: "POST", body: "{}" });
    expect(second.status).toBe(404);
  });

  it("fails with GWS_INTERNAL when the FAKE_GOOGLE binding is missing", async () => {
    const t = createTransport({}, { GOOGLE_UPSTREAM: "fake" });
    const err = await rejection(t("https://www.googleapis.com/drive/v3/files", { method: "GET" }));
    expect(err.code).toBe("GWS_INTERNAL");
    expect(err.details).toEqual({ reason: "fake-binding-missing" });
  });

  it("refuses a host outside the Google allowlist without calling the binding", async () => {
    const b = capturingBinding();
    const t = createTransport(b.env, { GOOGLE_UPSTREAM: "fake" });
    const e = await rejection(t("https://evil.example/drive/v3/files", { method: "GET" }));
    expect(e.code).toBe("GWS_INTERNAL");
    expect(b.calls).toHaveLength(0);
  });

  it("fits the OAuth client's transport seam and works without init", async () => {
    const b = capturingBinding();
    const t: OAuthTransport = createTransport(b.env, { GOOGLE_UPSTREAM: "fake" });
    await t("https://openidconnect.googleapis.com/v1/userinfo");
    expect(b.calls[0]?.url).toBe("http://fake-google/openidconnect.googleapis.com/v1/userinfo");
    expect(b.calls[0]?.init?.redirect).toBe("manual");
  });

  it("always asks the binding not to follow redirects", async () => {
    const b = capturingBinding();
    const t = createTransport(b.env, { GOOGLE_UPSTREAM: "fake" });
    await t("https://www.googleapis.com/drive/v3/files", {
      method: "GET",
      redirect: "follow",
      headers: { authorization: "Bearer ya29.x" },
    });
    expect(b.calls[0]?.init?.redirect).toBe("manual");
  });
});

describe("google mode", () => {
  it("calls the global fetch with the unchanged URL for an allowlisted host", async () => {
    const calls = stubGlobalFetch();
    const t = createTransport(capturingBinding().env, { GOOGLE_UPSTREAM: "google" });
    await t("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1", { method: "GET" });
    expect(calls.map((c) => c.url)).toEqual(["https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1"]);
  });

  it("needs no FAKE_GOOGLE binding", async () => {
    const calls = stubGlobalFetch();
    const t = createTransport({}, { GOOGLE_UPSTREAM: "google" });
    const res = await t("https://www.googleapis.com/drive/v3/files", { method: "GET" });
    expect(await res.text()).toBe("ok");
    expect(calls.map((c) => c.url)).toEqual(["https://www.googleapis.com/drive/v3/files"]);
  });

  it.each([
    "https://evil.example/drive/v3/files",
    "https://www.googleapis.com.evil.example/drive/v3/files",
    "http://www.googleapis.com/drive/v3/files",
    "https://user:pass@www.googleapis.com/drive/v3/files",
    "https://user@www.googleapis.com/drive/v3/files",
    "https://:pass@www.googleapis.com/drive/v3/files",
    "https://www.googleapis.com:8443/drive/v3/files",
    "not a url",
  ])("refuses %s without calling fetch", async (url) => {
    const calls = stubGlobalFetch();
    const t = createTransport(capturingBinding().env, { GOOGLE_UPSTREAM: "google" });
    const e = await rejection(t(url, { method: "GET" }));
    expect(e.code).toBe("GWS_INTERNAL");
    expect(calls).toHaveLength(0);
  });

  it("always sends redirect: manual, so a bearer token never follows a redirect", async () => {
    const calls = stubGlobalFetch();
    const t = createTransport(capturingBinding().env, { GOOGLE_UPSTREAM: "google" });
    await t("https://www.googleapis.com/drive/v3/files", {
      method: "GET",
      redirect: "follow",
      headers: { authorization: "Bearer ya29.x" },
    });
    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  it("does not retry a write that fails", async () => {
    const calls = stubGlobalFetch(() => new Response("unavailable", { status: 503 }));
    const t = createTransport(capturingBinding().env, { GOOGLE_UPSTREAM: "google" });
    const res = await t("https://www.googleapis.com/drive/v3/files", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a write when the network call throws", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw new TypeError("network down");
    });
    const t = createTransport(capturingBinding().env, { GOOGLE_UPSTREAM: "google" });
    await expect(t("https://www.googleapis.com/drive/v3/files", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
