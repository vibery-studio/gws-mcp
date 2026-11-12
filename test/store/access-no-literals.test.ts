import { describe, expect, it } from "vitest";

/**
 * The access list lives only in the database. No email or domain that could be a rule may appear in code,
 * migrations or Worker config (only reserved example domains, in docs and examples), every write to access_rules
 * binds its values, and no config key or env var carries a list.
 */

const sources = {
  ...import.meta.glob("../../src/**/*.ts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../src/**/*.mts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../src/**/*.cts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../src/**/*.js", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../src/**/*.json", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../migrations/*.sql", { query: "?raw", import: "default", eager: true }),
};
const configs = import.meta.glob("../../wrangler*.jsonc", { query: "?raw", import: "default", eager: true });
const all = { ...sources, ...configs };

/** An email address or an @domain. */
const EMAIL_OR_DOMAIN = /[A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** Domains reserved for documentation and tests (RFC 2606 and RFC 6761). */
const RESERVED = /\.(?:test|example|invalid|localhost)$|(?:^|\.)example\.(?:com|net|org)$/;

describe("no access rule values outside the database", () => {
  it("reads the source tree, the migrations and the tracked Worker config templates", () => {
    expect(Object.keys(sources).some((f) => f.endsWith("src/store/access.ts"))).toBe(true);
    expect(Object.keys(sources).some((f) => f.endsWith("migrations/0003_access_rules.sql"))).toBe(true);
    expect(Object.keys(configs).some((f) => f.endsWith("wrangler.example.jsonc"))).toBe(true);
  });

  it("has no email or domain other than reserved example domains", () => {
    const found: string[] = [];
    for (const [file, text] of Object.entries(all)) {
      for (const m of text.matchAll(EMAIL_OR_DOMAIN)) {
        const domain = m[0].slice(m[0].lastIndexOf("@") + 1).toLowerCase();
        if (!RESERVED.test(domain)) found.push(`${file}: ${m[0]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("binds every value written to access_rules: no quoted email or domain in any insert or update of it", () => {
    const writes: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      for (const m of text.matchAll(/(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE)\s+access_rules\b[\s\S]*?(?:;|`|$)/gi)) {
        if (/'[^']*@[^']*'/.test(m[0])) writes.push(`${file}: ${m[0].slice(0, 120)}`);
      }
    }
    expect(writes).toEqual([]);
  });

  it("names no config key or env var that could hold a list of who may use it", () => {
    const keys = /\b[A-Z_]*(?:ALLOW|ACCESS|ADMIN|OWNER)[A-Z_]*(?:EMAIL|DOMAIN|LIST|RULE|USER)S?\b/i;
    const config = Object.entries(all).filter(([f]) => f.endsWith(".jsonc") || f.endsWith("src/config.ts"));
    expect(config.length).toBeGreaterThan(1);
    for (const [file, text] of config) expect([file, keys.exec(text)?.[0]]).toEqual([file, undefined]);
  });
});
