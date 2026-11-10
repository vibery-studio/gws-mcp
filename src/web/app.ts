import { Hono } from "hono";
import { authRoutes } from "../auth/routes";
import { connectionsRoutes } from "./connections";
import { ipLimit } from "./ip-limit";
import { versionRoutes } from "./version";

/** Every route outside `/mcp`: sign-in, consent, connections and version. */
export const webApp = new Hono<{ Bindings: Env }>();

// Per-address limits, ahead of the handlers and on the paths as routed (percent-decoded), so no spelling escapes them.
webApp.use("/login", ipLimit("/login"));
webApp.use("/authorize", ipLimit("/authorize"));

webApp.route("/", authRoutes);
webApp.route("/", connectionsRoutes);
webApp.route("/", versionRoutes);

webApp.notFound((c) => c.json({ error: "not_found" }, 404));
// Never expose internal error messages to the browser.
webApp.onError((_err, c) => c.json({ error: "internal_error" }, 500));
