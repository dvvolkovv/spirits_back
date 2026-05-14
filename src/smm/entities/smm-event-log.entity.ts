// src/smm/entities/smm-event-log.entity.ts
export interface SmmEventLog {
  id: string;
  eventType: string;
  videoId: string | null;
  publicationId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

export function rowToEvent(row: any): SmmEventLog {
  return {
    id: row.id,
    eventType: row.event_type,
    videoId: row.video_id ?? null,
    publicationId: row.publication_id ?? null,
    payload: (row.payload as Record<string, unknown>) ?? null,
    createdAt: row.created_at,
  };
}
