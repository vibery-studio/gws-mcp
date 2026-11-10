import { Hono } from "hono";
import pkg from "../../package.json";
import { loadConfig } from "../config";
import { sdkManifest } from "../sdk/generated/manifest";

/** `/version`: package version, SDK hash, pinned Discovery revisions and upstream mode. */
export const versionRoutes = new Hono<{ Bindings: Env }>();

versionRoutes.get("/version", (ctx) => {
  const config = loadConfig(ctx.env);
  return ctx.json({
    name: "gws-mcp",
    version: pkg.version,
    sdkHash: sdkManifest.hash,
    discovery: sdkManifest.discovery,
    upstream: config.GOOGLE_UPSTREAM,
  });
});
