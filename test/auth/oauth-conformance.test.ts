// The shared OAuth conformance cases against the Worker entry in-process (test/node-host/oauth.test.ts runs the same
// cases against the built Node host).
import { env, exports } from "cloudflare:workers";
import { addRule, removeRuleAndRevoke } from "../../src/auth/access";
import { oauthHelpers } from "../../src/auth/oauth-server";
import type { AccessChange } from "../../src/store/access";
import { fake } from "../helpers/fake";
import { oauthConformance } from "../shared/oauth-conformance";
import { BASE, Browser, signIn } from "./browser";

const ADMIN: AccessChange = { actor: "u_oauth_conformance", via: "web" };

oauthConformance("Workers", () => ({
  base: BASE,
  fetch: (path, init) => exports.default.fetch(new Request(new URL(path, BASE), { ...init, redirect: "manual" })),
  async signIn(email) {
    await fake.seed({ accounts: [{ email, sub: `${Date.now()}${Math.floor(Math.random() * 1e9)}`, preset: "default" }] });
    const browser = new Browser();
    const res = await signIn(browser, email);
    await res.body?.cancel();
    if (res.status !== 302) throw new Error(`sign-in failed: ${res.status}`);
    return browser;
  },
  async allow(email) {
    await addRule(env, { pattern: email, role: "user" }, ADMIN);
  },
  async remove(email) {
    await removeRuleAndRevoke({ ...env, OAUTH_PROVIDER: oauthHelpers(env) } as Env, email, ADMIN);
  },
  oauthKv: env.OAUTH_KV,
  domain: "oauth-conformance.test",
}));
