import { describe, expect, it } from "vitest";
import { DEFAULT_HUMAN_APPROVAL, HUMAN_APPROVAL_REASONS, loadConfig } from "../../src/config";
import { DESTRUCTIVE_REASON_WORDS } from "../../src/core/destructive";
import { isGwsError } from "../../src/errors";

const BASE = {
  GOOGLE_UPSTREAM: "fake",
  PUBLIC_BASE_URL: "https://gws-mcp.example.workers.dev",
  FAKE_GOOGLE_PUBLIC_URL: "https://gws-mcp-fake-google.example.workers.dev",
};

const LOCAL_REFUSAL =
  "GWS_HUMAN_APPROVAL can only be off on this computer: the local gws-mcp has no web page where a person could approve a plan. Remove the setting, or set it to off";

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (isGwsError(e)) return e.message;
    throw e;
  }
  throw new Error("expected a throw");
}

describe("GWS_HUMAN_APPROVAL", () => {
  it("defaults on a web target to spend, public-share, owner-transfer, permission-change and publish", () => {
    expect(loadConfig(BASE).GWS_HUMAN_APPROVAL).toEqual(["spend", "public-share", "owner-transfer", "permission-change", "publish"]);
    expect(loadConfig({ ...BASE, GWS_HUMAN_APPROVAL: " " }).GWS_HUMAN_APPROVAL).toEqual(DEFAULT_HUMAN_APPROVAL);
  });

  it("takes off, or a comma list of reasons (spaces, case and repeats allowed)", () => {
    expect(loadConfig({ ...BASE, GWS_HUMAN_APPROVAL: "off" }).GWS_HUMAN_APPROVAL).toEqual([]);
    expect(loadConfig({ ...BASE, GWS_HUMAN_APPROVAL: " OFF " }).GWS_HUMAN_APPROVAL).toEqual([]);
    expect(loadConfig({ ...BASE, GWS_HUMAN_APPROVAL: "spend, Delete,spend" }).GWS_HUMAN_APPROVAL).toEqual(["spend", "delete"]);
  });

  it("fails loading on an unknown reason with a plain message naming the choices, never the value", () => {
    for (const bad of ["spend,launch-missiles", "spend,", "off,spend", "disconnect", "everything"]) {
      const text = message(() => loadConfig({ ...BASE, GWS_HUMAN_APPROVAL: bad }));
      expect(text).toBe(`invalid config: GWS_HUMAN_APPROVAL must be off or a comma list of these reasons: ${HUMAN_APPROVAL_REASONS.join(", ")}`);
      expect(text).not.toContain("launch");
    }
  });

  it("offers every destructive reason a Google request can carry: all but disconnect", () => {
    expect([...HUMAN_APPROVAL_REASONS].sort()).toEqual(Object.keys(DESTRUCTIVE_REASON_WORDS).filter((r) => r !== "disconnect").sort());
  });

  it("is off on the local server by default, and refuses anything else there with a plain message", () => {
    expect(loadConfig(BASE, "local").GWS_HUMAN_APPROVAL).toEqual([]);
    expect(loadConfig({ ...BASE, GWS_HUMAN_APPROVAL: "off" }, "local").GWS_HUMAN_APPROVAL).toEqual([]);
    expect(message(() => loadConfig({ ...BASE, GWS_HUMAN_APPROVAL: "spend" }, "local"))).toBe(LOCAL_REFUSAL);
    expect(message(() => loadConfig({ ...BASE, GWS_HUMAN_APPROVAL: ["spend"] }, "local"))).toBe(LOCAL_REFUSAL);
    expect(message(() => loadConfig({ ...BASE, GWS_HUMAN_APPROVAL: "nonsense" }, "local"))).toContain("invalid config: GWS_HUMAN_APPROVAL");
  });

  it("reloads a loaded config's own list unchanged, an empty one staying off", () => {
    const on = loadConfig({ ...BASE, GWS_HUMAN_APPROVAL: "publish" });
    expect(loadConfig({ ...on, PUBLIC_BASE_URL: BASE.PUBLIC_BASE_URL }).GWS_HUMAN_APPROVAL).toEqual(["publish"]);
    const off = loadConfig({ ...BASE, GWS_HUMAN_APPROVAL: "off" });
    expect(loadConfig({ ...off, PUBLIC_BASE_URL: BASE.PUBLIC_BASE_URL }).GWS_HUMAN_APPROVAL).toEqual([]);
  });
});
