import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { sdkManifest } from "../../src/sdk/generated/manifest";

const worker = exports.default;

describe("GET /version", () => {
  it("reports the package version, SDK hash, discovery revisions and upstream mode", async () => {
    const res = await worker.fetch("http://localhost/version");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "gws-mcp",
      version: pkg.version,
      sdkHash: sdkManifest.hash,
      discovery: sdkManifest.discovery,
      upstream: "fake",
    });
  });
});
