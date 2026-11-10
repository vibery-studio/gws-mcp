import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { publicBaseUrl } from "../../src/config";
import { openStore } from "../../src/store/db";
import { Browser, seedGoogle, signIn, userIdFor } from "../auth/browser";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, fakeFetch, uniqueEmail } from "../helpers/fake";
import { callWorker, envWithoutBaseUrl, mintMcpToken } from "../helpers/mcp-token";

const call = (url: string, workerEnv: Env, init: RequestInit = {}) => callWorker(new Request(url, { redirect: "manual", ...init }), workerEnv);

/** The Google redirect URI /login sends the browser to Google with. */
async function loginRedirectUri(url: string, workerEnv: Env, init: RequestInit = {}): Promise<string | null> {
  const res = await call(url, workerEnv, init);
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "").searchParams.get("redirect_uri");
}

/** A browser whose requests reach the Worker without the PUBLIC_BASE_URL override. */
const derivedBrowser = () => new Browser((r) => callWorker(r, envWithoutBaseUrl()));

/** One `execute` snippet through `<origin>/mcp` on the Worker without the override; returns the execute output. */
async function executeAt(origin: string, accessToken: string, code: string): Promise<{ status: number; out?: { ok: boolean; result?: unknown } }> {
  const res = await call(`${origin}/mcp`, envWithoutBaseUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      host: new URL(origin).host,
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute", arguments: { code } } }),
  });
  const body = await res.text();
  if (res.status !== 200) return { status: res.status };
  const json = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? (body.split("\n").filter((l) => l.startsWith("data:")).at(-1) ?? "").slice(5)
    : body;
  const text = (JSON.parse(json) as { result?: { content?: Array<{ text: string }> } }).result?.content?.[0]?.text ?? "";
  return { status: res.status, out: JSON.parse(text) as { ok: boolean; result?: unknown } };
}

describe("publicBaseUrl", () => {
  it("uses the PUBLIC_BASE_URL override when set, whatever URL the request arrived on", () => {
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "https://gws.example.com/" }, "https://other.example/login")).toBe("https://gws.example.com");
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "http://localhost:8787" }, "http://127.0.0.1/x")).toBe("http://localhost:8787");
  });

  it("derives the origin of the request URL when unset (or empty)", () => {
    for (const unset of [{}, { PUBLIC_BASE_URL: undefined }, { PUBLIC_BASE_URL: "" }]) {
      expect(publicBaseUrl(unset, "https://gws-mcp.example.workers.dev/mcp?x=1")).toBe("https://gws-mcp.example.workers.dev");
    }
    expect(publicBaseUrl({}, "https://GWS.Example.COM:443/a")).toBe("https://gws.example.com");
    expect(publicBaseUrl({}, "http://localhost:8787/login")).toBe("http://localhost:8787");
    expect(publicBaseUrl({}, "http://[::1]:8787/")).toBe("http://[::1]:8787");
  });

  it("refuses a derived origin the override check would refuse: plain http off loopback, or no URL at all", () => {
    for (const url of ["http://gws.example.com/login", "http://localhost.evil.example/", "ftp://gws.example.com/", "not a url"]) {
      expect(publicBaseUrl({}, url), url).toBeNull();
    }
  });

  it("throws GWS_INTERNAL naming only the key for an invalid override", () => {
    for (const bad of ["http://gws.example.com", "https://gws.example.com/app", "nope", 42]) {
      expect(() => publicBaseUrl({ PUBLIC_BASE_URL: bad }, "https://gws.example.com/"), String(bad)).toThrow("invalid config: PUBLIC_BASE_URL");
    }
  });
});

describe("the Worker without PUBLIC_BASE_URL", () => {
  it("builds the Google redirect URI from the request's origin", async () => {
    expect(await loginRedirectUri("http://localhost/login", envWithoutBaseUrl())).toBe("http://localhost/google/callback");
    expect(await loginRedirectUri("https://gws-mcp.example.workers.dev/login", envWithoutBaseUrl())).toBe("https://gws-mcp.example.workers.dev/google/callback");
  });

  it("advertises the request's origin as issuer and protected resource, and challenges with it", async () => {
    const base = "https://gws-mcp.example.workers.dev";
    const as = (await (await call(`${base}/.well-known/oauth-authorization-server`, envWithoutBaseUrl())).json()) as { issuer: string; token_endpoint: string };
    expect(as.issuer).toBe(base);
    expect(as.token_endpoint).toBe(`${base}/oauth/token`);
    const pr = (await (await call(`${base}/.well-known/oauth-protected-resource/mcp`, envWithoutBaseUrl())).json()) as { resource: string };
    expect(pr.resource).toBe(`${base}/mcp`);
    const unauth = await call(`${base}/mcp`, envWithoutBaseUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("never reads forwarding headers: X-Forwarded-Host and Forwarded change no public URL", async () => {
    const headers = { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", forwarded: "host=evil.example;proto=https", "x-original-host": "evil.example" };
    expect(await loginRedirectUri("http://localhost/login", envWithoutBaseUrl(), { headers })).toBe("http://localhost/google/callback");
    const meta = (await (await call("http://localhost/.well-known/oauth-authorization-server", envWithoutBaseUrl(), { headers })).json()) as { issuer: string };
    expect(meta.issuer).toBe("http://localhost");
  });

  it("refuses plain http off loopback before any handler runs", async () => {
    for (const path of ["/login", "/mcp", "/.well-known/oauth-authorization-server", "/oauth/register"]) {
      const res = await call(`http://gws.example.com${path}`, envWithoutBaseUrl(), path === "/login" ? {} : { method: "POST", body: "{}" });
      expect(res.status, path).toBe(400);
      expect(await res.text()).toBe("This server accepts only https requests.\n");
    }
  });

  it("leaves a forged host harmless: Google refuses any redirect URI that is not registered exactly", async () => {
    // The test's Google client (the fake) registers only http://localhost/google/callback.
    for (const url of ["https://attacker.example/login", "http://127.0.0.1/login", "http://localhost:8787/login"]) {
      const res = await call(url, envWithoutBaseUrl());
      const authUrl = new URL(res.headers.get("location") ?? "");
      expect(authUrl.searchParams.get("redirect_uri")).toBe(`${new URL(url).origin}/google/callback`);
      const picker = await fakeFetch(`${authUrl.pathname}${authUrl.search}`);
      expect(picker.status, url).toBe(400);
      expect(picker.headers.get("location"), url).toBeNull();
    }
    const registered = new URL((await call("http://localhost/login", envWithoutBaseUrl())).headers.get("location") ?? "");
    expect((await fakeFetch(`${registered.pathname}${registered.search}`)).status).toBe(200);
  });

  it("builds signed-in pages' links and the form Origin check from the origin the page is served on", async () => {
    const email = uniqueEmail("derived-pages");
    const sub = await seedGoogle(email);
    const browser = derivedBrowser();
    // Sign-in completes only on the origin registered at Google.
    expect((await signIn(browser, email)).status).toBe(302);
    const [account] = await openStore(env).accounts.listForUser(userIdFor(sub));
    if (!account) throw new Error("setup account missing");

    // The same session served on another origin of the same Worker: the connector address follows that origin.
    const other = "http://127.0.0.1:8787";
    const apps = await (await browser.fetch(`${other}/apps`)).text();
    expect(apps).toContain(`${other}/mcp`);
    expect(apps).not.toContain("http://localhost/mcp");
    const csrf = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(apps)?.[1] ?? "";
    expect(csrf).not.toBe("");

    const rename = (origin: string) =>
      browser.fetch(`${other}/accounts/${encodeURIComponent(account.id)}/name`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin },
        body: new URLSearchParams([["csrf", csrf], ["alias", "derived"]]).toString(),
      });
    // A form posted from the sign-in origin is another site from here.
    expect((await rename("http://localhost")).status).toBe(403);
    expect((await openStore(env).accounts.listForUser(userIdFor(sub)))[0]?.alias).not.toBe("derived");
    expect([401, 403].includes((await rename(other)).status)).toBe(false);
    expect((await openStore(env).accounts.listForUser(userIdFor(sub)))[0]?.alias).toBe("derived");
  });

  it("binds MCP tokens to the origin they were issued for, and builds execute's links from it", async () => {
    const origin = "http://127.0.0.1:8787";
    const email = uniqueEmail("derived-mcp");
    const seeded = await seedUserWithAccount(env, { email, scopes: ["https://www.googleapis.com/auth/drive.file"], isDefault: true });
    await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }] });
    const token = await mintMcpToken({ userId: seeded.userId, accountIds: [seeded.account.id], origin });

    const linked = await executeAt(origin, token.accessToken, 'async () => sdk.accounts.connect({ services: ["sheets"] })');
    expect(linked.status).toBe(200);
    expect((linked.out?.result as { url: string }).url).toMatch(/^http:\/\/127\.0\.0\.1:8787\/connect\/start\?t=[A-Za-z0-9_-]{43}$/);

    // The token's audience is <origin>/mcp: the same Worker reached on another origin refuses it.
    for (const elsewhere of ["http://localhost", "http://localhost:8787", "https://gws-mcp.example.workers.dev"]) {
      expect((await executeAt(elsewhere, token.accessToken, "async () => 1")).status, elsewhere).toBe(401);
    }
  });
});

describe("the Worker with the PUBLIC_BASE_URL override", () => {
  const overridden = (): Env => ({ ...env, PUBLIC_BASE_URL: "https://gws.example.com" }) as unknown as Env;

  it("uses the override for every public URL, whatever host the request names", async () => {
    expect(await loginRedirectUri("http://localhost/login", overridden())).toBe("https://gws.example.com/google/callback");
    const mcp = (url: string) => call(url, overridden(), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const unauth = await mcp("https://gws.example.com/mcp");
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain('resource_metadata="https://gws.example.com/.well-known/oauth-protected-resource/mcp"');
    // On any other host the provider still answers 401 but advertises no metadata for an alias (RFC 9728 §3.3).
    const alias = await mcp("http://localhost/mcp");
    expect(alias.status).toBe(401);
    expect(alias.headers.get("www-authenticate")).not.toContain("resource_metadata");
  });

  it("serves plain http requests too: the override, not the request, decides the public URLs", async () => {
    expect((await call("http://gws.example.com/login", overridden())).status).toBe(302);
  });
});
