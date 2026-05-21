// worker/src/render/render-state.ts
import { apiClient } from '../api-client';

export interface PremiumSceneState {
  type: 'kling' | 'imagen';
  keyframe_prompt?: string;
  motion_prompt?: string;
  image_prompt?: string;
  videoUrl?: string;
  keyframeUrl?: string;
  attempts?: number;
  duration?: number;
}

export interface RenderState {
  scenarioLoaded?: boolean;
  voicesSynthesized?: string[];
  /** Actual TTS duration of each voice file in seconds — used to recompute dialog timeline. */
  voiceDurations?: number[];
  imagesGenerated?: string[];
  stockVideosDownloaded?: string[];
  remotionRendered?: boolean;
  postprocessed?: boolean;
  uploadedToMinio?: string;
  /** Premium-mode: result of processPremiumScenes — kling videoUrls in place. */
  premiumScenesProcessed?: boolean;
  premiumScenes?: PremiumSceneState[];
}

export async function persist(videoId: string, state: RenderState): Promise<void> {
  await apiClient.updateRenderState(videoId, state as unknown as Record<string, unknown>);
}
