export const SLA_SOON_MS = 30 * 60_000;

const DURATIONS = {
  critical: 15 * 60_000,
  high: 60 * 60_000,
  normal: 4 * 60 * 60_000,
  low: 24 * 60 * 60_000,
};

export function firstResponseDueAt(urgency: string | null, escalationMs: number): number {
  return escalationMs + (DURATIONS[urgency || 'normal'] ?? DURATIONS.normal);
}

export type SlaFilter = 'overdue' | 'soon' | 'unassigned' | 'mine';

export function slaFilterSql(filter: SlaFilter | undefined, actorId: string): { sql: string; params: any[] } {
  if (filter === 'overdue') {
    return { sql: "status <> 'resolved' AND first_owner_reply_at IS NULL AND first_response_due_at < now()", params: [] };
  }
  if (filter === 'soon') {
    return {
      sql: "status <> 'resolved' AND first_owner_reply_at IS NULL AND first_response_due_at >= now() AND first_response_due_at <= now() + interval '30 minutes'",
      params: [],
    };
  }
  if (filter === 'unassigned') return { sql: 'assigned_to IS NULL', params: [] };
  if (filter === 'mine') return { sql: 'assigned_to = $SLA_ACTOR$', params: [actorId] };
  return { sql: 'TRUE', params: [] };
}
