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
    expect(Object.keys(sdkManifest.discovery).sort()).toEqual(["calendar", "docs", "drive", "forms", "gmail", "sheets", "slides", "tasks"]);
    expect(sdkManifest.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
