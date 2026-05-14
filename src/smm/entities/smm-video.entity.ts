// src/smm/entities/smm-video.entity.ts
export type SmmVideoStatus =
  | 'queued' | 'rendering' | 'ready' | 'failed' | 'approved' | 'rejected';

export interface SmmRenderState {
  scenarioLoaded?: boolean;
  voicesSynthesized?: string[];
  imagesGenerated?: string[];
  stockVideosDownloaded?: string[];
  remotionRendered?: boolean;
  postprocessed?: boolean;
  uploadedToMinio?: boolean;
}

export interface SmmVideo {
  id: string;
  scenarioId: string;
  status: SmmVideoStatus;
  renderJobId: string | null;
  renderState: SmmRenderState;
  mp4Url: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  errorMessage: string | null;
  tokensCharged: number;
  createdAt: Date;
  updatedAt: Date;
}

export function rowToVideo(row: any): SmmVideo {
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    status: row.status,
    renderJobId: row.render_job_id ?? null,
    renderState: (row.render_state as SmmRenderState) ?? {},
    mp4Url: row.mp4_url ?? null,
    durationSec: row.duration_sec ?? null,
    sizeBytes: row.size_bytes ? Number(row.size_bytes) : null,
    errorMessage: row.error_message ?? null,
    tokensCharged: row.tokens_charged,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
