import { env } from "cloudflare:workers";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { PENDING_TOKEN_PREFIX, SECRET_NAMES, type CallCtx, type FnDef, type HostConfig, type SecretName } from "../../src/contracts";
import { omitSecrets, type HostEnv } from "../../src/runtime/workers/env";

describe("contracts", () => {
  it("fixes the pending-result token prefix", () => {
    expect(PENDING_TOKEN_PREFIX).toBe("__gws_pending__:");
  });

  it("lets a concretely typed fn join the untyped registry list", async () => {
    const echo: FnDef<{ text: string }, { length: number }> = {
      name: "helpers.echo",
      service: "helpers",
      effect: "read",
      description: "Echo length",
      signature: "helpers.echo(input: { text: string }): Promise<{ length: number }>",
      tsDecl: "declare function echo(input: { text: string }): Promise<{ length: number }>;",
      example: 'await sdk.helpers.echo({ text: "hi" })',
      tags: ["test"],
      scopes: [],
      kind: "host",
      input: z.object({ text: z.string() }),
      output: z.object({ length: z.number() }),
      async run(input) {
        return { length: input.text.length };
      },
    };
    const list: FnDef[] = [echo];
    const fn = list[0];
    expect(fn?.input.parse({ text: "abc" })).toEqual({ text: "abc" });
    expect(await fn?.run?.({ text: "abcd" }, {} as CallCtx)).toEqual({ length: 4 });
  });
});

describe("host fn env carries no secrets", () => {
  it("names every required secret binding", () => {
    expect([...SECRET_NAMES].sort()).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENC_KEY"]);
    expectTypeOf<SecretName>().toEqualTypeOf<"TOKEN_ENC_KEY" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">();
  });

  it("types CallCtx without an env, a binding or a secret", () => {
    // Type-level: `tsc --noEmit` fails if CallCtx gains an env, a binding or a secret again.
    type Forbidden = SecretName | "FAKE_ADMIN_TOKEN" | "DB" | "CACHE_KV" | "OAUTH_KV" | "FAKE_GOOGLE" | "LOADER" | "env";
    // @ts-expect-error host fns get no env at all
    type _NoEnv = CallCtx["env"];
    expectTypeOf<keyof CallCtx>().toEqualTypeOf<
      "apply" | "auth" | "account" | "config" | "executeId" | "call" | "planStep" | "resolveAllowed" | "accounts"
    >();
    expectTypeOf<Extract<keyof CallCtx["config"], Forbidden>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof NonNullable<CallCtx["accounts"]>, Forbidden>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof CallCtx["auth"], Forbidden>>().toEqualTypeOf<never>();
    expectTypeOf<CallCtx["config"]>().toEqualTypeOf<HostConfig>();
    expectTypeOf<keyof HostConfig>().toEqualTypeOf<"PUBLIC_BASE_URL" | "GOOGLE_SCOPE_PRESET" | "CALL_RESPONSE_MAX_BYTES">();
    expectTypeOf<HostEnv>().toHaveProperty("DB");
  });

  it("strips secret bindings at runtime, so serializing the host env cannot leak them", () => {
    const withSecrets = { ...env, TOKEN_ENC_KEY: "k-secret", GOOGLE_CLIENT_ID: "id-secret", GOOGLE_CLIENT_SECRET: "s-secret" };
    const host = omitSecrets(withSecrets);
    for (const name of SECRET_NAMES) expect(name in host).toBe(false);
    expect(JSON.stringify(Object.keys(host))).not.toMatch(/TOKEN_ENC_KEY|GOOGLE_CLIENT/);
    expect(host.DB).toBe(env.DB);
    expect(host.GOOGLE_UPSTREAM).toBe(env.GOOGLE_UPSTREAM);
    expect("TOKEN_ENC_KEY" in withSecrets).toBe(true);
  });
});
