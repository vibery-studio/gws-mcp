import type { AuditRow } from "../contracts";
import { APPROVAL_LINK_PURPOSE, APPROVAL_TTL_MS, type ApprovalClaim } from "../core/human-approval";
import { consumeLinkStatements, isLinkUsed } from "../core/links";
import { auditInsert, type StoreEnv } from "./db";

/**
 * Approvals of plans that need a person (`approvals`, migration 0006). The approval page writes them; an `apply: true`
 * execute uses one up (`claim`). Every write that uses an approval link runs in ONE batch with the link's use in
 * `used_links`, so a link decides at most once on every runtime.
 */

/** Approval rows older than this are pruned by the approving batch: twice their usable life. */
const APPROVAL_KEEP_MS = 2 * APPROVAL_TTL_MS;
const APPROVAL_PRUNE_BATCH = 100;

/** The link a decision uses: its `linkKey`, its user, and the audit row of the person's decision. */
export interface ApprovalDecision {
  tokenHash: string;
  userId: string;
  now: number;
  audit: AuditRow;
}

/** What a decision through an approval link did: done, or nothing because the link was used already. */
export type ApprovalDecisionResult = "done" | "used";

export function openApprovals(env: StoreEnv) {
  const db = env.DB;

  /** Runs a batch that starts by using the link; a second use fails it on the link's primary key: "used". */
  async function decide(tokenHash: string, statements: Parameters<typeof db.batch>[0]): Promise<ApprovalDecisionResult> {
    try {
      await db.batch(statements);
    } catch (e) {
      if (await isLinkUsed(db, tokenHash)) return "used";
      throw e;
    }
    return "done";
  }

  return {
    /**
     * Records the person's approval of `planHash` for the link's user and client, in one batch with the link's use,
     * the prune of old approvals and the audit row. A concurrent or later second use of the link writes nothing.
     */
    approve(d: ApprovalDecision & { id: string; planHash: string; clientId: string }): Promise<ApprovalDecisionResult> {
      return decide(d.tokenHash, [
        ...consumeLinkStatements(db, { tokenHash: d.tokenHash, purpose: APPROVAL_LINK_PURPOSE, userId: d.userId, now: d.now }),
        db
          .prepare("DELETE FROM approvals WHERE id IN (SELECT id FROM approvals WHERE approved_at < ? LIMIT ?)")
          .bind(d.now - APPROVAL_KEEP_MS, APPROVAL_PRUNE_BATCH),
        db
          .prepare("INSERT INTO approvals (id, plan_hash, user_id, client_id, approved_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)")
          .bind(d.id, d.planHash, d.userId, d.clientId, d.now),
        auditInsert(db, d.audit),
      ]);
    },

    /** Uses the link without approving anything, with the audit row of the decline, in one batch. */
    decline(d: ApprovalDecision): Promise<ApprovalDecisionResult> {
      return decide(d.tokenHash, [
        ...consumeLinkStatements(db, { tokenHash: d.tokenHash, purpose: APPROVAL_LINK_PURPOSE, userId: d.userId, now: d.now }),
        auditInsert(db, d.audit),
      ]);
    },

    /**
     * Marks one unused approval of this plan hash, user and client, given less than APPROVAL_TTL_MS ago, used, and
     * returns its id (null when none): one conditional UPDATE, so of concurrent claims on one approval exactly one
     * changes the row and gets its id back.
     */
    async claim(q: ApprovalClaim): Promise<string | null> {
      const r = await db
        .prepare(
          `UPDATE approvals SET used_at = ? WHERE used_at IS NULL AND id = (
             SELECT id FROM approvals WHERE plan_hash = ? AND user_id = ? AND client_id = ? AND used_at IS NULL AND approved_at > ?
             ORDER BY approved_at LIMIT 1)
           RETURNING id`,
        )
        .bind(q.now, q.planHash, q.userId, q.clientId, q.now - APPROVAL_TTL_MS)
        .first<{ id: string }>();
      return r?.id ?? null;
    },
  };
}

export type ApprovalsStore = ReturnType<typeof openApprovals>;
