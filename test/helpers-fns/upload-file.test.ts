import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { PENDING_TOKEN_PREFIX, type AuthProps } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const UPLOAD = "helpers.uploadDriveFile";
const store = openStore(env);
const baseConfig = loadConfig(env);
const pending = (ref: string) => `${PENDING_TOKEN_PREFIX}${ref}`;

async function client() {
  const email = uniqueEmail("h-up");
  const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}drive.file`], isDefault: true });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }] });
  const auth: AuthProps = { userId: seeded.userId, clientId: `client-${crypto.randomUUID()}` };
  await store.grants.add(auth.userId, auth.clientId, seeded.account.id);
  return { email, auth };
}

function session(auth: AuthProps, apply: boolean) {
  const executeId = `x-${crypto.randomUUID()}`;
  return { s: createCallSession({ ports: workersPorts(env), auth, apply, executeId, config: baseConfig }), executeId };
}

function valueOf(r: DispatchResult): Record<string, unknown> {
  if (!("ok" in r)) throw new Error(`expected a value result, got ${JSON.stringify(r)}`);
  return r.value as Record<string, unknown>;
}

async function driveFiles(email: string): Promise<string[]> {
  const { resources } = await fake.state(email);
  return Object.keys(resources).filter((k) => k.startsWith(`drive:file:${email}:`));
}

const bytesOf = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

describe("helpers.uploadDriveFile", () => {
  it("dry-run plans one create step and stores nothing", async () => {
    const { email, auth } = await client();
    const before = await driveFiles(email);
    const logBefore = (await fake.requests(email)).length;
    const { s, executeId } = session(auth, false);

    const out = valueOf(await s.dispatch(UPLOAD, { name: "hello.txt", mimeType: "text/plain", text: "hello" }));

    expect(out).toEqual({ applied: false, step: "s1" });
    expect(s.plan).toHaveLength(1);
    expect(s.plan[0]).toMatchObject({ step: "s1", fn: "drive.files.create", account: email, effect: "write", destructive: false });
    expect(s.plan[0]?.request?.method).toBe("POST");
    expect(await fake.requests(email)).toHaveLength(logBefore);
    expect(await driveFiles(email)).toEqual(before);

    await s.close();
    const { results } = await env.DB.prepare("SELECT fn, applied FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
    expect(results.map((r) => [r.fn, r.applied])).toEqual([["drive.files.create", 0], [UPLOAD, 0]]);
  });

  it("apply uploads the file and a later alt=media read returns the same bytes", async () => {
    const { auth } = await client();
    const data = Uint8Array.from([0, 1, 2, 13, 10, 45, 45, 255, 254]);
    const { s, executeId } = session(auth, true);

    const out = valueOf(
      await s.dispatch(UPLOAD, { name: "blob.bin", mimeType: "application/octet-stream", dataBase64: btoa(String.fromCharCode(...data)), parents: ["seed-folder-projects"] }),
    );

    expect(out).toMatchObject({ applied: true, name: "blob.bin", mimeType: "application/octet-stream" });
    expect(typeof out.id).toBe("string");
    expect(String(out.webViewLink)).toContain(String(out.id));
    const media = valueOf(await session(auth, false).s.dispatch("drive.files.get", { fileId: out.id, alt: "media" }));
    expect(media.mimeType).toBe("application/octet-stream");
    expect(bytesOf(media.dataBase64 as string)).toEqual(data);
    const meta = valueOf(await session(auth, false).s.dispatch("drive.files.get", { fileId: out.id, fields: "id,name,parents" }));
    expect(meta).toMatchObject({ name: "blob.bin", parents: ["seed-folder-projects"] });

    await s.close();
    const { results } = await env.DB.prepare("SELECT fn, applied FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
    expect(results.map((r) => [r.fn, r.applied])).toEqual([["drive.files.create", 1], [UPLOAD, 1]]);
  });

  it("uploads text as UTF-8", async () => {
    const { auth } = await client();
    const out = valueOf(await session(auth, true).s.dispatch(UPLOAD, { name: "vi.txt", mimeType: "text/plain", text: "Xin chào ✓" }));
    const media = valueOf(await session(auth, false).s.dispatch("drive.files.get", { fileId: out.id, alt: "media" }));
    expect(new TextDecoder().decode(bytesOf(media.dataBase64 as string))).toBe("Xin chào ✓");
  });

  it("rejects input with neither or both of dataBase64 and text, a bad mime type, bad base64 or no name", async () => {
    const { auth } = await client();
    const { s } = session(auth, true);
    for (const bad of [
      { name: "a", mimeType: "text/plain" },
      { name: "a", mimeType: "text/plain", text: "x", dataBase64: "eA==" },
      { name: "a", mimeType: "text/plain\r\nX: y", text: "x" },
      { name: "a", mimeType: "text/plain", dataBase64: "not base64!" },
      { name: "", mimeType: "text/plain", text: "x" },
    ]) {
      const r = await s.dispatch(UPLOAD, bad);
      expect("__gwsError" in r && r.__gwsError.code, JSON.stringify(bad)).toBe("GWS_INVALID_INPUT");
    }
  });

  it("plans an upload into a folder created in the same dry-run as incomplete, and runs neither", async () => {
    const { email, auth } = await client();
    const before = await driveFiles(email);
    const { s } = session(auth, false);
    expect(await s.dispatch("drive.files.create", { requestBody: { name: "Inbox", mimeType: "application/vnd.google-apps.folder" } })).toEqual({ __gwsPending: "s1" });
    const r = await s.dispatch(UPLOAD, { name: "a.txt", mimeType: "text/plain", text: "x", parents: [pending("s1.id")] });
    expect(r).toEqual({ __gwsPending: "s2" });
    expect(s.plan[1]).toMatchObject({ step: "s2", fn: UPLOAD, effect: "write", incomplete: true, dependsOn: ["s1"] });
    expect(s.plan.filter((p) => p.fn === "drive.files.create")).toHaveLength(1);
    expect(await driveFiles(email)).toEqual(before);
  });
});
