import { describe, expect, it } from "vitest";

/** Every source file of the helpers, by path. */
const sources = import.meta.glob("../../src/sdk/helpers/*.ts", { query: "?raw", import: "default", eager: true });
const FILES = Object.entries(sources);

/** Anything that reaches Google or the network without the dispatcher. */
const UPSTREAM_ACCESS = /google\/(?:client|transport|request|oauth)|callGoogle|createTransport|\bfetch\s*\(|\.fetch\b|XMLHttpRequest|env\./;

describe("helpers reach Google only through ctx.call", () => {
  it("finds the helper sources", () => {
    expect(FILES.map(([p]) => p.split("/").pop()).sort()).toEqual([
      "add-task.ts",
      "ads.ts",
      "analytics.ts",
      "append-rows.ts",
      "calendar-control.ts",
      "export-pdf.ts",
      "fill-template.ts",
      "index.ts",
      "mime.ts",
      "responses-to-sheet.ts",
      "searchconsole.ts",
      "send-mail.ts",
      "tagmanager.ts",
      "today-agenda.ts",
      "upload-file.ts",
    ]);
  });

  it.each(FILES.map(([p, text]) => [p.split("/").pop(), text] as const))("%s has no direct upstream access", (_file, text) => {
    expect(UPSTREAM_ACCESS.exec(text)?.[0]).toBeUndefined();
  });

  it.each([
    "add-task.ts",
    "ads.ts",
    "analytics.ts",
    "append-rows.ts",
    "calendar-control.ts",
    "export-pdf.ts",
    "fill-template.ts",
    "responses-to-sheet.ts",
    "searchconsole.ts",
    "send-mail.ts",
    "tagmanager.ts",
    "today-agenda.ts",
    "upload-file.ts",
  ])("%s calls Google through ctx.call", (file) => {
    const text = FILES.find(([p]) => p.endsWith(`/${file}`))?.[1] ?? "";
    expect(text).toContain("ctx.call(");
  });
});
