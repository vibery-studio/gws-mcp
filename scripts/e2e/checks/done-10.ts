// Done 10: regenerating from the pinned Discovery docs reproduces the committed SDK byte for byte; the
// unsupported-methods report exists; /version shows the same SDK hash (and fake upstream mode).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CheckResult, E2eContext, Recorder } from "../run";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const UNSUPPORTED = path.join(ROOT, "src", "sdk", "generated", "UNSUPPORTED.md");

/** Runs `gen:check` locally: its exit code and the byte-identical SDK hash it printed, if any. */
export async function genCheck(): Promise<{ exitCode: number; hash?: string }> {
  let stdout = "";
  let exitCode = 0;
  try {
    ({ stdout } = await promisify(execFile)("npx", ["tsx", "scripts/gen-sdk.ts", "--check"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }));
  } catch (e) {
    exitCode = typeof (e as { code?: unknown }).code === "number" ? ((e as { code: number }).code) : 1;
    stdout = String((e as { stdout?: unknown }).stdout ?? "");
  }
  const hash = /sdk: byte-identical (sha256:[0-9a-f]{64})/.exec(stdout)?.[1];
  return { exitCode, ...(hash ? { hash } : {}) };
}

export default async function done10(ctx: E2eContext, r: Recorder): Promise<CheckResult> {
  const { exitCode, hash: local } = await genCheck();
  r.check(exitCode === 0 && local !== undefined, `npm run gen:check -> exit ${exitCode}, byte-identical ${local ?? "(no hash)"}`);

  const res = await fetch(new URL("/version", ctx.base));
  const version = (await res.json()) as { sdkHash?: string; upstream?: string };
  r.check(res.status === 200 && version.sdkHash === local, `GET /version sdkHash=${version.sdkHash ?? "-"} ${version.sdkHash === local ? "==" : "!="} local`);
  r.check(version.upstream === "fake", `GET /version upstream=${version.upstream ?? "-"}`);
  r.check(existsSync(UNSUPPORTED), `${path.relative(ROOT, UNSUPPORTED)} exists`);
  return r.done();
}
