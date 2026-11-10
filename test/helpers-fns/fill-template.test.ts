import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import type { AuthProps } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { getRegistry } from "../../src/core/registry";
import { search } from "../../src/core/search";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
const FILL = "slides.fillTemplate";
const TEMPLATE = "seed-slides-template";
const SCOPES = [`${G}drive.file`, `${G}presentations`];
const store = openStore(env);
const baseConfig = loadConfig(env);

async function client(scopes: string[] = SCOPES) {
  const email = uniqueEmail("h-slide");
  const seeded = await seedUserWithAccount(env, { email, scopes, isDefault: true });
  await fake.seed({ accounts: [{ email, sub: seeded.sub, preset: "templates" }] });
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

/** Every text run of a presentation, slide by slide. */
async function texts(auth: AuthProps, presentationId: string): Promise<string[]> {
  const p = valueOf(await session(auth, false).s.dispatch("slides.presentations.get", { presentationId }));
  type Slide = { pageElements?: Array<{ shape?: { text?: { textElements?: Array<{ textRun?: { content?: string } }> } } }> };
  return ((p.slides as Slide[] | undefined) ?? []).flatMap((slide) =>
    (slide.pageElements ?? []).flatMap((e) => (e.shape?.text?.textElements ?? []).flatMap((t) => (t.textRun?.content === undefined ? [] : [t.textRun.content]))),
  );
}

async function driveFiles(email: string): Promise<string[]> {
  const { resources } = await fake.state(email);
  return Object.keys(resources).filter((k) => k.startsWith(`drive:file:${email}:`));
}

const VALUES = { name: "Dana", date: "10 Nov 2026" };

describe("slides.fillTemplate", () => {
  it("is a write helper with a signature, example and tags, and search ranks it first", () => {
    const fn = getRegistry().get(FILL);
    expect(fn).toMatchObject({ kind: "host", service: "helpers", effect: "write" });
    expect(fn?.signature).toContain(`${FILL}(`);
    expect(fn?.signature).toContain("Promise<");
    expect(fn?.example).toContain(`await sdk.${FILL}(`);
    expect(fn?.tags).toContain("write");
    expect(fn?.tsDecl.length).toBeGreaterThan(20);
    const top = search({ query: "fill a slides template" }, [...getRegistry().values()], { SEARCH_MAX_BYTES: 8000 }).map((r) => r.name);
    expect(top[0]).toBe(FILL);
  });

  it("dry-run plans the copy and a fill that depends on it as incomplete, and changes nothing", async () => {
    const { email, auth } = await client();
    const before = await driveFiles(email);
    const logBefore = (await fake.requests(email)).length;
    const { s, executeId } = session(auth, false);

    const out = valueOf(await s.dispatch(FILL, { templateId: TEMPLATE, values: VALUES, copyTitle: "Certificate for Dana" }));

    expect(out).toEqual({ applied: false, steps: ["s1", "s2"] });
    expect(s.plan).toHaveLength(2);
    expect(s.plan[0]).toMatchObject({ step: "s1", fn: "drive.files.copy", account: email, effect: "write", destructive: false });
    expect(s.plan[0]?.request?.body).toEqual({ name: "Certificate for Dana" });
    expect(s.plan[0]?.incomplete).toBeUndefined();
    expect(s.plan[1]).toMatchObject({ step: "s2", fn: "slides.presentations.batchUpdate", account: email, effect: "write", incomplete: true, dependsOn: ["s1"] });
    expect(s.plan[1]?.request?.body).toEqual({
      requests: [
        { replaceAllText: { containsText: { text: "{{name}}", matchCase: true }, replaceText: "Dana" } },
        { replaceAllText: { containsText: { text: "{{date}}", matchCase: true }, replaceText: "10 Nov 2026" } },
      ],
    });
    expect(await fake.requests(email)).toHaveLength(logBefore);
    expect(await driveFiles(email)).toEqual(before);

    await s.close();
    const { results } = await env.DB.prepare("SELECT fn, applied FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
    expect(results.map((r) => [r.fn, r.applied])).toEqual([
      ["drive.files.copy", 0],
      ["slides.presentations.batchUpdate", 0],
      [FILL, 0],
    ]);
  });

  it("apply copies the template, fills the copy and leaves the template untouched", async () => {
    const { auth } = await client();
    const templateBefore = await texts(auth, TEMPLATE);
    const { s, executeId } = session(auth, true);

    const out = valueOf(await s.dispatch(FILL, { templateId: TEMPLATE, values: VALUES, copyTitle: "Certificate for Dana" }));

    expect(out).toMatchObject({ applied: true, name: "Certificate for Dana", replaced: { name: 3, date: 1 } });
    const id = String(out.presentationId);
    expect(id).not.toBe(TEMPLATE);
    expect(await texts(auth, id)).toEqual(["Certificate for Dana\n", "Awarded to Dana on 10 Nov 2026\n", "Thank you, Dana!\n"]);
    expect(await texts(auth, TEMPLATE)).toEqual(templateBefore);

    await s.close();
    const { results } = await env.DB.prepare("SELECT fn, applied FROM audit_log WHERE execute_id = ? ORDER BY rowid").bind(executeId).all();
    expect(results.map((r) => [r.fn, r.applied])).toEqual([
      ["drive.files.copy", 1],
      ["slides.presentations.batchUpdate", 1],
      [FILL, 1],
    ]);
  });

  it("matches placeholders case-sensitively and reports 0 for a key with no placeholder", async () => {
    const { auth } = await client();
    const out = valueOf(await session(auth, true).s.dispatch(FILL, { templateId: TEMPLATE, values: { Name: "X", missing: "Y" } }));
    expect(out).toMatchObject({ applied: true, replaced: { Name: 0, missing: 0 } });
    expect((await texts(auth, String(out.presentationId))).join("")).toContain("{{name}}");
  });

  it("fails with GWS_SCOPE_MISSING without a Drive scope, and copies nothing", async () => {
    const { email, auth } = await client([`${G}tasks`]);
    const before = await driveFiles(email);
    const r = await session(auth, true).s.dispatch(FILL, { templateId: TEMPLATE, values: VALUES });
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_SCOPE_MISSING");
    expect(await driveFiles(email)).toEqual(before);
  });

  it("rejects empty values, braces in a key and unknown fields", async () => {
    const { auth } = await client();
    const { s } = session(auth, true);
    for (const bad of [
      { templateId: TEMPLATE },
      { templateId: TEMPLATE, values: {} },
      { templateId: TEMPLATE, values: { "{{name}}": "x" } },
      { templateId: TEMPLATE, values: { name: 1 } },
      { templateId: "", values: VALUES },
      { templateId: TEMPLATE, values: VALUES, extra: true },
    ]) {
      const r = await s.dispatch(FILL, bad);
      expect("__gwsError" in r && r.__gwsError.code, JSON.stringify(bad)).toBe("GWS_INVALID_INPUT");
    }
  });

  it("surfaces an upstream error for an unknown template", async () => {
    const { auth } = await client();
    const r = await session(auth, true).s.dispatch(FILL, { templateId: "missing", values: VALUES });
    expect("__gwsError" in r && r.__gwsError.code).toBe("GWS_UPSTREAM_ERROR");
  });
});
