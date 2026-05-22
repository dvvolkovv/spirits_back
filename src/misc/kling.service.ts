import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import axios from 'axios';

@Injectable()
export class KlingService {
  private readonly logger = new Logger(KlingService.name);
  private readonly ak = process.env.KLING_ACCESS_KEY || '';
  private readonly sk = process.env.KLING_SECRET_KEY || '';

  private getToken(): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      { iss: this.ak, exp: now + 1800, nbf: now - 5 },
      this.sk,
      { algorithm: 'HS256', header: { alg: 'HS256', typ: 'JWT' } as any },
    );
  }

  async generateImage(prompt: string, aspectRatio = '1:1'): Promise<{ url: string } | null> {
    if (!this.ak || !this.sk) {
      this.logger.warn('Kling credentials not set');
      return null;
    }

    try {
      // Create task
      const token = this.getToken();
      const createResp = await axios.post(
        'https://api.klingai.com/v1/images/generations',
        { model: 'kling-v1', prompt, n: 1, aspect_ratio: aspectRatio },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 },
      );

      const taskId = createResp.data?.data?.task_id;
      if (!taskId) {
        this.logger.error(`Kling create failed: ${JSON.stringify(createResp.data)}`);
        return null;
      }

      this.logger.log(`Kling task created: ${taskId}`);

      // Poll for result (max 60 seconds, every 3 seconds)
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000));

        const pollToken = this.getToken();
        const pollResp = await axios.get(
          `https://api.klingai.com/v1/images/generations/${taskId}`,
          { headers: { Authorization: `Bearer ${pollToken}` }, timeout: 15000 },
        );

        const status = pollResp.data?.data?.task_status;
        if (status === 'succeed') {
          const images = pollResp.data?.data?.task_result?.images;
          if (images?.length > 0) {
            this.logger.log(`Kling image ready: ${taskId}`);
            return { url: images[0].url };
          }
        } else if (status === 'failed') {
          this.logger.error(`Kling task failed: ${taskId} - ${pollResp.data?.data?.task_status_msg}`);
          return null;
        }
        // else: submitted/processing — continue polling
      }

      this.logger.error(`Kling task timeout: ${taskId}`);
      return null;
    } catch (e) {
      this.logger.error(`Kling error: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
      return null;
    }
  }

  // ================= VIDEO =================

  async createText2VideoTask(params: {
    model: 'kling-v1-6' | 'kling-v2-master';
    prompt: string;
    negativePrompt?: string;
    cfgScale?: number;
    mode: 'std' | 'pro';                   // Kling API calls this "mode" — std | pro
    duration: 5 | 10;
    cameraControl?: { type: string; config?: Record<string, number> };
  }): Promise<{ taskId: string }> {
    const token = this.getToken();
    const body: any = {
      model_name: params.model,
      prompt: params.prompt,
      negative_prompt: params.negativePrompt,
      cfg_scale: params.cfgScale ?? 0.5,
      duration: String(params.duration),
    };
    // kling-v2-master не принимает mode='std' — Kling возвращает 400. Передаём
    // mode только для v1-6.
    if (params.model === 'kling-v1-6') body.mode = params.mode;
    if (params.cameraControl) body.camera_control = params.cameraControl;
    const resp = await axios.post(
      'https://api.klingai.com/v1/videos/text2video',
      body,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true },
    );
    if (resp.status !== 200 || resp.data?.code !== 0) {
      const msg = resp.data?.message || resp.data?.error || `HTTP ${resp.status}`;
      throw new Error(`Kling text2video: ${msg} (body: ${JSON.stringify(resp.data).slice(0, 200)})`);
    }
    return { taskId: resp.data.data.task_id };
  }

  async createImage2VideoTask(params: {
    model: 'kling-v1-6' | 'kling-v2-master';
    imageUrl: string;
    prompt?: string;
    negativePrompt?: string;
    cfgScale?: number;
    mode: 'std' | 'pro';
    duration: 5 | 10;
    cameraControl?: { type: string; config?: Record<string, number> };
  }): Promise<{ taskId: string }> {
    const token = this.getToken();
    const body: any = {
      model_name: params.model,
      image: params.imageUrl,
      prompt: params.prompt,
      negative_prompt: params.negativePrompt,
      cfg_scale: params.cfgScale ?? 0.5,
      duration: String(params.duration),
    };
    // kling-v2-master не принимает mode='std' — Kling возвращает 400.
    if (params.model === 'kling-v1-6') body.mode = params.mode;
    if (params.cameraControl) body.camera_control = params.cameraControl;
    const resp = await axios.post(
      'https://api.klingai.com/v1/videos/image2video',
      body,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true },
    );
    if (resp.status !== 200 || resp.data?.code !== 0) {
      const msg = resp.data?.message || resp.data?.error || `HTTP ${resp.status}`;
      throw new Error(`Kling image2video: ${msg} (body: ${JSON.stringify(resp.data).slice(0, 200)})`);
    }
    return { taskId: resp.data.data.task_id };
  }

  async createVideoExtendTask(params: {
    videoId: string;     // Kling-side video id (NOT our video_jobs.id)
    prompt?: string;
    negativePrompt?: string;
    cfgScale?: number;
  }): Promise<{ taskId: string }> {
    const token = this.getToken();
    const body: any = {
      video_id: params.videoId,
      prompt: params.prompt,
      negative_prompt: params.negativePrompt,
      cfg_scale: params.cfgScale ?? 0.5,
    };
    const resp = await axios.post(
      'https://api.klingai.com/v1/videos/video-extend',
      body,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 },
    );
    if (resp.data?.code !== 0) throw new Error(`Kling video-extend: ${resp.data?.message || 'unknown error'}`);
    return { taskId: resp.data.data.task_id };
  }

  async createLipSyncTask(params: {
    videoId: string;
    audioUrl?: string;
    audioType?: 'url' | 'text';
    text?: string;
    voiceId?: string;
  }): Promise<{ taskId: string }> {
    const token = this.getToken();
    const body: any = {
      input: {
        video_id: params.videoId,
        mode: params.audioType === 'text' ? 'text2video' : 'audio2video',
        ...(params.audioUrl ? { audio_url: params.audioUrl } : {}),
        ...(params.text    ? { text: params.text }          : {}),
        ...(params.voiceId ? { voice_id: params.voiceId }   : {}),
      },
    };
    const resp = await axios.post(
      'https://api.klingai.com/v1/videos/lip-sync',
      body,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 },
    );
    if (resp.data?.code !== 0) throw new Error(`Kling lip-sync: ${resp.data?.message || 'unknown error'}`);
    return { taskId: resp.data.data.task_id };
  }

  async getVideoTaskStatus(
    taskId: string,
    mode: 'text2video' | 'image2video' | 'extend' | 'lipsync',
  ): Promise<{ status: 'submitted' | 'processing' | 'succeed' | 'failed'; videoUrl?: string; videoId?: string; error?: string }> {
    const token = this.getToken();
    const pathByMode: Record<typeof mode, string> = {
      text2video: `/videos/text2video/${taskId}`,
      image2video: `/videos/image2video/${taskId}`,
      extend: `/videos/video-extend/${taskId}`,
      lipsync: `/videos/lip-sync/${taskId}`,
    };
    const resp = await axios.get(
      `https://api.klingai.com/v1${pathByMode[mode]}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 },
    );
    const data = resp.data?.data;
    if (!data) return { status: 'failed', error: 'no data' };
    const status = (data.task_status as string).toLowerCase() as any;
    if (status === 'succeed') {
      const video = data.task_result?.videos?.[0];
      return { status, videoUrl: video?.url, videoId: video?.id };
    }
    if (status === 'failed') {
      return { status, error: data.task_status_msg || 'failed' };
    }
    return { status };
  }
}
