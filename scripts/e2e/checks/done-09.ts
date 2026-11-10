// Done 9: every SDK call writes one audit row; a D1 scan finds no message body, file content or plaintext
// token. A stored refresh ciphertext moved to another user no longer decrypts.
import { decrypt, importKey, tokenAad } from "../../../src/store/crypto";
import { TOKEN_SHAPES, d1Query, scanD1, sqlLiteral } from "../d1-scan";
import type { CheckResult, E2eContext, Recorder } from "../run";

interface StoredToken {
  id: string;
  user_id: string;
  refresh_ct: string | null;
  refresh_iv: string | null;
  key_version: number;
}

async function opens(key: CryptoKey, row: StoredToken): Promise<boolean> {
  if (row.refresh_ct === null || row.refresh_iv === null) return false;
  try {
    const plain = await decrypt(key, { ct: row.refresh_ct, iv: row.refresh_iv }, tokenAad("refresh", { userId: row.user_id, accountId: row.id, keyVersion: row.key_version }));
    return plain.startsWith("1//");
  } catch {
    return false;
  }
}

export default async function done09(ctx: E2eContext, r: Recorder): Promise<CheckResult> {
  const bodyMarker = `E2E-BODY-${ctx.runId}`;
  const fileMarker = `E2E-FILE-${ctx.runId}`;
  const mime = [`To: ${ctx.emails.b}`, `Subject: e2e ${ctx.runId}`, "Content-Type: text/plain; charset=utf-8", "", `${bodyMarker} message body`].join("\r\n");
  const raw = Buffer.from(mime, "utf8").toString("base64url");
  const fileB64 = Buffer.from(fileMarker, "utf8").toString("base64");
  ctx.markers.push(
    { name: "message body marker", needle: bodyMarker },
    { name: "message raw (base64url)", needle: raw },
    { name: "file content marker", needle: fileMarker },
    { name: "file content (base64)", needle: fileB64 },
  );

  const run = await ctx.main.session.execute(
    `async () => {
      const labels = await sdk.gmail.users.labels.list({ userId: "me" });
      const sent = await sdk.gmail.users.messages.send({ userId: "me", requestBody: { raw: ${JSON.stringify(raw)} } });
      const file = await sdk.drive.files.create({ requestBody: { name: "e2e-${ctx.runId}.txt" }, media: { mimeType: "text/plain", text: ${JSON.stringify(fileMarker)} } });
      return { labels: labels.labels.length, sent: sent.id, file: file.id };
    }`,
    true,
  );
  const calls = run.out.calls;
  r.check(run.out.ok && calls.length === 3 && calls.every((c) => c.status === "ok"), `applied execute: ok=${run.out.ok} calls=${calls.map((c) => `${c.fn}:${c.status}`).join(",")}`);
  const [count] = await d1Query<{ n: number }>(ctx.d1, `SELECT COUNT(*) AS n FROM audit_log WHERE execute_id = ${sqlLiteral(run.out.executeId)}`);
  r.check(count?.n === calls.length, `audit_log rows for executeId = ${count?.n} (calls = ${calls.length})`);

  // The scan must look for content that really went upstream.
  const upstream = JSON.stringify((await ctx.fake.state(ctx.emails.a)).resources);
  r.check(upstream.includes(raw) || upstream.includes(bodyMarker), "the fake holds the sent message body");
  r.check(upstream.includes(fileB64) || upstream.includes(fileMarker), "the fake holds the uploaded file content");

  const scan = await scanD1(ctx.d1, ctx.markers, ctx.secrets);
  r.check(scan.tables.length >= 5, `tables from sqlite_master: ${scan.tables.map((t) => `${t.name}(${t.rows})`).join(" ")}`);
  r.check(scan.refreshCiphertexts.length >= 1, `refresh ciphertexts sampled: ${scan.refreshCiphertexts.length}, none decodes to a token prefix`);
  r.check(scan.hits.length === 0, `D1 scan for ${ctx.markers.length} body/content markers, ${TOKEN_SHAPES.length} secret shapes and ${ctx.secrets.length} run secret values: ${scan.hits.length === 0 ? "clean" : scan.hits.join("; ")}`);

  // Moved row: account b's ciphertext (b is allowed to no client, so no allowlist row pins its user).
  if (!ctx.tokenEncKey) {
    r.fail("TOKEN_ENC_KEY is not in the env files: the moved-row decryption test cannot run");
    return r.done();
  }
  const key = await importKey({ TOKEN_ENC_KEY: ctx.tokenEncKey });
  const bId = (await ctx.accountIds())[ctx.emails.b];
  if (!r.check(bId !== undefined, "account b is stored for the user") || bId === undefined) return r.done();
  const select = `SELECT id, user_id, refresh_ct, refresh_iv, key_version FROM accounts WHERE id = ${sqlLiteral(bId)}`;
  const [original] = await d1Query<StoredToken>(ctx.d1, select);
  if (!r.check(original !== undefined && (await opens(key, original)), "b's stored refresh token decrypts in place (key and AAD as the server uses them)") || !original) return r.done();

  const movedUser = `u_e2e-moved-${ctx.runId}`;
  await d1Query(ctx.d1, `INSERT INTO users (id, primary_email, created_at) VALUES (${sqlLiteral(movedUser)}, ${sqlLiteral(`moved-${ctx.runId}@e2e.invalid`)}, ${Date.now()})`);
  try {
    await d1Query(ctx.d1, `UPDATE accounts SET user_id = ${sqlLiteral(movedUser)} WHERE id = ${sqlLiteral(bId)}`);
    const [moved] = await d1Query<StoredToken>(ctx.d1, select);
    r.check(moved?.user_id === movedUser && moved.refresh_ct === original.refresh_ct, "row moved to another user_id with its ciphertext unchanged");
    r.check(moved !== undefined && !(await opens(key, moved)), "the moved row no longer decrypts");
  } finally {
    await d1Query(ctx.d1, `UPDATE accounts SET user_id = ${sqlLiteral(original.user_id)} WHERE id = ${sqlLiteral(bId)}`);
    await d1Query(ctx.d1, `DELETE FROM users WHERE id = ${sqlLiteral(movedUser)}`);
  }
  const [restored] = await d1Query<StoredToken>(ctx.d1, select);
  r.check(restored !== undefined && (await opens(key, restored)), "moved back: it decrypts again");
  return r.done();
}
