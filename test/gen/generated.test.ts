import { describe, expect, it } from "vitest";
import { generatedFns } from "../../src/sdk/generated/index";
import { sdkManifest } from "../../src/sdk/generated/manifest";
import unsupportedReport from "../../src/sdk/generated/UNSUPPORTED.md?raw";

const byName = (name: string) => {
  const fn = generatedFns.find((f) => f.name === name);
  if (!fn) throw new Error(`missing ${name}`);
  return fn;
};

describe("committed SDK", () => {
  it("registers exactly the supported methods with unique names", () => {
    expect(generatedFns).toHaveLength(sdkManifest.methods.supported);
    expect(new Set(generatedFns.map((f) => f.name)).size).toBe(generatedFns.length);
    expect(generatedFns.every((f) => f.kind === "google" && f.method !== undefined)).toBe(true);
  });

  it("lists gmail.users.messages.list as a read with the readonly scope", () => {
    const fn = byName("gmail.users.messages.list");
    expect(fn.effect).toBe("read");
    expect(fn.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(fn.signature).toContain("gmail.users.messages.list(");
    expect(fn.example).toBe('await sdk.gmail.users.messages.list({ userId: "<userId>" })');
    expect(fn.tsDecl).toContain("type Input =");
    expect(fn.tsDecl).toContain("interface ListMessagesResponse");
    expect(fn.tsDecl).toContain("interface Message {");
  });

  it("classifies writes, uploads and downloads", () => {
    expect(byName("drive.files.delete").effect).toBe("write");
    expect(byName("drive.files.create").method?.mediaUpload).toBeDefined();
    expect(byName("drive.files.export").method?.mediaDownload).toBe(true);
    expect(byName("calendar.freebusy.query").effect).toBe("read");
    expect(byName("gmail.users.messages.send").method?.mediaUpload).toBeUndefined();
  });

  it("validates inputs and responses", () => {
    const list = byName("gmail.users.messages.list");
    expect(list.input.safeParse({ userId: "me", maxResults: 5, account: "work" }).success).toBe(true);
    expect(list.input.safeParse({ maxResults: 5 }).success).toBe(false);
    expect(list.input.safeParse({ userId: "me", bogus: 1 }).success).toBe(false);
    expect(list.output.safeParse({ messages: [{ id: "1" }], futureField: true }).success).toBe(true);
    expect(list.output.safeParse({ messages: "x" }).success).toBe(false);
  });

  it("returns media for export and either shape for files.get", () => {
    const media = { mimeType: "application/pdf", sizeBytes: 3, dataBase64: "AAAA" };
    expect(byName("drive.files.export").output.safeParse(media).success).toBe(true);
    expect(byName("drive.files.get").output.safeParse(media).success).toBe(true);
    expect(byName("drive.files.get").output.safeParse({ id: "f", name: "n" }).success).toBe(true);
    expect(byName("drive.files.get").input.safeParse({ fileId: "f", alt: "media" }).success).toBe(true);
  });

  it("omits push channel methods", () => {
    expect(generatedFns.some((f) => f.name.endsWith(".watch") || f.name.endsWith(".channels.stop"))).toBe(false);
  });

  it("generates methods for forms, tasks and slides", () => {
    for (const service of ["forms", "tasks", "slides"]) {
      expect(generatedFns.filter((f) => f.method?.service === service).length, service).toBeGreaterThan(0);
    }
  });

  it("validates inputs and outputs of the forms, tasks and slides methods", () => {
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["forms.forms.get", { formId: "f1" }, { formId: "f1", info: { title: "T" }, items: [] }],
      ["forms.forms.responses.list", { formId: "f1", pageSize: 10 }, { responses: [{ responseId: "r1" }], nextPageToken: "n" }],
      ["tasks.tasklists.list", { maxResults: 10 }, { items: [{ id: "l1", title: "L" }] }],
      ["tasks.tasks.insert", { tasklist: "l1", requestBody: { title: "do it" } }, { id: "t1", title: "do it" }],
      ["slides.presentations.get", { presentationId: "p1" }, { presentationId: "p1", slides: [] }],
      ["slides.presentations.batchUpdate", { presentationId: "p1", requestBody: { requests: [{ replaceAllText: { containsText: { text: "{{x}}" }, replaceText: "y" } }] } }, { presentationId: "p1", replies: [{}] }],
      ["slides.presentations.create", { requestBody: { title: "Deck" } }, { presentationId: "p1", title: "Deck" }],
    ];
    for (const [name, input, output] of cases) {
      const fn = byName(name);
      expect(fn.input.safeParse(input).success, name).toBe(true);
      expect(fn.input.safeParse({ ...input, bogus: 1 }).success, name).toBe(false);
      expect(fn.output.safeParse(output).success, name).toBe(true);
    }
    expect(byName("forms.forms.responses.list").input.safeParse({}).success).toBe(false);
    expect(byName("tasks.tasks.insert").effect).toBe("write");
    expect(byName("slides.presentations.batchUpdate").effect).toBe("write");
    expect(byName("slides.presentations.get").effect).toBe("read");
  });

  it("lists the forms watches as unsupported push channels", () => {
    for (const verb of ["create", "delete", "list", "renew"]) {
      expect(unsupportedReport).toContain(`| forms.forms.watches.${verb} | push notification channel; needs a public receiver |`);
      expect(generatedFns.some((f) => f.name === `forms.forms.watches.${verb}`)).toBe(false);
    }
  });

  it("records the pinned discovery revisions", () => {
    expect(Object.keys(sdkManifest.discovery).sort()).toEqual([
      "admin",
      "analyticsadmin",
      "analyticsdata",
      "calendar",
      "docs",
      "drive",
      "forms",
      "gmail",
      "googleads",
      "groupssettings",
      "searchconsole",
      "sheets",
      "slides",
      "tagmanager",
      "tasks",
    ]);
    expect(sdkManifest.discovery.admin).toMatch(/^directory_v1@/);
    expect(sdkManifest.discovery.googleads).toMatch(/^v23@/);
    expect(sdkManifest.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("generates every new service from its documents, with groups spanning two", () => {
    const count = (service: string) => generatedFns.filter((f) => f.method?.service === service).length;
    for (const service of ["searchconsole", "analytics", "analyticsadmin", "ads", "groups"]) expect(count(service), service).toBeGreaterThan(0);
    expect(generatedFns.filter((f) => f.method?.service === "groups").map((f) => f.name.split(".")[0])).toEqual(
      expect.arrayContaining(["directory", "groupsSettings"]),
    );
  });

  it("scopes the directory to groups and members and ads to its reads plus the mutate family", () => {
    const directory = generatedFns.filter((f) => f.name.startsWith("directory.")).map((f) => f.name);
    expect(directory.length).toBeGreaterThan(0);
    expect(directory.every((n) => n.startsWith("directory.groups.") || n.startsWith("directory.members."))).toBe(true);
    expect(generatedFns.some((f) => f.name.startsWith("directory.users."))).toBe(false);
    const ads = generatedFns.filter((f) => f.method?.service === "ads").map((f) => f.name);
    for (const read of ["listAccessibleCustomers", "googleAds.search", "googleAds.searchStream"]) expect(ads).toContain(`googleads.customers.${read}`);
    expect(ads.filter((n) => !n.endsWith(".mutate")).sort()).toEqual([
      "googleads.customers.googleAds.search",
      "googleads.customers.googleAds.searchStream",
      "googleads.customers.listAccessibleCustomers",
    ]);
    expect(ads).toContain("googleads.customers.campaigns.mutate");
    expect(ads).toContain("googleads.customers.googleAds.mutate");
    expect(unsupportedReport).toContain("`directory.groups.*`, `directory.members.*`");
    expect(unsupportedReport).toContain("`*.mutate`");
  });

  it("classifies the marketing reads as reads and every mutate and admin change as a write", () => {
    for (const name of [
      "webmasters.searchanalytics.query",
      "searchconsole.urlInspection.index.inspect",
      "analyticsdata.properties.runReport",
      "analyticsdata.properties.batchRunReports",
      "analyticsdata.properties.runRealtimeReport",
      "analyticsdata.properties.runPivotReport",
      "analyticsdata.properties.checkCompatibility",
      "analyticsadmin.properties.runAccessReport",
      "googleads.customers.googleAds.search",
      "googleads.customers.googleAds.searchStream",
      "googleads.customers.listAccessibleCustomers",
    ]) {
      expect(byName(name).effect, name).toBe("read");
    }
    for (const name of [
      "webmasters.sitemaps.submit",
      "webmasters.sitemaps.delete",
      "analyticsdata.properties.audienceExports.create",
      "analyticsadmin.properties.delete",
      "directory.groups.delete",
      "directory.members.delete",
      "directory.members.insert",
      "groupsSettings.groups.patch",
    ]) {
      expect(byName(name).effect, name).toBe("write");
    }
    const mutates = generatedFns.filter((f) => f.name.endsWith(".mutate"));
    expect(mutates.length).toBeGreaterThan(50);
    expect(mutates.every((f) => f.effect === "write")).toBe(true);
  });

  it("validates inputs and outputs of the marketing and groups methods", () => {
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["webmasters.sites.list", {}, { siteEntry: [{ siteUrl: "sc-domain:x.test", permissionLevel: "siteOwner" }] }],
      ["webmasters.searchanalytics.query", { siteUrl: "sc-domain:x.test", requestBody: { startDate: "2026-11-01", endDate: "2026-11-07", dimensions: ["query"] } }, { rows: [{ keys: ["a"], clicks: 1 }] }],
      ["analyticsdata.properties.runReport", { property: "properties/1", requestBody: { dimensions: [{ name: "city" }], metrics: [{ name: "sessions" }] } }, { rows: [], rowCount: 0 }],
      ["analyticsadmin.accounts.list", {}, { accounts: [{ name: "accounts/1" }] }],
      ["directory.groups.list", { domain: "x.test" }, { groups: [{ email: "g@x.test" }] }],
      ["directory.members.list", { groupKey: "g@x.test" }, { members: [{ email: "m@x.test", role: "MEMBER" }] }],
      ["groupsSettings.groups.get", { groupUniqueId: "g@x.test" }, { email: "g@x.test" }],
      ["googleads.customers.listAccessibleCustomers", {}, { resourceNames: ["customers/1"] }],
      ["googleads.customers.googleAds.search", { customerId: "1", requestBody: { query: "SELECT campaign.id FROM campaign" } }, { results: [], totalResultsCount: "0" }],
    ];
    for (const [name, input, output] of cases) {
      const fn = byName(name);
      expect(fn.input.safeParse(input).success, name).toBe(true);
      expect(fn.input.safeParse({ ...input, bogus: 1 }).success, name).toBe(false);
      expect(fn.output.safeParse(output).success, name).toBe(true);
    }
    expect(byName("googleads.customers.googleAds.search").input.safeParse({}).success).toBe(false);
  });

  it("lists a method whose parameter collides with a reserved input key as unsupported", () => {
    expect(unsupportedReport).toContain("| analyticsadmin.accounts.searchChangeHistoryEvents | parameter name account collides with a reserved input key |");
    expect(generatedFns.some((f) => f.name === "analyticsadmin.accounts.searchChangeHistoryEvents")).toBe(false);
  });

  it("generates the whole Tag Manager API, reading folder entities and writing every change", () => {
    const tm = generatedFns.filter((f) => f.method?.service === "tagmanager");
    expect(tm.length).toBeGreaterThan(100);
    expect(sdkManifest.discovery.tagmanager).toMatch(/^v2@/);
    expect(tm.every((f) => f.name.startsWith("tagmanager.accounts."))).toBe(true);
    for (const name of [
      "tagmanager.accounts.list",
      "tagmanager.accounts.containers.workspaces.getStatus",
      "tagmanager.accounts.containers.workspaces.tags.list",
      "tagmanager.accounts.containers.workspaces.folders.entities",
    ]) {
      expect(byName(name).effect, name).toBe("read");
    }
    for (const name of [
      "tagmanager.accounts.containers.workspaces.tags.create",
      "tagmanager.accounts.containers.workspaces.create_version",
      "tagmanager.accounts.containers.versions.publish",
      "tagmanager.accounts.containers.delete",
      "tagmanager.accounts.user_permissions.update",
    ]) {
      expect(byName(name).effect, name).toBe("write");
    }
    expect(byName("tagmanager.accounts.containers.versions.publish").method?.scopes).toEqual(["https://www.googleapis.com/auth/tagmanager.publish"]);
    expect(tm.filter((f) => f.method?.httpMethod === "POST" && f.effect === "read").map((f) => f.name)).toEqual([
      "tagmanager.accounts.containers.workspaces.folders.entities",
    ]);
  });
});
