import type { AuditRow } from "../contracts";
import { GwsError } from "../errors";
import type { AuditSink } from "./ports";

/** Bounds from the remote `audit_log` CHECK constraints: one violating row would fail the whole batch. */
const MAX_FN = 200;
const MAX_REQUEST_ID = 200;

/**
 * Copies exactly the audit columns, field by field. Nothing else on the object (a body, a token) can reach
 * the sink, and bounded text columns are clipped to their CHECK limits.
 */
function auditRow(r: AuditRow): AuditRow {
  return {
    id: r.id,
    ts: r.ts,
    execute_id: r.execute_id,
    user_id: r.user_id,
    client_id: r.client_id,
    account_id: r.account_id,
    fn: r.fn.slice(0, MAX_FN),
    effect: r.effect,
    applied: r.applied,
    status: r.status,
    code: r.code,
    duration_ms: r.duration_ms,
    request_id: r.request_id !== null && r.request_id.length <= MAX_REQUEST_ID ? r.request_id : null,
    upstream_status: r.upstream_status,
  };
}

/** Audit rows of one execute, written to the audit sink in a single batch at the end. Metadata only. */
export class AuditBuffer {
  private buffered: AuditRow[] = [];

  get rows(): readonly AuditRow[] {
    return this.buffered;
  }

  add(row: AuditRow): void {
    this.buffered.push(auditRow(row));
  }

  /**
   * Writes the buffered rows in one transaction and clears them. On failure nothing was written (the batch is
   * atomic), the rows stay buffered and GWS_INTERNAL is thrown, so a lost audit is never silent.
   */
  async flush(sink: AuditSink): Promise<void> {
    const n = this.buffered.length;
    if (n === 0) return;
    try {
      await sink.insertMany(this.buffered.slice(0, n));
    } catch (e) {
      throw new GwsError("GWS_INTERNAL", "writing the audit log failed", { cause: e });
    }
    // Rows added by calls that finished during the write stay for the next flush.
    this.buffered.splice(0, n);
  }
}
