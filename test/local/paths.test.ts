import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isGwsError } from "../../src/errors";
import { CONFIG_DIR_ENV, configDir, describePathCheck, ensurePrivateDir, ensurePrivateFile } from "../../src/local/paths";
import { tempDir } from "./helpers";

const posixOnly = process.platform === "win32" ? it.skip : it;
const mode = (p: string) => statSync(p).mode & 0o777;

/** Every temp dir a test made, removed after it (a test may make several). */
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function scratch() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

describe("the config directory location", () => {
  it("follows each platform's convention", () => {
    expect(configDir({}, "linux", "/home/ann")).toBe("/home/ann/.config/gws-mcp");
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/ann")).toBe("/xdg/gws-mcp");
    // The XDG spec says relative values are ignored.
    expect(configDir({ XDG_CONFIG_HOME: "rel/xdg" }, "linux", "/home/ann")).toBe("/home/ann/.config/gws-mcp");
    expect(configDir({}, "darwin", "/Users/ann")).toBe("/Users/ann/Library/Application Support/gws-mcp");
    expect(configDir({ APPDATA: "C:\\Users\\ann\\AppData\\Roaming" }, "win32", "C:\\Users\\ann")).toBe("C:\\Users\\ann\\AppData\\Roaming\\gws-mcp");
    expect(configDir({}, "win32", "C:\\Users\\ann")).toBe("C:\\Users\\ann\\AppData\\Roaming\\gws-mcp");
  });

  it("takes an absolute override and refuses a relative one", () => {
    expect(configDir({ [CONFIG_DIR_ENV]: "/srv/gws" }, "linux", "/home/ann")).toBe("/srv/gws");
    expect(() => configDir({ [CONFIG_DIR_ENV]: "gws" }, "linux", "/home/ann")).toThrow(`${CONFIG_DIR_ENV} must be an absolute path`);
  });
});

describe("private paths", () => {
  posixOnly("creates the directory with mode 700 and a file with mode 600, and says so", () => {
    const dir = scratch();
    const d = ensurePrivateDir(dir);
    expect(d).toMatchObject({ action: "created", kind: "dir", modesChecked: true });
    expect(mode(dir)).toBe(0o700);
    const file = path.join(dir, "f");
    const f = ensurePrivateFile(file, { create: true });
    expect(f).toMatchObject({ action: "created", kind: "file" });
    expect(mode(file)).toBe(0o600);
    expect(describePathCheck(d)).toBe(`directory ${dir}: created with mode 0700`);
    expect(ensurePrivateDir(dir).action).toBe("ok");
    expect(ensurePrivateFile(path.join(dir, "missing"), { create: false })).toBeUndefined();
  });

  posixOnly("repairs a directory or file of ours with a looser mode, and reports the old mode", () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const d = ensurePrivateDir(dir);
    expect(d).toMatchObject({ action: "repaired", previousMode: 0o755 });
    expect(mode(dir)).toBe(0o700);
    expect(describePathCheck(d)).toBe(`directory ${dir}: mode was 0755, repaired to 0700`);
    const file = path.join(dir, "f");
    writeFileSync(file, "x", { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(ensurePrivateFile(file, { create: false })).toMatchObject({ action: "repaired", previousMode: 0o644 });
    expect(mode(file)).toBe(0o600);
  });

  posixOnly("refuses a symlink and a path of the wrong kind", () => {
    const dir = scratch();
    ensurePrivateDir(dir);
    const target = path.join(dir, "target");
    writeFileSync(target, "x", { mode: 0o600 });
    const link = path.join(dir, "link");
    symlinkSync(target, link);
    const refusal = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return isGwsError(e) ? e.message : String(e);
      }
      return "not refused";
    };
    expect(refusal(() => ensurePrivateFile(link, { create: true }))).toBe(`refusing to use ${link}: it is a symbolic link`);
    expect(refusal(() => ensurePrivateDir(link))).toBe(`refusing to use ${link}: it is a symbolic link`);
    expect(refusal(() => ensurePrivateDir(target))).toBe(`refusing to use ${target}: it is not a directory`);
    expect(refusal(() => ensurePrivateFile(dir, { create: false }))).toBe(`refusing to use ${dir}: it is not a regular file`);
  });
});
