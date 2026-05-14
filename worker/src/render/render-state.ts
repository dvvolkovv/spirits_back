// worker/src/render/render-state.ts
import { apiClient } from '../api-client';

export interface RenderState {
  scenarioLoaded?: boolean;
  voicesSynthesized?: string[];
  imagesGenerated?: string[];
  stockVideosDownloaded?: string[];
  remotionRendered?: boolean;
  postprocessed?: boolean;
  uploadedToMinio?: string;
}

export async function persist(videoId: string, state: RenderState): Promise<void> {
  await apiClient.updateRenderState(videoId, state as unknown as Record<string, unknown>);
}
