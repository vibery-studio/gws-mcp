import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import type { AuditRow, AuthProps } from "../../src/contracts";
import { AuditBuffer } from "../../src/core/audit";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount, stringViews } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const store = openStore(env);
const baseConfig = loadConfig(env);

const AUDIT_COLUMNS = [
  "account_id",
  "applied",
  "client_id",
  "code",
  "duration_ms",
  "effect",
  "execute_id",
  "fn",
  "id",
  "request_id",
  "status",
  "ts",
  "upstream_status",
  "user_id",
];

function b64url(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function rowsFor(executeId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
  return results;
}

function statusOf(r: DispatchResult): string {
  return "ok" in r ? "ok" : "__gwsPending" in r ? "pending" : r.__gwsError.code;
}

describe("audit", () => {
  it("writes exactly one metadata-only row per SDK call, with no body, file content or token", async () => {
    const email = uniqueEmail("audit-a");
    const other = uniqueEmail("audit-b");
    const scopes = [`${G}gmail.readonly`, `${G}gmail.send`, `${G}drive.file`];
    const a = await seedUserWithAccount(env, { email, scopes, isDefault: true });
    const b = await seedUserWithAccount(env, { email: other, scopes, userId: a.userId });
    const auth: AuthProps = { userId: a.userId, clientId: `client-${crypto.randomUUID()}` };
    await store.grants.add(auth.userId, auth.clientId, a.account.id);

    const subject = `Subject-${crypto.randomUUID()}`;
    const bodyText = `Body-text-${crypto.randomUUID()}`;
    const fileText = `File-bytes-${crypto.randomUUID()}`;
    const raw = b64url(`From: ${email}\r\nTo: friend@fake.test\r\nSubject: ${subject}\r\n\r\n${bodyText}\r\n`);

    const applyId = `x-${crypto.randomUUID()}`;
    const applied = createCallSession({ ports: workersPorts(env), auth, apply: true, executeId: applyId, config: baseConfig });
    const sent = (await applied.dispatch("gmail.users.messages.send", { userId: "me", requestBody: { raw } })) as {
      ok: true;
      value: { id: string };
    };
    const outcomes = [
      statusOf(sent),
      statusOf(await applied.dispatch("gmail.users.messages.get", { userId: "me", id: sent.value.id, format: "raw" })),
      statusOf(await applied.dispatch("drive.files.create", { requestBody: { name: "a.txt" }, media: { mimeType: "text/plain", text: fileText } })),
      statusOf(await applied.dispatch("gmail.users.messages.list", { userId: "me", account: other })),
      statusOf(await applied.dispatch("nope; DROP TABLE audit_log; ya29.injected", { raw })),
      statusOf(await applied.dispatch("gmail.users.messages.list", { userId: "me", maxResults: bodyText })),
    ];
    expect(outcomes).toEqual(["ok", "ok", "ok", "GWS_ACCOUNT_DENIED", "GWS_UNKNOWN_METHOD", "GWS_INVALID_INPUT"]);
    await applied.flush();

    const dryId = `x-${crypto.randomUUID()}`;
    const dry = createCallSession({ ports: workersPorts(env), auth, apply: false, executeId: dryId, config: baseConfig });
    expect(statusOf(await dry.dispatch("gmail.users.messages.send", { userId: "me", requestBody: { raw } }))).toBe("pending");
    await dry.flush();
    await dry.flush();

    const rows = await rowsFor(applyId);
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(AUDIT_COLUMNS);
    expect(rows.map((r) => [r.fn, r.status, r.code, r.applied, r.effect])).toEqual([
      ["gmail.users.messages.send", "ok", null, 1, "write"],
      ["gmail.users.messages.get", "ok", null, 0, "read"],
      ["drive.files.create", "ok", null, 1, "write"],
      ["gmail.users.messages.list", "denied", "GWS_ACCOUNT_DENIED", 0, "read"],
      ["<unknown>", "error", "GWS_UNKNOWN_METHOD", 0, "read"],
      ["gmail.users.messages.list", "error", "GWS_INVALID_INPUT", 0, "read"],
    ]);
    expect(rows.map((r) => r.account_id)).toEqual([a.account.id, a.account.id, a.account.id, b.account.id, null, null]);
    expect(rows.map((r) => r.upstream_status)).toEqual([200, 200, 200, null, null, null]);
    for (const r of rows) {
      expect(r).toMatchObject({ execute_id: applyId, user_id: auth.userId, client_id: auth.clientId });
      expect(typeof r.duration_ms).toBe("number");
    }

    const dryRows = await rowsFor(dryId);
    expect(dryRows.map((r) => [r.fn, r.status, r.applied])).toEqual([["gmail.users.messages.send", "planned", 0]]);

    const { results: all } = await env.DB.prepare("SELECT * FROM audit_log").all();
    const forbidden = [subject, bodyText, fileText, raw, "ya29.", "1//", a.refreshToken, b.refreshToken];
    for (const row of all) {
      for (const value of Object.values(row)) {
        for (const view of stringViews(value)) {
          for (const f of forbidden) expect(view).not.toContain(f);
        }
      }
    }
  });

  it("builds each row field by field, dropping anything else", () => {
    const buffer = new AuditBuffer();
    const row: AuditRow = {
      id: "r1",
      ts: 1,
      execute_id: "x",
      user_id: "u",
      client_id: "c",
      account_id: null,
      fn: "f".repeat(300),
      effect: "read",
      applied: 0,
      status: "ok",
      code: null,
      duration_ms: 3,
      request_id: null,
      upstream_status: null,
    };
    buffer.add({ ...row, body: "smuggled", token: "ya29.x" } as AuditRow);
    expect(buffer.rows).toHaveLength(1);
    expect(Object.keys(buffer.rows[0] ?? {}).sort()).toEqual(AUDIT_COLUMNS);
    expect(buffer.rows[0]?.fn).toHaveLength(200);
  });

  it("flushes in one batch and keeps rows buffered when the write fails", async () => {
    const buffer = new AuditBuffer();
    const executeId = `x-${crypto.randomUUID()}`;
    const base: AuditRow = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      execute_id: executeId,
      user_id: "u",
      client_id: "c",
      account_id: null,
      fn: "test.fn",
      effect: "read",
      applied: 0,
      status: "ok",
      code: null,
      duration_ms: 1,
      request_id: null,
      upstream_status: null,
    };
    buffer.add(base);
    buffer.add({ ...base }); // duplicate primary key: the whole batch fails
    await expect(buffer.flush(openStore(env).audit)).rejects.toMatchObject({ code: "GWS_INTERNAL" });
    expect(buffer.rows).toHaveLength(2);
    expect(await rowsFor(executeId)).toHaveLength(0);
  });
});
