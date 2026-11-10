import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactDeep } from "../../src/core/redact";

describe("redact", () => {
  it.each([
    ["Google access token", "token ya29.a0AfB_byC-1.x9 end", "token [REDACTED] end"],
    ["refresh token", "rt=1//0gAbC-d_E end", "rt=[REDACTED] end"],
    ["URL-encoded refresh token", "rt=1%2F%2F0gAbC end", "rt=[REDACTED] end"],
    ["bearer header", "Authorization: Bearer abc.DEF-ghi~j+k/l== tail", "Authorization: [REDACTED] tail"],
    ["lower-case bearer", "bearer abcdef", "[REDACTED]"],
    ["JWT", "id eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl end", "id [REDACTED] end"],
    ["OAuth client secret", "GOCSPX-AbC_dEf-123 ", "[REDACTED] "],
    ["authorization code", "code 4/0AbCdEf_g", "code [REDACTED]"],
  ])("redacts a %s", (_name, input, expected) => {
    expect(redact(input, [])).toBe(expected);
  });

  it.each([
    ['{"client_secret":"s3cr3t-value","x":1}', '{"client_secret":"[REDACTED]","x":1}'],
    ["client_secret=s3cr3t&grant_type=x", "client_secret=[REDACTED]&grant_type=x"],
    ["refresh_token: abc123def", "refresh_token: [REDACTED]"],
    ["'refresh_token' = 'zz9'", "'refresh_token' = '[REDACTED]'"],
    ['{"Refresh_Token" : "Q"}', '{"Refresh_Token" : "[REDACTED]"}'],
  ])("redacts the value of a credential key: %s", (input, expected) => {
    expect(redact(input, [])).toBe(expected);
  });

  it("redacts exact occurrences of known secret values, longest first", () => {
    const key = "Z3dzLW1jcC10ZXN0LW9ubHkta2V5LTAxMjM0NTY3ODk=";
    expect(redact(`k=${key}; again ${key}`, [key])).toBe("k=[REDACTED]; again [REDACTED]");
    expect(redact("abcdefgh-and-more abcdefgh", ["abcdefgh", "abcdefgh-and-more"])).toBe("[REDACTED] [REDACTED]");
  });

  it("ignores known values shorter than 8 characters, empty or not strings", () => {
    expect(redact("short abc1234 stays", ["abc1234", "", undefined, 42 as unknown as string])).toBe("short abc1234 stays");
  });

  it("still redacts a JWT after a non-word character, and leaves an eyJ inside a longer word alone", () => {
    expect(redact('{"id_token":"eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl"}', [])).toBe('{"id_token":"[REDACTED]"}');
    expect(redact("t=eyJa.b.c", [])).toBe("t=[REDACTED]");
    expect(redact("keyJa.b.c", [])).toBe("keyJa.b.c");
  });

  // Every pattern runs over snippet-controlled text: a backtracking pattern turns ~300 KB into seconds of host CPU.
  it.each([
    ["JWT prefix", "eyJ".repeat(100_000)],
    ["JWT prefix with dots", "eyJa.".repeat(60_000)],
    ["access token prefix", "ya29".repeat(75_000)],
    ["refresh token prefix", "1/".repeat(150_000)],
    ["authorization code prefix", "4/".repeat(150_000)],
    ["bearer prefix", "Bearer ".repeat(45_000)],
    ["bearer and spaces", `Bearer${" ".repeat(300_000)}`],
    ["credential key", "client_secret".repeat(25_000)],
    ["credential key and spaces", `refresh_token${" ".repeat(300_000)}`],
  ])("redacts 300 KB of a repeated %s in linear time", (_name, text) => {
    const start = Date.now();
    redact(text, ["a-known-secret-value"]);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("leaves ordinary text alone: emails, Drive file ids, Gmail ids, URLs", () => {
    const text =
      "mail alice@example.test about 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms, msg 18c2f1e0a9b3d4e5, " +
      "https://www.googleapis.com/drive/v3/files?pageSize=10 tokenless keys like page_token_hint";
    expect(redact(text, [])).toBe(text);
  });
});

describe("redactDeep", () => {
  it("walks nested arrays and objects, values and keys, and keeps other JSON types", () => {
    const value = {
      a: ["x ya29.abc", { deep: { deeper: "Bearer zzz" } }],
      n: 1,
      b: true,
      z: null,
      "ya29.key": "v",
      known: "contains SECRETVALUE123 here",
    };
    expect(redactDeep(value, ["SECRETVALUE123"])).toEqual({
      a: ["x [REDACTED]", { deep: { deeper: "[REDACTED]" } }],
      n: 1,
      b: true,
      z: null,
      [REDACTED]: "v",
      known: "contains [REDACTED] here",
    });
  });

  it("returns a redacted string for a top-level string and undefined for undefined", () => {
    expect(redactDeep("1//abc", [])).toBe(REDACTED);
    expect(redactDeep(undefined, [])).toBeUndefined();
  });

  it("does not modify its input", () => {
    const input = { s: "ya29.x" };
    redactDeep(input, []);
    expect(input).toEqual({ s: "ya29.x" });
  });
});
