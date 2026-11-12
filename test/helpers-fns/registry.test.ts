import { describe, expect, it } from "vitest";
import { buildRegistry, getRegistry } from "../../src/core/registry";
import { search } from "../../src/core/search";
import { helperFns } from "../../src/sdk/helpers/index";

const config = { SEARCH_MAX_BYTES: 8000 };

const EXPECTED = [
  ["helpers.sendMailWithAttachment", "write", "send an email with an attachment"],
  ["helpers.todayAgenda", "read", "what is on my calendar today agenda"],
  ["helpers.appendSheetRows", "write", "append rows to a spreadsheet"],
  ["helpers.exportDocPdf", "read", "export a google doc as pdf"],
  ["helpers.uploadDriveFile", "write", "upload a file to drive"],
  ["tasks.addTask", "write", "add a task to my todo list"],
  ["forms.responsesToSheet", "write", "copy form responses to a spreadsheet"],
  ["slides.fillTemplate", "write", "fill a slides template"],
  ["searchconsole.topQueries", "read", "top search queries from google search console"],
  ["searchconsole.topPages", "read", "top pages by clicks in search console"],
  ["searchconsole.inspect", "read", "check if a url is indexed by google"],
  ["analytics.report", "read", "google analytics sessions report"],
  ["analytics.properties", "read", "list google analytics properties"],
  ["ads.accounts", "read", "list google ads accounts"],
  ["ads.report", "read", "google ads campaign report"],
  ["calendar.share", "write", "share my calendar with a colleague"],
  ["calendar.unshare", "write", "stop sharing my calendar"],
  ["calendar.findFreeSlots", "read", "find a free time slot when everyone is available"],
  ["calendar.respond", "write", "accept a calendar invitation"],
  ["calendar.move", "write", "move an event to another calendar"],
  ["tagmanager.containers", "read", "list google tag manager containers"],
  ["tagmanager.workspaceStatus", "read", "tag manager workspace pending changes"],
  ["tagmanager.publish", "write", "publish gtm container"],
] as const;

describe("workspace helpers", () => {
  it("registers exactly the expected helpers as host fns of the helpers service", () => {
    expect(helperFns.map((f) => f.name).sort()).toEqual(EXPECTED.map(([n]) => n).sort());
    for (const fn of helperFns) {
      expect(fn.kind).toBe("host");
      expect(fn.service).toBe("helpers");
      expect(typeof fn.run).toBe("function");
    }
  });

  it("passes the registry's consistency checks and sits next to the generated fns", () => {
    expect(() => buildRegistry(helperFns)).not.toThrow();
    for (const [name] of EXPECTED) expect(getRegistry().has(name)).toBe(true);
  });

  it.each(EXPECTED)("%s is a %s with a signature, example and tags", (name, effect) => {
    const fn = helperFns.find((f) => f.name === name);
    expect(fn?.effect).toBe(effect);
    expect(fn?.signature).toContain(`${name}(`);
    expect(fn?.signature).toContain("Promise<");
    expect(fn?.example).toContain(`await sdk.${name}(`);
    expect(fn?.tags).toContain(effect);
    expect(fn?.tsDecl.length).toBeGreaterThan(20);
    expect(fn?.description.length).toBeGreaterThan(20);
  });

  it.each(EXPECTED)("search finds %s in the top 3 for a plain-language query", (name, _effect, query) => {
    const top = search({ query }, [...getRegistry().values()], config).map((r) => r.name);
    expect(top.slice(0, 3)).toContain(name);
  });
});
