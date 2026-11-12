import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";

/**
 * A D1-compatible database over one `node:sqlite` connection: `prepare().bind().first|all|run|raw()`, `batch()`
 * (one write transaction) and `exec()`. Results carry the `meta` fields D1 returns; the store reads `meta.changes`.
 *
 * Every call runs synchronously inside the returned promise, so statements of this process never interleave and a
 * batch is atomic. Against another process on the same file (an operator command), a batch takes the write lock up
 * front (`BEGIN IMMEDIATE`) and waits up to the connection's busy timeout for it. `changes()` in SQL keeps its
 * SQLite meaning (the last INSERT/UPDATE/DELETE on this connection), which is what D1 gives inside a batch:
 * src/store/access.ts relies on it.
 */

type Row = Record<string, SQLOutputValue>;

interface D1Meta {
  duration: number;
  size_after: number;
  rows_read: number;
  rows_written: number;
  last_row_id: number;
  changed_db: boolean;
  changes: number;
}

interface D1ResultLike<T> {
  success: true;
  results: T[];
  meta: D1Meta;
}

/** D1 binds these; it refuses `undefined` and plain objects. Booleans become 0/1, as on D1. */
function toSqlValue(v: unknown): SQLInputValue {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError(`D1_TYPE_ERROR: Type '${typeof v}' not supported for value '${String(v)}'`);
}

export class NodeD1Statement {
  constructor(
    private readonly db: NodeD1Database,
    readonly sql: string,
    private readonly params: readonly SQLInputValue[] = [],
  ) {}

  /** True when this statement was prepared on `db` (a batch runs on one connection only). */
  belongsTo(db: NodeD1Database): boolean {
    return this.db === db;
  }

  bind(...values: unknown[]): NodeD1Statement {
    return new NodeD1Statement(this.db, this.sql, values.map(toSqlValue));
  }

  /** Runs the statement now; the result shape of D1's `all()`/`run()`, with `meta.changes` of this statement only. */
  execSync<T = Row>(): D1ResultLike<T> {
    return this.db.runStatement<T>(this.sql, this.params);
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const found = this.db.prepared(this.sql).get(...this.params) as Row | undefined;
    if (found === undefined) return null;
    const row = { ...found };
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column] as T;
  }

  async all<T = Row>(): Promise<D1ResultLike<T>> {
    return this.execSync<T>();
  }

  async run<T = Row>(): Promise<D1ResultLike<T>> {
    return this.execSync<T>();
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.db.prepared(this.sql);
    // Added in a later Node 22 release than the package's floor; the app itself never calls raw().
    if (typeof stmt.setReturnArrays !== "function") throw new Error("D1 raw() needs a newer Node 22 (StatementSync.setReturnArrays)");
    stmt.setReturnArrays(true);
    try {
      const rows = stmt.all(...this.params) as unknown as T[];
      if (options?.columnNames) return [stmt.columns().map((c) => c.name) as unknown as T, ...rows];
      return rows;
    } finally {
      stmt.setReturnArrays(false);
    }
  }
}

/** Prepared statements kept per connection. The app's SQL texts are fixed; the bound only guards against growth. */
const MAX_CACHED_STATEMENTS = 256;

export class NodeD1Database {
  private readonly cache = new Map<string, StatementSync>();
  private readonly totalChanges: StatementSync;
  private readonly lastChange: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.totalChanges = db.prepare("SELECT total_changes() AS t");
    this.lastChange = db.prepare("SELECT changes() AS c, last_insert_rowid() AS id");
  }

  /** One prepared statement per SQL text, reused (node:sqlite statements are re-bound on every call). */
  prepared(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (s === undefined) {
      s = this.db.prepare(sql);
      if (this.cache.size >= MAX_CACHED_STATEMENTS) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }

  /**
   * Runs one statement and reports what D1 would: its rows and `meta.changes`. A statement that wrote nothing
   * leaves `total_changes()` unchanged, so its `changes` is 0 (a SELECT never reports the previous write's count).
   */
  runStatement<T>(sql: string, params: readonly SQLInputValue[]): D1ResultLike<T> {
    const started = performance.now();
    const before = (this.totalChanges.get() as { t: number }).t;
    // node:sqlite rows have a null prototype; D1 rows are plain objects.
    const results = (this.prepared(sql).all(...params) as Row[]).map((r) => ({ ...r })) as T[];
    const after = (this.totalChanges.get() as { t: number }).t;
    const last = this.lastChange.get() as { c: number; id: number };
    const changes = after === before ? 0 : Number(last.c);
    return {
      success: true,
      results,
      meta: {
        duration: performance.now() - started,
        size_after: 0,
        rows_read: results.length,
        rows_written: changes,
        last_row_id: Number(last.id),
        changed_db: changes > 0,
        changes,
      },
    };
  }

  prepare(sql: string): NodeD1Statement {
    return new NodeD1Statement(this, sql);
  }

  /**
   * All statements in one write transaction: every one commits, or none does, and no other connection sees a
   * partial batch. The results are in statement order, as D1 returns them.
   */
  async batch<T = Row>(statements: readonly unknown[]): Promise<D1ResultLike<T>[]> {
    for (const s of statements) {
      if (!(s instanceof NodeD1Statement) || !s.belongsTo(this)) throw new TypeError("batch takes statements prepared on this database only");
    }
    if (statements.length === 0) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = (statements as NodeD1Statement[]).map((s) => s.execSync<T>());
      this.db.exec("COMMIT");
      return results;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The failing statement may already have ended the transaction; its error is the one to report.
      }
      throw e;
    }
  }

  /** D1's `exec`: several statements separated by semicolons, no bindings. */
  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    this.db.exec(sql);
    return { count: sql.split(";").filter((s) => s.trim() !== "").length, duration: performance.now() - started };
  }

  withSession(): never {
    throw new Error("D1 sessions (read replication) are not available on the Node host");
  }

  dump(): never {
    throw new Error("D1 dump is not available on the Node host; back up the SQLite file instead");
  }
}

/** The D1 binding over `db`, typed as the Worker's `D1Database` for the env (the parts the app uses are exact). */
export function nodeD1(db: DatabaseSync): D1Database {
  return new NodeD1Database(db) as unknown as D1Database;
}
