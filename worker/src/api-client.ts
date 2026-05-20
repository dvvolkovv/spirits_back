// worker/src/api-client.ts
import axios, { AxiosInstance } from 'axios';
import { config } from './config';
import { logger } from './logger';

export interface SmmDialogTurn {
  speaker: 'hero' | 'assistant';
  text: string;
  tStart: number;
  tEnd: number;
}

export interface SmmBrollPrompt {
  atSec: number;
  type: 'ai_image' | 'stock_video';
  prompt: string;
}

export interface SmmRenderContext {
  video: {
    id: string;
    scenarioId: string;
    status: string;
    renderState: Record<string, unknown>;
    tokensCharged: number;
  };
  scenario: {
    id: string;
    campaignId: string;
    title: string;
    assistantRole: string;
    dialog: SmmDialogTurn[];
    mood: 'dramatic' | 'inspiring' | 'calm' | 'uplifting' | 'tense' | 'neutral';
    brollPrompts: SmmBrollPrompt[];
    musicTrackId: string | null;
    ttsTier: 'economy' | 'premium';
    ttsVoiceId: string | null;
  };
  campaign: {
    isLinkeonOfficial: boolean;
    ctaHandle?: string;
    ctaLabel?: string;
  };
}

export interface RenderCallbackInput {
  videoId: string;
  status: 'ready' | 'failed';
  mp4Url?: string;
  durationSec?: number;
  sizeBytes?: number;
  errorMessage?: string;
}

export interface SmmPublicationContext {
  publication: {
    id: string;
    videoId: string;
    platform: 'telegram' | 'vk' | 'youtube' | 'tiktok' | 'instagram';
    scheduledAt: string | null;
    status: string;
    caption: string | null;
  };
  video: {
    id: string;
    mp4Url: string | null;
    durationSec: number | null;
  };
  account: {
    id: string;
    platform: string;
    displayName: string;
    credentials: Record<string, unknown>;
  };
}

export interface PublicationCallbackInput {
  publicationId: string;
  status: 'published' | 'failed';
  externalUrl?: string;
  externalPostId?: string;
  errorMessage?: string;
}

export class ApiClient {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: config.apiUrl,
      headers: { 'X-Smm-Worker-Secret': config.workerSecret },
      timeout: 20000,
      validateStatus: () => true,
    });
  }

  async getRenderContext(videoId: string): Promise<SmmRenderContext> {
    const r = await this.http.get(`/webhook/smm/internal/render-context/${videoId}`);
    if (r.status !== 200) {
      throw new Error(`getRenderContext ${videoId}: ${r.status} ${JSON.stringify(r.data)}`);
    }
    return r.data;
  }

  async updateRenderState(videoId: string, renderState: Record<string, unknown>): Promise<void> {
    const r = await this.http.post('/webhook/smm/internal/render-state', { videoId, renderState });
    if (r.status >= 300) {
      throw new Error(`updateRenderState ${videoId}: ${r.status} ${JSON.stringify(r.data)}`);
    }
    logger.debug({ videoId, renderState }, 'render-state persisted');
  }

  async sendCallback(input: RenderCallbackInput): Promise<void> {
    const r = await this.http.post('/webhook/smm/internal/render-callback', input);
    if (r.status >= 300) {
      throw new Error(`sendCallback ${input.videoId}: ${r.status} ${JSON.stringify(r.data)}`);
    }
    logger.info({ videoId: input.videoId, status: input.status }, 'callback delivered');
  }

  async getPublicationContext(publicationId: string): Promise<SmmPublicationContext> {
    const r = await this.http.get(`/webhook/smm/internal/publication-context/${publicationId}`);
    if (r.status !== 200) throw new Error(`getPublicationContext ${publicationId}: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }

  async sendPublicationCallback(input: PublicationCallbackInput): Promise<void> {
    const r = await this.http.post(`/webhook/smm/internal/publication-callback`, input);
    if (r.status >= 300) {
      throw new Error(`sendPublicationCallback ${input.publicationId}: ${r.status} ${JSON.stringify(r.data)}`);
    }
  }

  async listMusicTracks(): Promise<Array<{
    id: string;
    title: string;
    mood: 'dramatic' | 'inspiring' | 'calm' | 'uplifting' | 'tense' | 'neutral';
    durationSec: number;
    publicUrl: string;
  }>> {
    const r = await this.http.get('/webhook/smm/internal/music-tracks');
    if (r.status !== 200) {
      throw new Error(`listMusicTracks: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    }
    return r.data;
  }
}

export const apiClient = new ApiClient();
