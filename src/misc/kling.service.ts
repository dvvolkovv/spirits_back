import { Injectable, Logger, Optional } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';

@Injectable()
export class KlingService {
  private readonly logger = new Logger(KlingService.name);
  private readonly ak = process.env.KLING_ACCESS_KEY || '';
  private readonly sk = process.env.KLING_SECRET_KEY || '';

  // Direct PG insert (instead of EventsService) — same pattern as
  // ClaudeCliService — KlingService lives in MiscModule which is also
  // imported by VideoModule and would create a cycle if we routed
  // through EventsService. Schema is the same `events` table.
  constructor(@Optional() private readonly pg?: PgService) {}

  private trackCall(method: string, model: string, ok: boolean, latencyMs: number, errorShort?: string, taskId?: string) {
    if (!this.pg) return;
    this.pg.query(
      `INSERT INTO events (name, props) VALUES ('kling_call', $1::jsonb)`,
      [JSON.stringify({ method, model, ok, latency_ms: latencyMs, error_short: errorShort?.slice(0, 200), task_id: taskId })],
    ).catch((e: any) => this.logger.warn(`kling_call event insert failed: ${e.message}`));
  }

  private getToken(): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      { iss: this.ak, exp: now + 1800, nbf: now - 5 },
      this.sk,
      { algorithm: 'HS256', header: { alg: 'HS256', typ: 'JWT' } as any },
    );
  }

  async generateImage(prompt: string, aspectRatio = '1:1'): Promise<{ url: string } | null> {
    const t0 = Date.now();
    const model = 'kling-v1';
    if (!this.ak || !this.sk) {
      this.logger.warn('Kling credentials not set');
      this.trackCall('generateImage', model, false, 0, 'credentials_not_set');
      return null;
    }

    let taskId: string | undefined;
    try {
      // Create task
      const token = this.getToken();
      const createResp = await axios.post(
        'https://api.klingai.com/v1/images/generations',
        { model, prompt, n: 1, aspect_ratio: aspectRatio },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 },
      );

      taskId = createResp.data?.data?.task_id;
      if (!taskId) {
        this.logger.error(`Kling create failed: ${JSON.stringify(createResp.data)}`);
        this.trackCall('generateImage', model, false, Date.now() - t0, `create_failed: ${JSON.stringify(createResp.data).slice(0, 150)}`);
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
            this.trackCall('generateImage', model, true, Date.now() - t0, undefined, taskId);
            return { url: images[0].url };
          }
        } else if (status === 'failed') {
          const msg = pollResp.data?.data?.task_status_msg;
          this.logger.error(`Kling task failed: ${taskId} - ${msg}`);
          this.trackCall('generateImage', model, false, Date.now() - t0, msg || 'task_failed', taskId);
          return null;
        }
        // else: submitted/processing — continue polling
      }

      this.logger.error(`Kling task timeout: ${taskId}`);
      this.trackCall('generateImage', model, false, Date.now() - t0, 'poll_timeout', taskId);
      return null;
    } catch (e) {
      const msg = e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
      this.logger.error(`Kling error: ${msg}`);
      this.trackCall('generateImage', model, false, Date.now() - t0, msg, taskId);
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
    const t0 = Date.now();
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
    try {
      const resp = await axios.post(
        'https://api.klingai.com/v1/videos/text2video',
        body,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true },
      );
      if (resp.status !== 200 || resp.data?.code !== 0) {
        const msg = resp.data?.message || resp.data?.error || `HTTP ${resp.status}`;
        this.trackCall('text2video', params.model, false, Date.now() - t0, msg);
        throw new Error(`Kling text2video: ${msg} (body: ${JSON.stringify(resp.data).slice(0, 200)})`);
      }
      const taskId = resp.data.data.task_id;
      this.trackCall('text2video', params.model, true, Date.now() - t0, undefined, taskId);
      return { taskId };
    } catch (e: any) {
      // If we already tracked above (non-200 path), don't double-track. The
      // condition `e.message.startsWith('Kling text2video:')` is true only
      // for the synthetic Error we threw — network errors flow through here
      // unhandled.
      if (!/^Kling text2video:/.test(e.message)) {
        this.trackCall('text2video', params.model, false, Date.now() - t0, e.message);
      }
      throw e;
    }
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
    const t0 = Date.now();
    const token = this.getToken();
    const body: any = {
      model_name: params.model,
      image: params.imageUrl,
      prompt: params.prompt,
      negative_prompt: params.negativePrompt,
      cfg_scale: params.cfgScale ?? 0.5,
      duration: String(params.duration),
    };
    if (params.model === 'kling-v1-6') body.mode = params.mode;
    if (params.cameraControl) body.camera_control = params.cameraControl;
    try {
      const resp = await axios.post(
        'https://api.klingai.com/v1/videos/image2video',
        body,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true },
      );
      if (resp.status !== 200 || resp.data?.code !== 0) {
        const msg = resp.data?.message || resp.data?.error || `HTTP ${resp.status}`;
        this.trackCall('image2video', params.model, false, Date.now() - t0, msg);
        throw new Error(`Kling image2video: ${msg} (body: ${JSON.stringify(resp.data).slice(0, 200)})`);
      }
      const taskId = resp.data.data.task_id;
      this.trackCall('image2video', params.model, true, Date.now() - t0, undefined, taskId);
      return { taskId };
    } catch (e: any) {
      if (!/^Kling image2video:/.test(e.message)) {
        this.trackCall('image2video', params.model, false, Date.now() - t0, e.message);
      }
      throw e;
    }
  }

  async createVideoExtendTask(params: {
    videoId: string;     // Kling-side video id (NOT our video_jobs.id)
    prompt?: string;
    negativePrompt?: string;
    cfgScale?: number;
  }): Promise<{ taskId: string }> {
    const t0 = Date.now();
    const model = 'kling-extend';
    const token = this.getToken();
    const body: any = {
      video_id: params.videoId,
      prompt: params.prompt,
      negative_prompt: params.negativePrompt,
      cfg_scale: params.cfgScale ?? 0.5,
    };
    try {
      const resp = await axios.post(
        'https://api.klingai.com/v1/videos/video-extend',
        body,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 },
      );
      if (resp.data?.code !== 0) {
        const msg = resp.data?.message || 'unknown error';
        this.trackCall('extend', model, false, Date.now() - t0, msg);
        throw new Error(`Kling video-extend: ${msg}`);
      }
      const taskId = resp.data.data.task_id;
      this.trackCall('extend', model, true, Date.now() - t0, undefined, taskId);
      return { taskId };
    } catch (e: any) {
      if (!/^Kling video-extend:/.test(e.message)) {
        this.trackCall('extend', model, false, Date.now() - t0, e.message);
      }
      throw e;
    }
  }

  async createLipSyncTask(params: {
    videoId: string;
    audioUrl?: string;
    audioType?: 'url' | 'text';
    text?: string;
    voiceId?: string;
  }): Promise<{ taskId: string }> {
    const t0 = Date.now();
    const model = 'kling-lipsync';
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
    try {
      const resp = await axios.post(
        'https://api.klingai.com/v1/videos/lip-sync',
        body,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 },
      );
      if (resp.data?.code !== 0) {
        const msg = resp.data?.message || 'unknown error';
        this.trackCall('lipsync', model, false, Date.now() - t0, msg);
        throw new Error(`Kling lip-sync: ${msg}`);
      }
      const taskId = resp.data.data.task_id;
      this.trackCall('lipsync', model, true, Date.now() - t0, undefined, taskId);
      return { taskId };
    } catch (e: any) {
      if (!/^Kling lip-sync:/.test(e.message)) {
        this.trackCall('lipsync', model, false, Date.now() - t0, e.message);
      }
      throw e;
    }
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
