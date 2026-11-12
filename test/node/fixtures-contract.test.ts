import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFixture } from "../../fake-google/src/fixtures";
import type { FnDef } from "../../src/contracts";
import { generatedFns } from "../../src/sdk/generated/index";

const FIXTURES = path.join(import.meta.dirname, "../../fake-google/fixtures");
/** Folders that hold no request/response pairs. */
const NOT_FIXTURES = new Set(["seed"]);

interface Candidate {
  fn: FnDef;
  method: string;
  regex: RegExp;
  /** Literal characters of the template: the more, the more specific the route. */
  specificity: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `a/{x}/b:{+y}` to a regex over the host-prefixed path. */
function templateRegex(host: string, template: string): { regex: RegExp; specificity: number } {
  let specificity = 0;
  let source = "";
  for (const piece of template.split(/(\{\+?[^}]+\})/)) {
    if (piece.startsWith("{+")) source += ".+";
    else if (piece.startsWith("{")) source += "[^/]+";
    else {
      source += escape(piece);
      specificity += piece.length;
    }
  }
  return { regex: new RegExp(`^/${escape(host)}/${source}$`), specificity };
}

function candidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const fn of generatedFns) {
    const m = fn.method;
    if (!m) continue;
    const host = new URL(m.rootUrl).host;
    const templates = [`${m.servicePath}${m.path}`];
    if (m.mediaUpload) templates.push(m.mediaUpload.simplePath.replace(/^\//, ""), m.mediaUpload.multipartPath.replace(/^\//, ""));
    for (const t of templates) out.push({ fn, method: m.httpMethod, ...templateRegex(host, t) });
  }
  return out;
}

const CANDIDATES = candidates();

/** The generated method a request maps to: the most specific template that matches. */
function methodFor(httpMethod: string, requestPath: string): { fn?: FnDef; problem?: string } {
  const hits = CANDIDATES.filter((c) => c.method === httpMethod && c.regex.test(requestPath));
  if (hits.length === 0) return { problem: `no generated method for ${httpMethod} ${requestPath}` };
  const best = Math.max(...hits.map((h) => h.specificity));
  const top = [...new Set(hits.filter((h) => h.specificity === best).map((h) => h.fn.name))];
  if (top.length > 1) return { problem: `ambiguous: ${httpMethod} ${requestPath} matches ${top.join(", ")}` };
  return { fn: hits.find((h) => h.specificity === best)?.fn };
}

/** Problems with one fixture; empty when its request maps to a generated method and its body parses. */
function checkFixture(file: string, raw: unknown): string[] {
  let fixture;
  try {
    fixture = parseFixture(raw);
  } catch (e) {
    return [`${file}: not a fixture: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`];
  }
  const found = methodFor(fixture.request.method, fixture.request.path);
  if (!found.fn) return [`${file}: ${found.problem ?? "no generated method"}`];
  // Error responses are not shaped by the output schema.
  if (fixture.response.status < 200 || fixture.response.status >= 300) return [];
  const parsed = found.fn.output.safeParse(fixture.response.body);
  if (parsed.success) return [];
  const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return [`${file}: body does not match the output schema of ${found.fn.name}: ${issues.join("; ")}`];
}

function fixtureFiles(): string[] {
  const files: string[] = [];
  for (const dir of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (!dir.isDirectory() || NOT_FIXTURES.has(dir.name)) continue;
    for (const f of readdirSync(path.join(FIXTURES, dir.name))) if (f.endsWith(".json")) files.push(path.join(dir.name, f));
  }
  return files.sort();
}

describe("fixture contract", () => {
  const files = fixtureFiles();

  it("covers every service's fixture folder", () => {
    const services = new Set(files.map((f) => f.split(path.sep)[0]));
    expect([...services].sort()).toEqual(["ads", "analytics", "calendar", "docs", "drive", "forms", "gmail", "groups", "searchconsole", "sheets", "slides", "tagmanager", "tasks"]);
  });

  it.each(files.map((f) => [f] as const))("%s maps to a generated method and validates against its output schema", (file) => {
    const raw: unknown = JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8"));
    expect(checkFixture(file, raw)).toEqual([]);
  });

  it("gives every fixture a unique id", () => {
    const ids = files.map((f) => (JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8")) as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("checkFixture", () => {
  const good = {
    id: "calendar-events-list",
    source: "synthesized",
    provenance: "test",
    request: { method: "GET", path: "/www.googleapis.com/calendar/v3/calendars/primary/events" },
    response: { status: 200, headers: {}, body: { kind: "calendar#events", items: [] } },
  };

  it("accepts a well-formed fixture", () => {
    expect(checkFixture("good.json", good)).toEqual([]);
  });

  it("fails a body that does not match the output schema and prints the fixture path", () => {
    const broken = { ...good, response: { ...good.response, body: { kind: "calendar#events", items: "not a list" } } };
    const problems = checkFixture("calendar/broken.json", broken);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("calendar/broken.json");
    expect(problems[0]).toContain("calendar.events.list");
    expect(problems[0]).toContain("items");
  });

  it("fails a request that maps to no generated method", () => {
    const stray = { ...good, request: { method: "GET", path: "/www.googleapis.com/calendar/v3/nothing/here" } };
    expect(checkFixture("calendar/stray.json", stray)[0]).toContain("no generated method");
  });

  it("fails a file that is not a fixture", () => {
    expect(checkFixture("calendar/odd.json", { id: "x" })[0]).toContain("not a fixture");
  });

  it("picks the most specific method: trash is not a file id", () => {
    expect(methodFor("DELETE", "/www.googleapis.com/drive/v3/files/trash").fn?.name).toBe("drive.files.emptyTrash");
    expect(methodFor("DELETE", "/www.googleapis.com/drive/v3/files/abc").fn?.name).toBe("drive.files.delete");
    expect(methodFor("POST", "/sheets.googleapis.com/v4/spreadsheets/s1/values/Sheet1%21A1:append").fn?.name).toBe("sheets.spreadsheets.values.append");
  });

  it("skips the body of an error response", () => {
    const failed = { ...good, response: { status: 404, headers: {}, body: { error: { code: 404 } } } };
    expect(checkFixture("calendar/missing.json", failed)).toEqual([]);
  });
});
