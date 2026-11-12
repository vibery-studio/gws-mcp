import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GOOGLE_SERVICES, loadConfig } from "../../src/config";
import type { AuthProps } from "../../src/contracts";
import { createCallSession, type DispatchResult } from "../../src/core/dispatch";
import { getRegistry } from "../../src/core/registry";
import type { WireError } from "../../src/errors";
import { workersPorts } from "../../src/runtime/workers/ports";
import { openStore } from "../../src/store/db";
import { seedUserWithAccount } from "../helpers/accounts";
import { uniqueEmail } from "../helpers/fake";

const G = "https://www.googleapis.com/auth/";
/** What the narrow preset granted an account connected for all five original services. */
const FIVE_SERVICES = [
  `${G}gmail.readonly`,
  `${G}gmail.send`,
  `${G}drive.file`,
  `${G}calendar.events`,
  `${G}calendar.calendarlist.readonly`,
  `${G}spreadsheets`,
  `${G}documents`,
];
const FUTURE_SCOPE = `${G}some.future.scope`;
const config = loadConfig(env);
const store = openStore(env);

function call(auth: AuthProps, fn: string, input: unknown = {}) {
  const s = createCallSession({ ports: workersPorts(env), auth, apply: false, executeId: `x-${crypto.randomUUID()}`, config });
  return { s, result: s.dispatch(fn, input) };
}

function valueOf(r: DispatchResult): unknown {
  if (!("ok" in r)) throw new Error(`expected a value, got ${JSON.stringify(r)}`);
  return r.value;
}

function errorOf(r: DispatchResult): WireError {
  if (!("__gwsError" in r)) throw new Error(`expected an error, got ${JSON.stringify(r)}`);
  return r.__gwsError;
}

/** A user whose only account holds `scopes`, and a client allowed that account. */
async function oldAccount(prefix: string, scopes: readonly string[]) {
  const a = await seedUserWithAccount(env, { email: uniqueEmail(prefix), scopes, isDefault: true });
  const auth: AuthProps = { userId: a.userId, clientId: `client-${crypto.randomUUID()}` };
  await store.grants.add(a.userId, auth.clientId, a.account.id);
  return { a, auth };
}

const OLD_SERVICES = { gmail: true, drive: true, calendar: true, sheets: true, docs: true, forms: false, tasks: false, slides: false, searchconsole: false, analytics: false, analyticsadmin: false, ads: false, groups: false, tagmanager: false, tagmanageredit: false, tagmanagerpublish: false, tagmanageradmin: false };

describe("an account connected before Forms, Tasks and Slides existed", () => {
  it("is listed with the new services false and the old ones true, ignoring a scope from a future preset", async () => {
    const { a, auth } = await oldAccount("later-list", [...FIVE_SERVICES, FUTURE_SCOPE]);
    const out = valueOf(await call(auth, "accounts.list").result) as { accounts: Array<{ scopes: string[]; services: unknown }> };
    expect(out).toMatchObject({ accounts: [{ email: a.account.email, status: "active", services: OLD_SERVICES }], hiddenCount: 0 });
    expect(out.accounts[0]?.scopes).toContain(FUTURE_SCOPE);
    expect(valueOf(await call(auth, "accounts.scopes").result)).toMatchObject({ email: a.account.email, services: OLD_SERVICES });
  });

  it("gets GWS_SCOPE_MISSING with the connect hint from a Tasks call, sending nothing upstream", async () => {
    const { auth } = await oldAccount("later-tasks", FIVE_SERVICES);
    const { s, result } = call(auth, "tasks.tasklists.list");
    const err = errorOf(await result);
    expect(err.code).toBe("GWS_SCOPE_MISSING");
    expect(err.details?.connectHint).toBe("sdk.accounts.connect({services:['tasks']})");
    expect(s.calls).toMatchObject([{ fn: "tasks.tasklists.list", status: "denied", code: "GWS_SCOPE_MISSING" }]);
  });

  it("gets GWS_SCOPE_MISSING with the connect hint from a Forms or Slides call when no granted scope covers it", async () => {
    const { auth } = await oldAccount("later-forms", [`${G}gmail.readonly`, `${G}calendar.events`, `${G}documents`]);
    const forms = errorOf(await call(auth, "forms.forms.responses.list", { formId: "f1" }).result);
    expect(forms.code).toBe("GWS_SCOPE_MISSING");
    expect(forms.details?.connectHint).toBe("sdk.accounts.connect({services:['forms']})");
    const slides = errorOf(await call(auth, "slides.presentations.get", { presentationId: "p1" }).result);
    expect(slides.code).toBe("GWS_SCOPE_MISSING");
    expect(slides.details?.connectHint).toBe("sdk.accounts.connect({services:['slides']})");
  });

  it("keeps Drive-side access to Forms governed by the granted Drive scope, as Google does", async () => {
    const { auth } = await oldAccount("later-drivefile", FIVE_SERVICES);
    const r = await call(auth, "forms.forms.get", { formId: "f1" }).result;
    expect("__gwsError" in r && r.__gwsError.code).not.toBe("GWS_SCOPE_MISSING");
  });
});

describe("accounts.* declarations", () => {
  it("name every configured service, generated from the service list", () => {
    const union = GOOGLE_SERVICES.map((s) => `"${s}"`).join(" | ");
    for (const name of ["accounts.connect", "accounts.scopes", "accounts.list"]) {
      expect(getRegistry().get(name)?.tsDecl, name).toContain(`type Service = ${union};`);
    }
  });
});
