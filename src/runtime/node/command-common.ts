/** Pieces the Node host's operator commands (access, backup, restore) share. */

/** Exit codes (BSD sysexits) a shell script can branch on. */
export const EXIT = { ok: 0, refused: 1, usage: 64, software: 70, tempfail: 75, config: 78 } as const;

export interface CommandIo {
  out(line: string): void;
  err(line: string): void;
}

/** True for SQLite's "busy" and "locked" (another connection holds the write lock past the busy timeout). */
export function isBusy(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur instanceof Error && depth < 5; cur = cur.cause, depth++) {
    const errcode = (cur as { errcode?: unknown }).errcode;
    if (errcode === 5 || errcode === 6 || /database is (locked|busy)/i.test(cur.message)) return true;
  }
  return false;
}
