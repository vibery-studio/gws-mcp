import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProps } from "../../src/contracts";
import { createCallSession } from "../../src/core/dispatch";
import { runExecute } from "../../src/core/execute";
import { isGwsError } from "../../src/errors";
import { localPorts } from "../../src/local/ports";
import { LOCAL_USER_ID } from "../../src/local/store";
import { connectAtFake, localConfig, openLocal, stubFakeGoogle, tempDir } from "./helpers";

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const AUTH: AuthProps = { userId: LOCAL_USER_ID, clientId: "local" };

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
  vi.unstubAllGlobals();
});

async function local(upstream: "fake" | "google" = "fake") {
  const t = tempDir();
  const l = await openLocal(t.dir, upstream);
  cleanups.push(t.cleanup, () => l.store.close());
  return l;
}

describe("the local HTTP port (upstream derived from config)", () => {
  it("names the upstream its config names, in both modes", async () => {
    for (const mode of ["fake", "google"] as const) {
      const { store, secrets } = await local(mode);
      expect(localPorts({ config: localConfig({ GOOGLE_UPSTREAM: mode }), store, secrets }).http.upstream).toBe(mode);
    }
  });

  it("refuses a store whose database belongs to the other upstream, so stored real tokens never go to a fake", async () => {
    const { store, secrets } = await local("google");
    expect(() => localPorts({ config: localConfig({ GOOGLE_UPSTREAM: "fake" }), store, secrets })).toThrow(
      expect.objectContaining({ code: "GWS_INTERNAL", message: "the database belongs to the google upstream, but the config names fake" }),
    );
  });

  it("is refused by a session whose config names another upstream", async () => {
    const { store, secrets } = await local();
    const ports = localPorts({ config: localConfig({ GOOGLE_UPSTREAM: "fake" }), store, secrets });
    const sessionConfig = localConfig({ GOOGLE_UPSTREAM: "google" });
    expect(() => createCallSession({ ports, auth: AUTH, apply: false, executeId: "x-mismatch", config: sessionConfig })).toThrow(
      expect.objectContaining({ code: "GWS_INTERNAL", message: "the session config and the env disagree on the Google upstream" }),
    );
    const out = await runExecute({ code: "async () => 1", apply: false, auth: AUTH, ports, config: sessionConfig });
    expect(out).toMatchObject({ ok: false, error: { code: "GWS_INTERNAL" } });
  });

  it("in fake mode sends every request, the token refresh included, to the fake through ports.http.send", async () => {
    const fake = stubFakeGoogle();
    const { store, secrets } = await local();
    const config = localConfig();
    await connectAtFake(fake, config, store, "http-fake@fake.test", [DRIVE_FILE]);
    const ports = localPorts({ config, store, secrets });
    fake.seen.length = 0;
    const out = await runExecute({ code: "async () => (await sdk.drive.files.list({})).files", apply: false, auth: AUTH, ports, config });
    expect(out).toMatchObject({ ok: true, result: [] });
    expect(fake.seen).toEqual(["POST /oauth2.googleapis.com/token", "GET /www.googleapis.com/drive/v3/files"]);
  });

  it("in google mode sends to Google only, with the configured client, never to the fake", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      sent.push(`${req.method} ${url.origin}${url.pathname}`);
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await req.text());
        expect(form.get("client_id")).toBe("real-client.apps.googleusercontent.com");
        return Response.json({ access_token: "opaque-access-token-0001", expires_in: 3600, token_type: "Bearer" });
      }
      return Response.json({ files: [] });
    });
    const { store, secrets } = await local("google");
    await secrets.set("GOOGLE_CLIENT_ID", "real-client.apps.googleusercontent.com");
    await secrets.set("GOOGLE_CLIENT_SECRET", "GOCSPX-real-client-secret");
    const config = localConfig({ GOOGLE_UPSTREAM: "google" });
    await store.accounts.upsertConnected({ userId: LOCAL_USER_ID, email: "g@example.test", sub: "g-sub", scopes: [DRIVE_FILE], refreshToken: "opaque-refresh-token-0001" });
    const out = await runExecute({ code: "async () => (await sdk.drive.files.list({})).files", apply: false, auth: AUTH, ports: localPorts({ config, store, secrets }), config });
    expect(out).toMatchObject({ ok: true, result: [] });
    expect(sent).toEqual(["POST https://oauth2.googleapis.com/token", "GET https://www.googleapis.com/drive/v3/files"]);
  });
});

describe("the local approval port (one user, no client approval layer)", () => {
  it("allows every account of the user, lists them all, and refuses to remove one", async () => {
    const fake = stubFakeGoogle();
    const { store, secrets } = await local();
    const config = localConfig();
    const a = await connectAtFake(fake, config, store, "appr-a@fake.test", [DRIVE_FILE]);
    const b = await connectAtFake(fake, config, store, "appr-b@fake.test", [DRIVE_FILE]);
    const { approval } = localPorts({ config, store, secrets });
    expect(await approval.list(LOCAL_USER_ID, "any-client")).toEqual([a.account.id, b.account.id]);
    expect(await approval.isAllowed(LOCAL_USER_ID, "any-client", a.account.id)).toBe(true);
    expect(await approval.isAllowed(LOCAL_USER_ID, "any-client", "a_unknown")).toBe(false);
    expect(await approval.isAllowed("someone-else", "any-client", a.account.id)).toBe(false);
    const err = await approval.remove(LOCAL_USER_ID, "any-client", a.account.id).catch((e: unknown) => e);
    expect(isGwsError(err) && err.code).toBe("GWS_INVALID_INPUT");

    const out = await runExecute({ code: "async () => sdk.accounts.list({})", apply: false, auth: AUTH, ports: localPorts({ config, store, secrets }), config });
    expect(out).toMatchObject({ ok: true, result: { hiddenCount: 0, accounts: [{ email: "appr-a@fake.test" }, { email: "appr-b@fake.test" }] } });
  });
});

describe("local redaction of console output (every secret held, every token loaded)", () => {
  it("redacts the keychain secrets and non-Google-shaped tokens loaded from the store or sent upstream", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === "/token") return Response.json({ access_token: "opaque-access-token-0002", expires_in: 3600, token_type: "Bearer" });
      if (url.pathname === "/revoke") return new Response(null, { status: 200 });
      return Response.json({ files: [] });
    });
    const { store, secrets } = await local("google");
    await secrets.set("GOOGLE_CLIENT_ID", "client-id-0002.apps.googleusercontent.com");
    await secrets.set("GOOGLE_CLIENT_SECRET", "plain-client-secret-0002");
    const config = localConfig({ GOOGLE_UPSTREAM: "google" });
    await store.accounts.upsertConnected({ userId: LOCAL_USER_ID, email: "used@example.test", sub: "s-used", scopes: [DRIVE_FILE], refreshToken: "opaque-refresh-used-0002" });
    await store.accounts.upsertConnected({ userId: LOCAL_USER_ID, email: "gone@example.test", sub: "s-gone", scopes: [DRIVE_FILE], refreshToken: "opaque-refresh-gone-0002" });
    const ports = localPorts({ config, store, secrets });
    const key = secrets.source.get("TOKEN_ENC_KEY") ?? "";

    // Loads the first account's refresh token and mints an access token; disconnecting the second sends its token.
    const first = await runExecute({ code: "async () => sdk.drive.files.list({ account: 'used@example.test' })", apply: false, auth: AUTH, ports, config });
    expect(first.ok).toBe(true);
    const disconnect = await runExecute({ code: "async () => sdk.accounts.disconnect({ account: 'gone@example.test' })", apply: true, auth: AUTH, ports, config });
    expect(disconnect).toMatchObject({ ok: true });

    const leaks = [key, "plain-client-secret-0002", "opaque-refresh-used-0002", "opaque-access-token-0002", "opaque-refresh-gone-0002"];
    const code = `async () => { const v = ${JSON.stringify(leaks)}; console.log(v.join(" ")); throw new Error("ended: " + v.join(" ")); }`;
    const out = await runExecute({ code, apply: false, auth: AUTH, ports, config });
    const redacted = leaks.map(() => "[REDACTED]").join(" ");
    expect(out.logs).toEqual([redacted]);
    expect(out.error).toEqual({ code: "GWS_EXECUTION_ERROR", message: `ended: ${redacted}` });
    expect(JSON.stringify(out)).not.toMatch(/opaque-|plain-client-secret/);
  });
});
