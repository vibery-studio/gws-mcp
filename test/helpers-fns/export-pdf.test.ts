import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../../src/config";
import { PENDING_TOKEN_PREFIX, type AuthProps } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const EXPORT = "helpers.exportDocPdf";
const store = openStore(env);
const baseConfig = loadConfig(env);
const pending = (ref: string) => `${PENDING_TOKEN_PREFIX}${ref}`;

async function client() {
  const email = uniqueEmail("h-pdf");
  const seeded = await seedUserWithAccount(env, { email, scopes: [`${G}documents`, `${G}drive.file`], isDefault: true });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "default" }] });
  const auth: AuthProps = { userId: seeded.userId, clientId: `client-${crypto.randomUUID()}` };
  await store.grants.add(auth.userId, auth.clientId, seeded.account.id);
  return { email, auth };
}

function session(auth: AuthProps, apply: boolean, config: Partial<Config> = {}) {
  const executeId = `x-${crypto.randomUUID()}`;
  return { s: createCallSession({ ports: workersPorts(env), auth, apply, executeId, config: { ...baseConfig, ...config } }), executeId };
}

function valueOf(r: DispatchResult): Record<string, unknown> {
  if (!("ok" in r)) throw new Error(`expected a value result, got ${JSON.stringify(r)}`);
  return r.value as Record<string, unknown>;
}

async function createDoc(auth: AuthProps, title: string): Promise<string> {
  const { s } = session(auth, true);
  return valueOf(await s.dispatch("docs.documents.create", { requestBody: { title } })).documentId as string;
}

describe("helpers.exportDocPdf", () => {
  it.each([false, true])("exports a created document as a PDF (apply=%s)", async (apply) => {
    const { email, auth } = await client();
    const documentId = await createDoc(auth, "Quarterly report");
    const { s, executeId } = session(auth, apply);

    const out = valueOf(await s.dispatch(EXPORT, { documentId }));

    expect(out.mimeType).toBe("application/pdf");
    const bytes = Uint8Array.from(atob(out.dataBase64 as string), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("%PDF");
    expect(out.sizeBytes).toBe(bytes.length);
    expect(s.plan).toEqual([]);
    const exports = (await fake.requests(email)).filter((q) => q.path.endsWith(`/files/${documentId}/export`));
    expect(exports).toHaveLength(1);
    expect(exports[0]?.query).toMatchObject({ mimeType: "application/pdf" });

    await s.close();
    const { results } = await env.DB.prepare("SELECT fn, applied, status FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
    expect(results.map((r) => [r.fn, r.applied, r.status])).toEqual([["drive.files.export", 0, "ok"], [EXPORT, 0, "ok"]]);
  });

  it("fails with GWS_RESPONSE_TOO_LARGE when the export is over the response cap", async () => {
    const { auth } = await client();
    const documentId = await createDoc(auth, "Big");
    const { s } = session(auth, false, { CALL_RESPONSE_MAX_BYTES: 20 });
    const r = await s.dispatch(EXPORT, { documentId });
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_RESPONSE_TOO_LARGE");
  });

  it("surfaces an upstream error for a file that is not a document", async () => {
    const { auth } = await client();
    const { s } = session(auth, false);
    const r = await s.dispatch(EXPORT, { documentId: "seed-file-readme" });
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_UPSTREAM_ERROR");
  });

  it("rejects a missing document id and unknown fields", async () => {
    const { auth } = await client();
    const { s } = session(auth, false);
    for (const bad of [{}, { documentId: "" }, { documentId: "x", mimeType: "text/plain" }]) {
      const r = await s.dispatch(EXPORT, bad);
      expect("__gwsError" in r && r.__gwsError.code, JSON.stringify(bad)).toBe("GWS_INVALID_INPUT");
    }
  });

  it("plans an export of a document created in the same dry-run as incomplete and does not run it", async () => {
    const { email, auth } = await client();
    const { s } = session(auth, false);
    expect(await s.dispatch("docs.documents.create", { requestBody: { title: "Later" } })).toEqual({ __gwsPending: "s1" });
    const r = await s.dispatch(EXPORT, { documentId: pending("s1.documentId") });
    expect(r).toEqual({ __gwsPending: "s2" });
    expect(s.plan[1]).toMatchObject({ step: "s2", fn: EXPORT, effect: "read", incomplete: true, dependsOn: ["s1"] });
    expect((await fake.requests(email)).some((q) => q.path.endsWith("/export"))).toBe(false);
  });
});
