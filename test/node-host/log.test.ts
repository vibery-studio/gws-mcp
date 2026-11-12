import { describe, expect, it } from "vitest";
import { MAX_LOG_CHARS, jsonLogger, routeConsole } from "../../src/runtime/node/log";

function capture() {
  const out: Array<{ stream: string; line: string }> = [];
  const log = jsonLogger(
    (stream, line) => out.push({ stream, line }),
    () => new Date("2026-11-12T00:00:00.000Z"),
  );
  return { out, log };
}

describe("the Node host's JSON logger", () => {
  it("writes one JSON line per call, whatever the text holds; errors on stderr", () => {
    const { out, log } = capture();
    const forged = `x\n{"ts":"2026-11-12T00:00:00.000Z","level":"error","msg":"FORGED"}\r\n\u2028\u2029\u0000`;
    log("warn", forged, { error: forged, n: 3 });
    log("error", "boom");
    expect(out.map((o) => o.stream)).toEqual(["stdout", "stderr"]);
    for (const { line } of out) {
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1)).not.toMatch(/[\n\r\u2028\u2029\u0000]/);
    }
    expect(JSON.parse(out[0]?.line ?? "")).toEqual({ ts: "2026-11-12T00:00:00.000Z", level: "warn", msg: forged, error: forged, n: 3 });
  });

  it("cuts every string at MAX_LOG_CHARS and says how much was cut", () => {
    const { out, log } = capture();
    const long = "s".repeat(MAX_LOG_CHARS + 500);
    log("error", long, { error: long });
    const parsed = JSON.parse(out[0]?.line ?? "") as { msg: string; error: string };
    expect(parsed.msg).toBe(`${"s".repeat(MAX_LOG_CHARS)}… [500 more characters]`);
    expect(parsed.error).toBe(parsed.msg);
  });
});

describe("console routed through the logger", () => {
  it("turns every console call into one log line, an Error's stack cut with it", () => {
    const { out, log } = capture();
    const target = { log() {}, info() {}, debug() {}, warn() {}, error() {}, trace() {} } as unknown as Console;
    routeConsole(log, target);
    target.warn("OAuth error response: %d %s - %s", 400, "invalid_request", 'Request parameter "x\n{"msg":"FORGED"}" must not be repeated');
    target.log("plain");
    target.debug("debug");
    const e = new Error("deep");
    e.stack = `Error: deep\n${"    at frame (file.js:1:1)\n".repeat(200)}`;
    target.error("the Worker fetch threw", e);
    const lines = out.map((o) => JSON.parse(o.line) as Record<string, unknown>);
    expect(lines.map((l) => [l.level, l.msg])).toEqual([
      ["warn", "console"],
      ["info", "console"],
      ["info", "console"],
      ["error", "console"],
    ]);
    expect(lines[0]?.message).toBe('OAuth error response: 400 invalid_request - Request parameter "x\n{"msg":"FORGED"}" must not be repeated');
    expect(String(lines[3]?.message)).toMatch(/^the Worker fetch threw Error: deep\n {4}at frame/);
    expect(String(lines[3]?.message).length).toBeLessThan(MAX_LOG_CHARS + 40);
  });

  it("replaces the provider's wrangler.jsonc CIMD notice with a plain line for this host", () => {
    const { out, log } = capture();
    const target = { log() {}, info() {}, debug() {}, warn() {}, error() {}, trace() {} } as unknown as Console;
    routeConsole(log, target);
    target.warn(
      `CIMD (Client ID Metadata Document) is disabled: add '"compatibility_flags": ["global_fetch_strictly_public"]' to your wrangler.jsonc to enable. See: https://developers.cloudflare.com/`,
    );
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]?.line ?? "")).toMatchObject({ level: "info", msg: "client ID metadata documents (CIMD) are off on this host; AI apps register dynamically" });
    expect(out[0]?.line).not.toContain("wrangler");
  });
});
