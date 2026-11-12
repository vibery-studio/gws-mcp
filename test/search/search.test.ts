import { describe, expect, it } from "vitest";
import type { FnDef, FnMeta } from "../../src/contracts";
import { isDestructive } from "../../src/core/destructive";
import { search, type SearchResult } from "../../src/core/search";
import { isGwsError } from "../../src/errors";
import { generatedFns } from "../../src/sdk/generated/index";
import { registry } from "../../src/sdk/index";

const config = { SEARCH_MAX_BYTES: 8000 };

function run(query: string, extra: { service?: string; limit?: number } = {}): SearchResult[] {
  return search({ query, ...extra }, generatedFns, config);
}

function names(results: SearchResult[]): string[] {
  return results.map((r) => r.name);
}

describe("search ranking", () => {
  it("returns signature, effect and example for 'gmail messages list' with the right top hit", () => {
    const [top] = run("gmail messages list");
    expect(top?.name).toBe("gmail.users.messages.list");
    expect(top?.signature).toContain("Promise<");
    expect(top?.effect).toBe("read");
    expect(top?.example).toContain("await sdk.gmail.users.messages.list(");
  });

  it.each([
    ["drive list files", "drive.files.list"],
    ["calendar list events", "calendar.events.list"],
    ["sheets append values", "sheets.spreadsheets.values.append"],
    ["docs get document", "docs.documents.get"],
    ["forms responses list", "forms.forms.responses.list"],
    ["tasks insert", "tasks.tasks.insert"],
    ["slides batchUpdate replace text", "slides.presentations.batchUpdate"],
  ])("finds the expected method in the top 3 for %s", (query, expected) => {
    expect(names(run(query)).slice(0, 3)).toContain(expected);
    expect(names(search({ query }, registry(), config)).slice(0, 3)).toContain(expected);
  });

  it.each([
    ["survey", "forms."],
    ["quiz", "forms."],
    ["todo", "tasks."],
    ["tasklist", "tasks."],
    ["deck", "slides."],
    ["slide", "slides."],
    ["presentation", "slides."],
  ])("maps %s to its service", (word, prefix) => {
    const top = run(word).slice(0, 3);
    expect(top.length).toBeGreaterThan(0);
    expect(names(top).every((n) => n.startsWith(prefix))).toBe(true);
  });

  it.each([
    ["calendar freebusy response", "calendar."],
    ["drive list files response", "drive."],
  ])("keeps the named service first when %s also says 'response'", (query, prefix) => {
    expect(names(run(query))[0]?.startsWith(prefix)).toBe(true);
    expect(names(search({ query }, registry(), config))[0]?.startsWith(prefix)).toBe(true);
  });

  it("ranks the Forms responses list first for 'forms responses list'", () => {
    expect(names(run("forms responses list"))[0]).toBe("forms.forms.responses.list");
    expect(names(search({ query: "forms responses list" }, registry(), config))[0]).toBe("forms.forms.responses.list");
  });

  it("finds the new services' methods from everyday words", () => {
    expect(names(run("list survey responses")).slice(0, 3)).toContain("forms.forms.responses.list");
    expect(names(run("insert todo")).slice(0, 3)).toContain("tasks.tasks.insert");
    expect(names(run("get deck")).slice(0, 3)).toContain("slides.presentations.get");
  });

  it.each([
    ["seo top queries", "webmasters.searchanalytics.query"],
    ["gsc queries", "webmasters.searchanalytics.query"],
    ["search console sites", "webmasters.sites.list"],
    ["submit sitemap", "webmasters.sitemaps.submit"],
    ["website traffic report", "analyticsdata.properties.batchRunReports"],
    ["ga4 sessions", "analyticsdata.properties.batchRunReports"],
    ["analytics report", "analyticsdata.properties.runReport"],
    ["list analytics accounts", "analyticsadmin.accounts.list"],
    ["create analytics property", "analyticsadmin.properties.create"],
    ["list ads customers", "googleads.customers.listAccessibleCustomers"],
    ["adwords search", "googleads.customers.googleAds.search"],
    ["list groups", "directory.groups.list"],
    ["list group members", "directory.members.list"],
    ["group settings", "groupsSettings.groups.get"],
    ["find free time", "calendar.freebusy.query"],
    ["check availability", "calendar.freebusy.query"],
    ["gtm list tags", "tagmanager.accounts.containers.workspaces.tags.list"],
    ["list tag manager triggers", "tagmanager.accounts.containers.workspaces.triggers.list"],
    ["list gtm variables", "tagmanager.accounts.containers.workspaces.variables.list"],
    ["create workspace", "tagmanager.accounts.containers.workspaces.create"],
    ["publish gtm container", "tagmanager.accounts.containers.versions.publish"],
  ])("ranks a marketing, Groups or Tag Manager method in the top 3 for %s", (query, expected) => {
    expect(names(run(query)).slice(0, 3)).toContain(expected);
    expect(names(search({ query }, registry(), config)).slice(0, 3)).toContain(expected);
  });

  it.each([
    ["seo", "searchconsole"],
    ["gsc", "searchconsole"],
    ["traffic", "analytics"],
    ["ga4", "analytics"],
    ["adwords", "ads"],
    ["campaigns", "ads"],
    ["members", "groups"],
    ["gtm", "tagmanager"],
    ["container", "tagmanager"],
    ["workspace", "tagmanager"],
    ["triggers", "tagmanager"],
  ])("maps %s to the %s service", (word, service) => {
    const top = run(word).slice(0, 3);
    expect(top.length).toBeGreaterThan(0);
    const services = new Map(generatedFns.map((fn) => [fn.name, fn.service]));
    expect(top.map((r) => services.get(r.name))).toEqual(top.map(() => (service === "analytics" ? expect.stringMatching(/^analytics/) : service)));
  });

  it.each([
    ["gmail tag", "gmail.users.labels."],
    ["tag message", "gmail."],
    ["tag an email", "gmail."],
    ["drive tag file", "drive."],
    ["workspace admin", "access."],
  ])("keeps the everyday meaning of %s out of Tag Manager", (query, prefix) => {
    for (const results of [run(query), search({ query }, registry(), config)]) {
      const top = names(results).slice(0, 3);
      expect(top.length, query).toBeGreaterThan(0);
      expect(top.filter((n) => n.startsWith("tagmanager.")), query).toEqual([]);
    }
    // The full registry, which also holds the host functions (access.*).
    const first = names(search({ query }, registry(), config))[0];
    expect(first?.startsWith(prefix), `${query}: ${first}`).toBe(true);
  });

  it("ranks a Gmail label method for 'gmail tag' and a label change for 'tag an email'", () => {
    expect(names(run("gmail tag")).slice(0, 3)).toContain("gmail.users.labels.create");
    expect(names(run("tag an email")).slice(0, 3)).toContain("gmail.users.messages.modify");
  });

  it("still sends Tag Manager words to Tag Manager", () => {
    for (const query of ["tag manager", "gtm tags", "workspace"]) {
      const top = names(run(query)).slice(0, 3);
      expect(top, query).toHaveLength(3);
      for (const n of top) expect(n, query).toMatch(/^tagmanager\./);
    }
  });

  it("keeps a form publish first for a bare 'publish', with the Tag Manager publish right behind", () => {
    expect(names(run("publish")).slice(0, 2)).toEqual(["forms.forms.setPublishSettings", "tagmanager.accounts.containers.versions.publish"]);
    expect(names(run("publish form"))[0]).toBe("forms.forms.setPublishSettings");
  });

  it("flags the Tag Manager publish and Ads mutates as destructive in search results", () => {
    expect(run("publish gtm container").find((r) => r.name === "tagmanager.accounts.containers.versions.publish")?.destructiveHint).toBe(true);
    const mutates = run("adwords campaigns mutate").filter((r) => r.name.endsWith(".mutate"));
    expect(mutates.length).toBeGreaterThanOrEqual(3);
    for (const r of mutates) expect(r.destructiveHint, r.name).toBe(true);
    expect(run("seo top queries").find((r) => r.name === "webmasters.searchanalytics.query")?.destructiveHint).toBeUndefined();
  });

  it("splits a camelCase query word the way method names are indexed", () => {
    expect(names(run("docs batchUpdate"))[0]).toBe("docs.documents.batchUpdate");
    expect(run("batchUpdate")).toEqual(run("batch update"));
  });

  it("expands synonyms", () => {
    expect(names(run("send email"))).toContain("gmail.users.messages.send");
    expect(names(run("upload file"))).toContain("drive.files.create");
  });

  it("caps results at 10 and at the byte limit", () => {
    const results = run("list", { limit: 50 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(10);
    expect(new TextEncoder().encode(JSON.stringify(results)).length).toBeLessThanOrEqual(8000);
  });

  it("drops the lowest ranked results to honour a small byte cap", () => {
    const full = search({ query: "list" }, generatedFns, config);
    const small = search({ query: "list" }, generatedFns, { SEARCH_MAX_BYTES: 1500 });
    expect(small.length).toBeLessThan(full.length);
    expect(names(small)).toEqual(names(full).slice(0, small.length));
    expect(new TextEncoder().encode(JSON.stringify(small)).length).toBeLessThanOrEqual(1500);
  });

  it("truncates over-long signatures with an ellipsis", () => {
    const long: FnMeta = {
      name: "gmail.users.fake.huge",
      service: "gmail",
      effect: "read",
      description: "huge signature fixture",
      signature: `gmail.users.fake.huge({ ${"field: string, ".repeat(200)} }): Promise<void>`,
      tsDecl: "",
      example: "await sdk.gmail.users.fake.huge({})",
      tags: ["huge"],
      scopes: [],
    };
    const [hit] = search({ query: "huge" }, [long], config);
    expect(hit?.signature.endsWith("…")).toBe(true);
    expect(hit!.signature.length).toBeLessThan(long.signature.length);
  });

  it("applies the service filter before ranking", () => {
    const results = run("list", { service: "drive" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.name.startsWith("drive."))).toBe(true);
  });

  it("is deterministic", () => {
    expect(run("list files")).toEqual(run("list files"));
  });

  it("flags destructive methods", () => {
    const [hit] = run("drive files delete");
    expect(hit?.name).toBe("drive.files.delete");
    expect(hit?.destructiveHint).toBe(true);
    expect(run("gmail messages list")[0]?.destructiveHint).toBeUndefined();
  });

  it("hints exactly what the canonical destructive predicate flags by name", () => {
    const transfer = run("calendar transfer ownership").find((r) => r.name === "calendar.calendars.transferOwnership");
    expect(transfer?.destructiveHint).toBe(true);
    const removeHelper: FnMeta = {
      name: "helpers.drive.removeDuplicates",
      service: "helpers",
      effect: "write",
      description: "Remove duplicate files",
      signature: "helpers.drive.removeDuplicates(): Promise<void>",
      tsDecl: "",
      example: "",
      tags: ["dedupe"],
      scopes: [],
    };
    const [helperHit] = search({ query: "dedupe" }, [removeHelper], config);
    expect(helperHit?.name).toBe("helpers.drive.removeDuplicates");
    expect(helperHit?.destructiveHint).toBeUndefined();
    for (const fn of generatedFns) {
      const [r] = search({ query: fn.name.split(".").join(" ") }, [fn], config);
      expect(r?.destructiveHint === true).toBe(isDestructive(fn.name).destructive);
    }
  });

  it("ranks a helper above raw methods for a workflow query", () => {
    const helper: FnMeta = {
      name: "helpers.gmail.send",
      service: "helpers",
      effect: "write",
      description: "Send an email with optional attachments.",
      signature: "helpers.gmail.send({ to: string }): Promise<void>",
      tsDecl: "type Input = {}",
      example: "await sdk.helpers.gmail.send({})",
      tags: ["helper", "send", "mail", "attachment"],
      scopes: [],
    };
    const [top] = search({ query: "send mail with attachment" }, [...generatedFns, helper], config);
    expect(top?.name).toBe("helpers.gmail.send");
  });
});

describe("search fn mode", () => {
  it("returns the full declaration for an exact name", () => {
    const detail = search({ fn: "gmail.users.messages.list" }, generatedFns, config);
    expect(detail).toMatchObject({ name: "gmail.users.messages.list", effect: "read" });
    expect(detail.tsDecl).toContain("type Input");
    expect(detail.scopes.length).toBeGreaterThan(0);
    expect(detail.example).toContain("sdk.gmail");
  });

  it("rejects an unknown name with GWS_UNKNOWN_METHOD", () => {
    try {
      search({ fn: "gmail.users.nope" }, generatedFns, config);
      expect.unreachable();
    } catch (e) {
      expect(isGwsError(e) && e.code).toBe("GWS_UNKNOWN_METHOD");
    }
  });
});

describe("search laziness", () => {
  function counted(): { fns: FnDef[]; touched: Set<string> } {
    const touched = new Set<string>();
    const fns = generatedFns.map((orig) => {
      const wrapped = Object.create(null) as FnDef;
      for (const key of ["kind", "name", "service", "effect", "description", "signature", "example", "tags", "scopes"] as const) {
        Object.defineProperty(wrapped, key, { value: orig[key], enumerable: true });
      }
      for (const key of ["tsDecl", "input", "output"] as const) {
        Object.defineProperty(wrapped, key, {
          get() {
            touched.add(`${key}:${orig.name}`);
            return orig[key];
          },
        });
      }
      return wrapped;
    });
    return { fns, touched };
  }

  it("never evaluates lazy schemas while ranking or listing results", () => {
    const { fns, touched } = counted();
    expect(search({ query: "list" }, fns, config).length).toBeGreaterThan(0);
    expect(search({ query: "gmail messages list", service: "gmail" }, fns, config).length).toBeGreaterThan(0);
    expect([...touched]).toEqual([]);
  });

  it("evaluates only the requested declaration in fn mode", () => {
    const { fns, touched } = counted();
    search({ fn: "drive.files.get" }, fns, config);
    expect([...touched]).toEqual(["tsDecl:drive.files.get"]);
  });
});
