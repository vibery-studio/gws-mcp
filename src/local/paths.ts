import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GwsError } from "../errors";

/** Name of the per-user directory that holds the local database and, as a fallback only, the key file. */
export const APP_DIR_NAME = "gws-mcp";
/** Overrides the config directory (an absolute path): isolated test and E2E runs, or a non-standard layout. */
export const CONFIG_DIR_ENV = "GWS_MCP_CONFIG_DIR";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * The per-user config directory: `$GWS_MCP_CONFIG_DIR` when set; else `%APPDATA%\gws-mcp` on Windows,
 * `~/Library/Application Support/gws-mcp` on macOS and `$XDG_CONFIG_HOME/gws-mcp` (default `~/.config/gws-mcp`)
 * elsewhere. Relative values are refused (the override) or ignored (XDG, as its spec requires).
 */
export function configDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const override = env[CONFIG_DIR_ENV];
  if (override !== undefined && override !== "") {
    if (!pathApi.isAbsolute(override)) throw new GwsError("GWS_INTERNAL", `${CONFIG_DIR_ENV} must be an absolute path`);
    return pathApi.normalize(override);
  }
  if (platform === "win32") {
    const appData = env.APPDATA;
    return pathApi.join(appData && pathApi.isAbsolute(appData) ? appData : pathApi.join(home, "AppData", "Roaming"), APP_DIR_NAME);
  }
  if (platform === "darwin") return pathApi.join(home, "Library", "Application Support", APP_DIR_NAME);
  const xdg = env.XDG_CONFIG_HOME;
  return pathApi.join(xdg && pathApi.isAbsolute(xdg) ? xdg : pathApi.join(home, ".config"), APP_DIR_NAME);
}

/**
 * What opening a private path found. `created`: it did not exist and was created with the private mode.
 * `ok`: it had exactly the private mode. `repaired`: it is ours but had another mode (`previousMode`), now fixed.
 * Anything else is refused with GWS_INTERNAL. Modes are not checked on Windows (`modesChecked: false`): there the
 * per-user profile's ACL protects `%APPDATA%`.
 */
export interface PathCheck {
  path: string;
  kind: "dir" | "file";
  action: "created" | "ok" | "repaired";
  previousMode?: number;
  modesChecked: boolean;
}

const modesApply = () => process.platform !== "win32";

function refuse(p: string, reason: string): never {
  throw new GwsError("GWS_INTERNAL", `refusing to use ${p}: ${reason}`, { details: { path: p, reason } });
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

/** Checks an existing path we expect to own, and repairs its mode. Symlinks and foreign owners are refused. */
function checkExisting(p: string, kind: "dir" | "file", st: fs.Stats, mode: number): PathCheck {
  if (st.isSymbolicLink()) refuse(p, "it is a symbolic link");
  if (kind === "dir" ? !st.isDirectory() : !st.isFile()) refuse(p, `it is not a ${kind === "dir" ? "directory" : "regular file"}`);
  if (!modesApply()) return { path: p, kind, action: "ok", modesChecked: false };
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) refuse(p, "it is owned by another user");
  const current = st.mode & 0o777;
  if (current === mode) return { path: p, kind, action: "ok", modesChecked: true };
  fs.chmodSync(p, mode);
  return { path: p, kind, action: "repaired", previousMode: current, modesChecked: true };
}

function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Opens (creating if needed) a directory only the current user can use: mode 700, owned by us, not a symlink. */
export function ensurePrivateDir(dir: string): PathCheck {
  const st = lstatOrUndefined(dir);
  if (st !== undefined) return checkExisting(dir, "dir", st, PRIVATE_DIR_MODE);
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // The umask may have removed bits from the requested mode; set it exactly.
  if (modesApply()) fs.chmodSync(dir, PRIVATE_DIR_MODE);
  const created = checkExisting(dir, "dir", fs.lstatSync(dir), PRIVATE_DIR_MODE);
  return { ...created, action: "created" };
}

/**
 * Checks a private file (mode 600, ours, a regular file, not a symlink), creating it empty and exclusively with
 * mode 600 when `create` is set and it does not exist. Returns undefined for a missing file without `create`.
 */
export function ensurePrivateFile(file: string, opts: { create: boolean }): PathCheck | undefined {
  const st = lstatOrUndefined(file);
  if (st !== undefined) return checkExisting(file, "file", st, PRIVATE_FILE_MODE);
  if (!opts.create) return undefined;
  // O_EXCL never follows or reuses an existing entry; O_NOFOLLOW where the platform has it.
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags, PRIVATE_FILE_MODE);
  try {
    if (modesApply()) fs.fchmodSync(fd, PRIVATE_FILE_MODE);
  } finally {
    fs.closeSync(fd);
  }
  const created = checkExisting(file, "file", fs.lstatSync(file), PRIVATE_FILE_MODE);
  return { ...created, action: "created" };
}

/**
 * Reads a private file without following a symlink and without repairing anything: it must be a regular file of
 * ours with mode exactly 600, checked on the open descriptor it is then read from. Undefined when it does not exist.
 * For files whose content is trusted (a key): one that someone else created or loosened is refused, never adopted.
 */
export function readPrivateFile(file: string): string | undefined {
  let fd: number;
  try {
    // O_NONBLOCK: opening a FIFO (or a device) planted under this name returns at once, and fstat below refuses it.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") refuse(file, "it is a symbolic link");
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) refuse(file, "it is not a regular file");
    if (modesApply()) {
      // Without O_NOFOLLOW (Windows has none) a symlink would have been followed; check the path itself too.
      if (fs.lstatSync(file).isSymbolicLink()) refuse(file, "it is a symbolic link");
      const uid = process.getuid?.();
      if (uid !== undefined && st.uid !== uid) refuse(file, "it is owned by another user");
      if ((st.mode & 0o777) !== PRIVATE_FILE_MODE) refuse(file, `it has mode ${octal(st.mode)}, not ${octal(PRIVATE_FILE_MODE)}`);
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** One line for `doctor`: what was found at a private path and what was done. */
export function describePathCheck(c: PathCheck): string {
  const what = c.kind === "dir" ? "directory" : "file";
  if (!c.modesChecked) return `${what} ${c.path}: present (permissions are not checked on this platform)`;
  const mode = c.kind === "dir" ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE;
  if (c.action === "created") return `${what} ${c.path}: created with mode ${octal(mode)}`;
  if (c.action === "repaired") return `${what} ${c.path}: mode was ${octal(c.previousMode ?? 0)}, repaired to ${octal(mode)}`;
  return `${what} ${c.path}: mode ${octal(mode)}, ok`;
}
