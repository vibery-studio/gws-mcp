import { format } from "node:util";
import type { Logger } from "./http";

/**
 * The Node host's only output: one JSON object per line, `{ts, level, msg, ...fields}`. Errors go to stderr, the
 * rest to stdout.
 *
 * - Every value is JSON-encoded, so no text (a newline or control character in a request parameter that a
 *   dependency echoes) can start a line of its own; U+2028/U+2029 are escaped too.
 * - Every string, the message included, is cut at `MAX_LOG_CHARS`, so one request cannot write an unbounded line
 *   (a stack is cut with it).
 * - `routeConsole` sends `console.*` through it: the Worker app and its dependencies log with `console`, which on
 *   Workers is one log record per call but on Node would be raw, multi-line text.
 */

/** The most characters of one logged string. */
export const MAX_LOG_CHARS = 2048;

/** `workers-oauth-provider` prints this at module load when the `global_fetch_strictly_public` flag is absent. */
const CIMD_NOTICE = "CIMD (Client ID Metadata Document) is disabled";

function cap(value: string): string {
  return value.length <= MAX_LOG_CHARS ? value : `${value.slice(0, MAX_LOG_CHARS)}… [${value.length - MAX_LOG_CHARS} more characters]`;
}

function capped(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = typeof v === "string" ? cap(v) : v;
  return out;
}

/** The JSON-lines logger, writing through `write` (the process streams by default). */
export function jsonLogger(
  write: (stream: "stdout" | "stderr", line: string) => void = (stream, line) => process[stream].write(line),
  now: () => Date = () => new Date(),
): Logger {
  return (level, msg, fields = {}) => {
    const line = JSON.stringify({ ts: now().toISOString(), level, msg: cap(msg), ...capped(fields) }).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    write(level === "error" ? "stderr" : "stdout", `${line}\n`);
  };
}

/**
 * Replaces `console.log/info/debug/warn/error/trace` with calls to `log`: each call is one line, msg `console`, the
 * formatted arguments in `message`. The provider's CIMD notice, whose advice (a wrangler.jsonc flag) means nothing
 * on Node, becomes a plain info line.
 */
export function routeConsole(log: Logger, target: Console = console): void {
  const route =
    (level: "info" | "warn" | "error") =>
    (...args: unknown[]): void => {
      const message = format(...args);
      if (message.startsWith(CIMD_NOTICE)) {
        log("info", "client ID metadata documents (CIMD) are off on this host; AI apps register dynamically");
        return;
      }
      log(level, "console", { message });
    };
  target.log = route("info");
  target.info = route("info");
  target.debug = route("info");
  target.warn = route("warn");
  target.error = route("error");
  target.trace = route("error");
}
