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
  // MinIO stores mp4 at a deterministic per-video key (final.mp4), so the same
  // URL is re-used after «Сделать заново». Browsers (and the inline <video>
  // element) cache by URL — the player would keep showing the old clip.
  // Append ?v=<updated_at_unix> so the URL changes on every regeneration.
  let mp4Url: string | null = row.mp4_url ?? null;
  if (mp4Url && row.updated_at) {
    const ts = Math.floor(new Date(row.updated_at).getTime() / 1000);
    mp4Url += (mp4Url.includes('?') ? '&' : '?') + `v=${ts}`;
  }
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    status: row.status,
    renderJobId: row.render_job_id ?? null,
    renderState: (row.render_state as SmmRenderState) ?? {},
    mp4Url,
    durationSec: row.duration_sec ?? null,
    sizeBytes: row.size_bytes ? Number(row.size_bytes) : null,
    errorMessage: row.error_message ?? null,
    tokensCharged: row.tokens_charged,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
