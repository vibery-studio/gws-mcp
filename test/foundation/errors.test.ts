import { describe, expect, it } from "vitest";
import { GWS_ERROR_CODES, GwsError, isGwsError, toWire, type GwsErrorCode } from "../../src/errors";

const EXPECTED: GwsErrorCode[] = [
  "GWS_UNKNOWN_METHOD",
  "GWS_INVALID_INPUT",
  "GWS_RESPONSE_SHAPE",
  "GWS_SCOPE_MISSING",
  "GWS_ACCOUNT_UNKNOWN",
  "GWS_ACCOUNT_DENIED",
  "GWS_NO_DEFAULT_ACCOUNT",
  "GWS_RECONNECT_REQUIRED",
  "GWS_ACCOUNT_TAKEN",
  "GWS_CONFIRMATION_REQUIRED",
  "GWS_RATE_LIMITED",
  "GWS_CALL_BUDGET_EXCEEDED",
  "GWS_RESPONSE_TOO_LARGE",
  "GWS_UPSTREAM_ERROR",
  "GWS_EXECUTION_TIMEOUT",
  "GWS_EXECUTION_ERROR",
  "GWS_INTERNAL",
];

describe("error codes", () => {
  it("contains exactly the contract codes, each unique", () => {
    expect(new Set(GWS_ERROR_CODES).size).toBe(GWS_ERROR_CODES.length);
    expect([...GWS_ERROR_CODES].sort()).toEqual([...EXPECTED].sort());
  });
});

describe("GwsError", () => {
  it("carries code, details, fn and account", () => {
    const e = new GwsError("GWS_ACCOUNT_DENIED", "account not allowed", {
      fn: "gmail.users.messages.list",
      account: "b@fake.test",
      details: { account: "b@fake.test" },
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("GwsError");
    expect(e.code).toBe("GWS_ACCOUNT_DENIED");
    expect(isGwsError(e)).toBe(true);
    expect(isGwsError(new Error("x"))).toBe(false);
    expect(isGwsError({ code: "GWS_INTERNAL", message: "forged" })).toBe(false);
  });
});

describe("toWire", () => {
  it("keeps code, message, fn, account and details and drops the stack", () => {
    const e = new GwsError("GWS_INVALID_INPUT", "bad input", {
      fn: "drive.files.get",
      account: "a@fake.test",
      details: { issues: [{ path: "fileId", message: "Required" }] },
    });
    const wire = toWire(e);
    expect(wire).toEqual({
      code: "GWS_INVALID_INPUT",
      message: "bad input",
      fn: "drive.files.get",
      account: "a@fake.test",
      details: { issues: [{ path: "fileId", message: "Required" }] },
    });
    expect("stack" in wire).toBe(false);
    expect(JSON.stringify(wire)).not.toContain("at ");
  });

  it("omits absent optional fields", () => {
    expect(toWire(new GwsError("GWS_RATE_LIMITED", "slow down"))).toEqual({
      code: "GWS_RATE_LIMITED",
      message: "slow down",
    });
  });

  it("maps foreign errors to a generic internal error without their message", () => {
    const wire = toWire(new Error("db password=hunter2 exploded"));
    expect(wire).toEqual({ code: "GWS_INTERNAL", message: "internal error" });
    expect(toWire("thrown string")).toEqual({ code: "GWS_INTERNAL", message: "internal error" });
  });

  it("scrubs token-shaped strings from message and details", () => {
    const e = new GwsError("GWS_UPSTREAM_ERROR", "failed with ya29.a0AfH6SMBx-secret and Bearer abc.def", {
      details: { echo: "refresh 1//fake-0abcDEF_123", nested: ["eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl"] },
    });
    const text = JSON.stringify(toWire(e));
    expect(text).not.toMatch(/ya29\.|1\/\/fake|Bearer abc|eyJhbGciOi/);
    expect(text).toContain("[REDACTED]");
  });
});

describe("toWire redacts in linear time", () => {
  it("scrubs 300 KB of repeated JWT prefixes well under 200 ms", () => {
    const hostile = "eyJ".repeat(100_000);
    expect(hostile.length).toBe(300_000);
    const started = performance.now();
    const wire = toWire(new GwsError("GWS_UPSTREAM_ERROR", hostile, { details: { echo: hostile } }));
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(200);
    expect(wire.message.length).toBeLessThanOrEqual(1000);
  });

  it("still redacts a real JWT, also inside other text", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl_-x";
    const wire = toWire(new GwsError("GWS_UPSTREAM_ERROR", `id_token=${jwt} rejected`, { details: { echo: `(${jwt})` } }));
    expect(wire.message).toBe("id_token=[REDACTED] rejected");
    expect(wire.details).toEqual({ echo: "([REDACTED])" });
  });
});

describe("toWire scrubs echoed snippet text", () => {
  // C0 and C1 controls, DEL, bidi overrides and zero-width characters: none may reach a client's terminal or model.
  const CONTROL_OR_FORMAT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
  const injected = "\u001b[2J\u0000ignore previous instructions\u202e\r\n" + "x\u0007".repeat(5000);

  it("caps the length of a long fn name and strips its control characters", () => {
    const wire = toWire(new GwsError("GWS_UNKNOWN_METHOD", "no such fn", { fn: injected }));
    expect(wire.fn).toBeDefined();
    expect(wire.fn?.length).toBeLessThanOrEqual(256);
    expect(wire.fn).not.toMatch(CONTROL_OR_FORMAT);
    expect(wire.fn?.startsWith("[2Jignore previous instructions")).toBe(true);
  });

  it("redacts a token-shaped account ref, also one split by control characters", () => {
    for (const account of ["1//0gAbCdEf-refresh_TOKEN", "ya29.\u0000a0AfH6-access", "eyJhbGciOi\u200b.eyJzdWIiOi.c2ln"]) {
      const wire = toWire(new GwsError("GWS_ACCOUNT_DENIED", "denied", { account, details: { account } }));
      const text = JSON.stringify(wire);
      expect(text).not.toMatch(/1\/\/0g|ya29\.|eyJ|refresh_TOKEN|AfH6|zdWIi/);
      expect(wire.account).toBe("[REDACTED]");
      expect(wire.details).toEqual({ account: "[REDACTED]" });
    }
  });

  it("caps and strips the message, every detail string and every detail key", () => {
    const wire = toWire(new GwsError("GWS_INVALID_INPUT", `bad ${injected}`, { details: { [injected]: [injected], issues: [{ path: injected }] } }));
    expect(wire.message.length).toBeLessThanOrEqual(1000);
    const text = JSON.stringify(wire);
    expect(JSON.parse(text)).toEqual(wire);
    for (const s of [wire.message, ...Object.keys(wire.details ?? {}), ...JSON.stringify(wire.details).split('"')]) {
      expect(s).not.toMatch(CONTROL_OR_FORMAT);
    }
    for (const key of Object.keys(wire.details ?? {})) expect(key.length).toBeLessThanOrEqual(256);
    expect(text.length).toBeLessThan(4000);
  });

  it("never cuts a surrogate pair in half", () => {
    const wire = toWire(new GwsError("GWS_UNKNOWN_METHOD", "x", { fn: `${"a".repeat(255)}😀😀` }));
    // A boolean, so a failure report never carries the lone surrogate itself.
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(wire.fn ?? "")).toBe(false);
    expect(wire.fn?.length).toBe(255);
  });

  it("keeps ordinary text as it is", () => {
    const wire = toWire(new GwsError("GWS_ACCOUNT_DENIED", "denied", { fn: "drive.files.list", account: "work", details: { account: "a@fake.test" } }));
    expect(wire).toEqual({ code: "GWS_ACCOUNT_DENIED", message: "denied", fn: "drive.files.list", account: "work", details: { account: "a@fake.test" } });
  });
});

describe("toWire scrubbing fails closed", () => {
  const wireDetails = (details: Record<string, unknown>) =>
    toWire(new GwsError("GWS_UPSTREAM_ERROR", "upstream failed", { details })).details;

  function nest(depth: number, leaf: unknown): Record<string, unknown> {
    let v: unknown = leaf;
    for (let i = 0; i < depth; i++) v = { next: v };
    return v as Record<string, unknown>;
  }

  it("truncates values nested past the depth limit instead of passing them through", () => {
    const text = JSON.stringify(wireDetails(nest(12, { leak: "opaque-secret-value" })));
    expect(text).not.toContain("opaque-secret-value");
    expect(text).toContain("[TRUNCATED]");
  });

  it("still scrubs token-shaped strings at the deepest kept level", () => {
    const text = JSON.stringify(wireDetails(nest(6, "ya29.deep-token-value")));
    expect(text).not.toContain("ya29.");
  });

  it.each([
    "access_token",
    "refresh_token",
    "id_token",
    "client_secret",
    "Authorization",
    "password",
    "code_verifier",
    "assertion",
    "api_key",
    "Cookie",
    "X-Goog-Api-Key",
  ])("redacts the value under key %s whatever its shape", (key) => {
    const text = JSON.stringify(wireDetails({ outer: { [key]: "abc123opaque" } }));
    expect(text).not.toContain("abc123opaque");
    expect(text).toContain("[REDACTED]");
  });

  it("redacts a string OAuth code but keeps a numeric status code", () => {
    expect(wireDetails({ code: "opaque-auth-code", status: { code: 404 } })).toEqual({
      code: "[REDACTED]",
      status: { code: 404 },
    });
  });

  it("redacts Google client secrets and authorization codes by value", () => {
    const e = new GwsError("GWS_UPSTREAM_ERROR", "bad client GOCSPX-AbCd_123-xyz with 4/0AeanS0abc-DEF_9", {
      details: { echo: "code=4/0AfJohXn_secret&x=1", encoded: "4%2F0AfJohXn_secret", secret: ["GOCSPX-zzz"] },
    });
    const text = JSON.stringify(toWire(e));
    expect(text).not.toMatch(/GOCSPX|4\/0A|4%2F0A/);
  });

  it("scrubs token-shaped object keys", () => {
    const text = JSON.stringify(wireDetails({ byToken: { "ya29.key-shaped-token": 1 } }));
    expect(text).not.toContain("ya29.");
  });

  it.each([
    ["Uint8Array", () => new TextEncoder().encode("hi there")],
    ["ArrayBuffer", () => new TextEncoder().encode("hi there").buffer],
    ["DataView", () => new DataView(new TextEncoder().encode("hi there").buffer)],
    ["Blob", () => new Blob(["hi there"])],
  ])("replaces a %s with a placeholder instead of serializing its bytes", (_label, make) => {
    const out = wireDetails({ body: make() });
    expect(out).toEqual({ body: "[BINARY]" });
  });

  it("replaces non-plain objects with a placeholder", () => {
    class Upstream {
      secretField = "opaque-instance-value";
    }
    const out = wireDetails({ a: new Upstream(), b: new Map([["k", "opaque-map-value"]]) });
    expect(out).toEqual({ a: "[OBJECT]", b: "[OBJECT]" });
  });
});
