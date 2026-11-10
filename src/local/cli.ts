#!/usr/bin/env node
/**
 * The `gws-mcp` command. This entry only checks the Node.js version and keeps Node's "SQLite is experimental" notice
 * out of the output, then loads the commands: loading them imports `node:sqlite`, which an older Node does not have.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIN_NODE = [22, 13, 0] as const;

function nodeSupported(version: string): boolean {
  const v = version.split(".").map(Number);
  for (let i = 0; i < MIN_NODE.length; i++) {
    const have = v[i] ?? 0;
    const need = MIN_NODE[i] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

/**
 * Node prints an ExperimentalWarning when `node:sqlite` loads. This drops that one warning and hands every other one
 * to the listeners Node had installed, so its own printing (and `--trace-warnings`) is unchanged. Under
 * `--no-warnings` or `NODE_NO_WARNINGS=1` Node installs no printing listener, so nothing is printed then either.
 */
export function hideSqliteNotice(): void {
  const printers = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
    for (const print of printers) print.call(process, w);
  });
}

/** The commands module beside this one: `.ts` when run from source, `.js` when bundled. */
const COMMANDS_URL = new URL(`./commands.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url).href;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (!nodeSupported(process.versions.node)) {
    process.stderr.write(`gws-mcp needs Node.js ${MIN_NODE.join(".")} or newer; this is ${process.versions.node}.\n`);
    return 1;
  }
  hideSqliteNotice();
  const { runCli } = (await import(COMMANDS_URL)) as typeof import("./commands");
  return runCli({ argv, env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
}

function isEntry(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().then(
    (code) => {
      process.exitCode = code;
      // Normally the process ends by itself; this only stops a stray handle from keeping it alive.
      setTimeout(() => process.exit(code), 3000).unref();
    },
    () => {
      process.stderr.write("gws-mcp: unexpected failure\n");
      process.exitCode = 1;
    },
  );
}
