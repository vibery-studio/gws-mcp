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
const SEND = "helpers.sendMailWithAttachment";
const store = openStore(env);
const baseConfig = loadConfig(env);
const pending = (ref: string) => `${PENDING_TOKEN_PREFIX}${ref}`;
const PDF_B64 = btoa("%PDF-1.4 fake");

async function client(scopes: string[] = [`${G}gmail.send`, `${G}drive.file`]) {
  const email = uniqueEmail("h-mail");
  const seeded = await seedUserWithAccount(env, { email, scopes, isDefault: true });
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

async function sentMessages(email: string): Promise<Array<{ subject?: string; raw?: string; to?: string }>> {
  const { resources } = await fake.state(email);
  return Object.entries(resources)
    .filter(([k]) => k.startsWith(`gmail:message:${email}:`))
    .map(([, v]) => v as { subject?: string; raw?: string; to?: string })
    .filter((m) => (m as { labelIds?: string[] }).labelIds?.includes("SENT"));
}

function decodeRaw(raw: string): string {
  return atob(raw.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (raw.length % 4)) % 4));
}

async function auditRows(executeId: string): Promise<Array<{ fn: string; applied: number; status: string }>> {
  const { results } = await env.DB.prepare("SELECT fn, applied, status FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
  return results as Array<{ fn: string; applied: number; status: string }>;
}

const INPUT = {
  to: ["bob@example.test"],
  cc: ["carol@example.test"],
  subject: "Báo cáo tháng 11",
  text: "Please find the report attached.",
  attachments: [{ filename: "report.pdf", mimeType: "application/pdf", dataBase64: PDF_B64 }],
};

describe("helpers.sendMailWithAttachment", () => {
  it("dry-run plans one send step and sends nothing", async () => {
    const { email, auth } = await client();
    const before = await sentMessages(email);
    const logBefore = await fake.requests(email);
    const { s, executeId } = session(auth, false);

    const out = valueOf(await s.dispatch(SEND, INPUT));

    expect(out).toEqual({ applied: false, step: "s1" });
    expect(s.plan).toHaveLength(1);
    expect(s.plan[0]).toMatchObject({ step: "s1", fn: "gmail.users.messages.send", account: email, effect: "write", destructive: false });
    const body = s.plan[0]?.request?.body as { raw: string };
    const mime = decodeRaw(body.raw);
    expect(mime).toContain("To: bob@example.test");
    expect(mime).toContain("Cc: carol@example.test");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain('filename="report.pdf"');
    expect(await fake.requests(email)).toEqual(logBefore);
    expect(await sentMessages(email)).toEqual(before);

    await s.close();
    const rows = await auditRows(executeId);
    expect(rows.map((r) => [r.fn, r.applied, r.status])).toEqual([
      ["gmail.users.messages.send", 0, "planned"],
      [SEND, 0, "ok"],
    ]);
  });

  it("apply sends the message: the fake shows the subject and the attachment filename", async () => {
    const { email, auth } = await client();
    const { s, executeId } = session(auth, true);

    const out = valueOf(await s.dispatch(SEND, INPUT));

    expect(out).toMatchObject({ applied: true });
    expect(typeof out.id).toBe("string");
    expect(s.plan).toEqual([]);
    const sent = await sentMessages(email);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("bob@example.test");
    const mime = decodeRaw(sent[0]?.raw ?? "");
    expect(mime).toContain("Content-Disposition: attachment; filename=\"report.pdf\"");
    // The subject is RFC 2047 encoded; decode it back.
    const word = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(mime)?.[1] ?? "";
    expect(new TextDecoder().decode(Uint8Array.from(atob(word), (c) => c.charCodeAt(0)))).toBe("Báo cáo tháng 11");
    expect(mime).toContain(PDF_B64);

    await s.close();
    const rows = await auditRows(executeId);
    expect(rows.map((r) => [r.fn, r.applied, r.status])).toEqual([
      ["gmail.users.messages.send", 1, "ok"],
      [SEND, 1, "ok"],
    ]);
  });

  it("rejects header injection before anything is sent, in dry-run and under apply", async () => {
    const { email, auth } = await client();
    for (const apply of [false, true]) {
      const { s } = session(auth, apply);
      const r = await s.dispatch(SEND, { ...INPUT, subject: "Hi\r\nBcc: evil@example.test" });
      expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_INVALID_INPUT");
      expect(s.plan).toEqual([]);
    }
    expect(await sentMessages(email)).toEqual([]);
  });

  it("rejects an input without recipients, body or attachments", async () => {
    const { auth } = await client();
    const { s } = session(auth, true);
    for (const bad of [{ ...INPUT, to: [] }, { ...INPUT, text: undefined }, { ...INPUT, attachments: [] }, { ...INPUT, extra: 1 }]) {
      const r = await s.dispatch(SEND, bad);
      expect("__gwsError" in r && r.__gwsError.code, JSON.stringify(Object.keys(bad))).toBe("GWS_INVALID_INPUT");
    }
  });

  it("plans a send that depends on an unexecuted write as incomplete and never runs it", async () => {
    const { email, auth } = await client();
    const { s } = session(auth, false);
    expect(await s.dispatch("drive.files.create", { requestBody: { name: "report.pdf" } })).toEqual({ __gwsPending: "s1" });
    const dependent = { ...INPUT, subject: `Report ${pending("s1.name")}` };
    expect(await s.dispatch(SEND, dependent)).toEqual({ __gwsPending: "s2" });
    expect(s.plan[1]).toMatchObject({ step: "s2", fn: SEND, effect: "write", incomplete: true, dependsOn: ["s1"] });
    expect(s.plan.some((p) => p.fn === "gmail.users.messages.send")).toBe(false);
    expect(await sentMessages(email)).toEqual([]);
  });

  it("never sends a message whose input holds a pending token, even under apply", async () => {
    const { email, auth } = await client();
    const { s } = session(auth, true);
    const r = await s.dispatch(SEND, { ...INPUT, to: [`${pending("s1.email")}@example.test`] });
    expect(r).toEqual({ __gwsPending: "s1" });
    expect(s.plan[0]).toMatchObject({ fn: SEND, incomplete: true });
    expect(await sentMessages(email)).toEqual([]);
  });
});
