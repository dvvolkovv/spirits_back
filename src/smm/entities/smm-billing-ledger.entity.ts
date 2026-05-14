// src/smm/entities/smm-billing-ledger.entity.ts
export type SmmLedgerOp = 'charge' | 'refund';

export interface SmmBillingLedgerEntry {
  id: string;
  userId: string;
  videoId: string | null;
  amount: number;
  op: SmmLedgerOp;
  reason: string;
  createdAt: Date;
}

export function rowToLedgerEntry(row: any): SmmBillingLedgerEntry {
  return {
    id: row.id,
    userId: row.user_id,
    videoId: row.video_id ?? null,
    amount: row.amount,
    op: row.op,
    reason: row.reason,
    createdAt: row.created_at,
  };
}
