import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { callGoogle } from "../../src/google/client";
import { googleOAuth } from "../../src/google/oauth";
import { buildRequest } from "../../src/google/request";
import { createTransport } from "../../src/google/transport";
import { generatedFns } from "../../src/sdk/generated/index";
import { authorizeAtFake } from "../helpers/accounts";
import { fake, uniqueEmail } from "../helpers/fake";

const SELECTOR = "files(id,name,webViewLink)";

const byName = (name: string) => {
  const fn = generatedFns.find((f) => f.name === name);
  if (!fn?.method) throw new Error(`missing ${name}`);
  return { ...fn, method: fn.method };
};

describe("global fields parameter", () => {
  it("is an optional string query param on every generated method", () => {
    for (const fn of generatedFns) {
      expect(fn.method?.queryParams, fn.name).toContainEqual({ name: "fields", repeated: false });
      expect(fn.signature, fn.name).toContain("fields?: string");
      expect(fn.tsDecl, fn.name).toContain("  fields?: string;\n");
    }
  });

  it("adds no transport-owned global param to any generated method", () => {
    const owned = new Set(["key", "access_token", "oauth_token", "uploadType", "upload_protocol", "callback", "$.xgafv", "prettyPrint", "quotaUser"]);
    for (const fn of generatedFns) {
      expect(fn.method?.queryParams.filter((q) => owned.has(q.name)), fn.name).toEqual([]);
    }
  });

  it("drive.files.list accepts fields and the built request sends it", () => {
    const fn = byName("drive.files.list");
    const input = fn.input.parse({ fields: SELECTOR });
    expect(input).toMatchObject({ fields: SELECTOR });
    const url = new URL(buildRequest(fn.method, input).url);
    expect(url.pathname).toBe("/drive/v3/files");
    expect(url.searchParams.get("fields")).toBe(SELECTOR);
    expect(url.search).toMatch(/^\?fields=files%28id%2Cname%2CwebViewLink%29&/);
    expect(fn.input.safeParse({ fields: ["id"] }).success).toBe(false);
  });

  it("returns the extra properties from the fake Drive only when fields asks for them", async () => {
    const transport = createTransport(env, loadConfig(env));
    const email = uniqueEmail("fields");
    await fake.seed({ accounts: [{ email, sub: `sub-${crypto.randomUUID()}`, preset: "default" }] });
    const { accessToken } = await googleOAuth(env, transport).exchangeCode(
      await authorizeAtFake({ email, scopes: ["https://www.googleapis.com/auth/drive"] }),
    );
    const fn = byName("drive.files.list");
    const call = (input: unknown) =>
      callGoogle(fn.method, fn.input.parse(input), { accessToken, transport, maxResponseBytes: 1_000_000 }) as Promise<{
        files: Array<Record<string, unknown>>;
      }>;

    const plain = await call({});
    expect(plain.files.length).toBeGreaterThan(0);
    expect(plain.files.every((f) => f.webViewLink === undefined)).toBe(true);

    const selected = await call({ fields: SELECTOR });
    expect(selected.files.map((f) => f.id).sort()).toEqual(plain.files.map((f) => f.id).sort());
    for (const f of selected.files) {
      expect(Object.keys(f).sort()).toEqual(["id", "name", "webViewLink"]);
      expect(f.webViewLink).toMatch(/^https:\/\//);
    }
    expect(fn.output.safeParse(selected).success).toBe(true);
  });
});
