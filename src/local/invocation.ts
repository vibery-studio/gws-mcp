import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The command name the package's `bin` installs. */
const BIN_NAME = "gws-mcp";
/** The npm package this CLI is published as. The unscoped `gws-mcp` on npm is an unrelated project. */
export const PACKAGE_NAME = "@bnqtoan/gws-mcp";
/** How to run the published package through npx. */
export const NPX_COMMAND = `npx -y ${PACKAGE_NAME}`;

/** Quotes one argument for a shell, only when it needs it (POSIX single quotes; Windows double quotes). */
export function shellQuote(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return /^[A-Za-z0-9_\\/.,:@%+=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
  return /^[A-Za-z0-9_/.,:@%+=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function realpathOr(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

/** A `node_modules/.bin` folder: npx and `npm run` put one on PATH for that run only. */
const RUN_ONLY_BIN = /[\\/]node_modules[\\/]\.bin[\\/]?$/;

/** Whether `name` on PATH resolves to `target`, ignoring the folders a package runner adds for one run. */
function onPath(name: string, target: string, pathEnv: string): boolean {
  return pathEnv
    .split(path.delimiter)
    .filter((dir) => dir !== "" && !RUN_ONLY_BIN.test(dir))
    .some((dir) => realpathOr(path.join(dir, name)) === target);
}

/**
 * Whether `cli` (a real path) is this package's CLI inside npx's install cache, that is
 * `<npm cache>/_npx/<hash>/node_modules/@bnqtoan/gws-mcp/dist/cli.js` with that folder's package.json naming the
 * package. That copy is temporary (npm may clear its cache), so it is never printed as a path.
 */
function runFromNpx(cli: string): boolean {
  const [scope, name] = PACKAGE_NAME.split("/");
  const tail = cli.split(/[\\/]/).slice(-7);
  if (tail.length !== 7) return false;
  const [npx, hash, modules, pkgScope, pkgName, dist, file] = tail;
  if (npx !== "_npx" || !hash || modules !== "node_modules" || pkgScope !== scope || pkgName !== name || dist !== "dist" || file !== "cli.js") {
    return false;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(cli)), "package.json"), "utf8")) as { name?: unknown };
    return manifest.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

export interface SelfCommandOptions {
  /** The CLI entry this process runs; the `cli` module beside this one by default. */
  cliPath?: string;
  /** PATH to resolve `gws-mcp` and `node` on. */
  pathEnv?: string;
  execPath?: string;
  platform?: NodeJS.Platform;
}

/**
 * How to run this very copy of the CLI again, for every hint the CLI prints (help, setup, `Run: …` lines, the
 * Claude Code snippet, the `accounts.connect` command). `gws-mcp` only when that name on PATH resolves to this copy;
 * `npx -y @bnqtoan/gws-mcp` when this copy is that package run through npx; otherwise `node <real path of the CLI>`,
 * with `node` replaced by this Node's absolute path when PATH's `node` is another one. It never prints the unscoped
 * `npx gws-mcp`: that fetches whatever the registry holds under that name, which is not this project.
 */
export function selfCommand(o: SelfCommandOptions = {}): string {
  const platform = o.platform ?? process.platform;
  const cliPath = o.cliPath ?? fileURLToPath(new URL(`./cli.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));
  const pathEnv = o.pathEnv ?? process.env.PATH ?? "";
  const execPath = o.execPath ?? process.execPath;
  const cli = realpathOr(cliPath) ?? path.resolve(cliPath);
  if (platform !== "win32" && onPath(BIN_NAME, cli, pathEnv)) return BIN_NAME;
  if (runFromNpx(cli)) return NPX_COMMAND;
  const nodeReal = realpathOr(execPath) ?? execPath;
  const node = platform !== "win32" && onPath("node", nodeReal, pathEnv) ? "node" : shellQuote(execPath, platform);
  return `${node} ${shellQuote(cli, platform)}`;
}
