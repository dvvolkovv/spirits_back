import { Injectable, Logger, Optional } from '@nestjs/common';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';

/**
 * Veo 3.1 (Google Gemini Developer API) video provider — DR backlog a0132032.
 *
 * Long-form talking-head with native lip-synced audio and reference-portrait
 * consistency, in one continuous video (no ffmpeg concat like Kling).
 *
 * API mechanics, all validated against the live API 2026-06-03:
 *  - generate: POST models/{model}:predictLongRunning, x-goog-api-key header,
 *    body { instances:[{ prompt, image?{inlineData}, referenceImages? }],
 *           parameters:{ aspectRatio, durationSeconds:<NUMBER>, resolution } }
 *    → { name } (operation).  durationSeconds MUST be a number (8), not "8".
 *  - poll: GET v1beta/{operation.name} → { done, response.generateVideoResponse
 *    .generatedSamples[0].video.uri, error }.
 *  - extend: same endpoint, body { instances:[{ prompt, video:{ uri:<prior
 *    download uri> } }], parameters:{ resolution:"720p" } }. The ONLY accepted
 *    video reference is `video.uri` (inlineData / fileData / fileUri are all
 *    rejected). Output is the FULL combined video (base + 7s), so chaining
 *    extends yields one continuous clip — the last operation's uri is the
 *    finished video. Files live 2 days (reset when referenced).
 *  - download: GET <uri> with x-goog-api-key header → mp4 bytes.
 *
 * Reuses GOOGLE_AI_API_KEY (already used for Nano Banana image gen).
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export type VeoTier = 'fast' | 'standard';
const MODEL_ID: Record<VeoTier, string> = {
  fast: 'veo-3.1-fast-generate-preview',
  standard: 'veo-3.1-generate-preview',
};

export interface VeoOperationStatus {
  done: boolean;
  videoUri: string | null;
  error: string | null;
}

@Injectable()
export class VeoService {
  private readonly logger = new Logger(VeoService.name);
  private readonly apiKey = process.env.GOOGLE_AI_API_KEY || '';

  constructor(@Optional() private readonly pg?: PgService) {}

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  private headers() {
    return { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' };
  }

  // Map upstream errors to a job error_message. A 429/quota is an operational
  // ceiling (Veo daily RPD on the key), not a user error — surface it plainly
  // so the assistant/UI can say "try later" instead of a raw billing message.
  private describeError(e: any, label: 'generate' | 'extend'): string {
    const status = e.response?.status;
    const raw = e.response?.data?.error?.message || e.message || 'unknown error';
    if (status === 429 || /RESOURCE_EXHAUSTED|exceeded your current quota/i.test(raw)) {
      return 'Veo: достигнут дневной лимит генераций видео — попробуйте позже (или администратору: повысить квоту Veo для ключа).';
    }
    return `Veo ${label} failed: ${raw}`;
  }

  private trackCall(method: string, tier: VeoTier, ok: boolean, latencyMs: number, errorShort?: string, op?: string) {
    if (!this.pg) return;
    this.pg.query(
      `INSERT INTO events (name, props) VALUES ('veo_call', $1::jsonb)`,
      [JSON.stringify({ method, model: MODEL_ID[tier], ok, latency_ms: latencyMs, error_short: errorShort?.slice(0, 200), operation: op })],
    ).catch((e: any) => this.logger.warn(`veo_call event insert failed: ${e.message}`));
  }

  /**
   * Start a base generation. Returns the long-running operation name.
   * `image` (a portrait) is the talking-head subject; `referenceImages` keep
   * a consistent character across the chain (Veo "Ingredients").
   */
  async startGenerate(opts: {
    prompt: string;
    tier: VeoTier;
    durationSeconds?: number;      // 4 | 6 | 8 (base); default 8
    aspectRatio?: '16:9' | '9:16';
    resolution?: '720p' | '1080p';
    imageB64?: string;
    imageMime?: string;
    negativePrompt?: string;
  }): Promise<string> {
    if (!this.apiKey) throw new Error('GOOGLE_AI_API_KEY not configured');
    const t0 = Date.now();
    const instance: any = { prompt: opts.prompt };
    if (opts.imageB64) {
      // Veo image input is Imagen-style bytesBase64Encoded — NOT inlineData/uri
      // (both rejected by the model). Validated against the live API.
      instance.image = { bytesBase64Encoded: opts.imageB64, mimeType: opts.imageMime || 'image/jpeg' };
    }
    const parameters: any = {
      aspectRatio: opts.aspectRatio || '16:9',
      durationSeconds: opts.durationSeconds || 8,   // number, not string
      resolution: opts.resolution || '720p',
    };
    if (opts.negativePrompt) parameters.negativePrompt = opts.negativePrompt;

    try {
      const resp = await axios.post(
        `${API_BASE}/models/${MODEL_ID[opts.tier]}:predictLongRunning`,
        { instances: [instance], parameters },
        { headers: this.headers(), timeout: 30_000 },
      );
      const name = resp.data?.name;
      if (!name) throw new Error(`no operation name: ${JSON.stringify(resp.data).slice(0, 200)}`);
      this.trackCall('generate', opts.tier, true, Date.now() - t0, undefined, name);
      return name;
    } catch (e: any) {
      const msg = this.describeError(e, 'generate');
      this.trackCall('generate', opts.tier, false, Date.now() - t0, msg);
      throw new Error(msg);
    }
  }

  /**
   * Extend a prior generation (referenced by its download uri). Output is the
   * full combined video. 720p only per the API.
   */
  async startExtend(opts: { prompt: string; tier: VeoTier; videoUri: string }): Promise<string> {
    if (!this.apiKey) throw new Error('GOOGLE_AI_API_KEY not configured');
    const t0 = Date.now();
    try {
      const resp = await axios.post(
        `${API_BASE}/models/${MODEL_ID[opts.tier]}:predictLongRunning`,
        {
          instances: [{ prompt: opts.prompt, video: { uri: opts.videoUri } }],
          parameters: { resolution: '720p' },
        },
        { headers: this.headers(), timeout: 30_000 },
      );
      const name = resp.data?.name;
      if (!name) throw new Error(`no operation name: ${JSON.stringify(resp.data).slice(0, 200)}`);
      this.trackCall('extend', opts.tier, true, Date.now() - t0, undefined, name);
      return name;
    } catch (e: any) {
      const msg = this.describeError(e, 'extend');
      this.trackCall('extend', opts.tier, false, Date.now() - t0, msg);
      throw new Error(msg);
    }
  }

  /** Poll a long-running operation. */
  async getOperation(operationName: string): Promise<VeoOperationStatus> {
    if (!this.apiKey) throw new Error('GOOGLE_AI_API_KEY not configured');
    const resp = await axios.get(`${API_BASE}/${operationName}`, { headers: this.headers(), timeout: 20_000 });
    const d = resp.data || {};
    if (!d.done) return { done: false, videoUri: null, error: null };
    if (d.error) {
      return { done: true, videoUri: null, error: d.error?.message || JSON.stringify(d.error).slice(0, 200) };
    }
    const gvr = d.response?.generateVideoResponse;
    const uri = gvr?.generatedSamples?.[0]?.video?.uri ?? null;
    if (!uri) {
      // Veo can finish "done" with zero samples when its safety/content filter
      // (RAI) rejects the generation — surface that reason so the assistant can
      // tell the user to rephrase, instead of an opaque "no video uri".
      const rai = Array.isArray(gvr?.raiMediaFilteredReasons) && gvr.raiMediaFilteredReasons.length
        ? String(gvr.raiMediaFilteredReasons.join(' ')).slice(0, 400)
        : null;
      return { done: true, videoUri: null, error: rai ? `Veo отклонил генерацию (фильтр контента): ${rai}` : 'operation done but no video uri' };
    }
    return { done: true, videoUri: uri, error: null };
  }

  /**
   * Processing state of a generated-video file (ACTIVE / PROCESSING / FAILED).
   * A just-finished generation isn't immediately extendable — Veo rejects the
   * extend with "Input video must be a video that was generated by VEO that has
   * been processed" until the file reaches ACTIVE. Derive files/XXX from the
   * download uri and query the Files API.
   */
  async getFileState(videoUri: string): Promise<string | null> {
    if (!this.apiKey) return null;
    const m = videoUri.match(/\/(files\/[^:?]+)/);
    if (!m) return null;
    try {
      const resp = await axios.get(`${API_BASE}/${m[1]}`, { headers: { 'x-goog-api-key': this.apiKey }, timeout: 15_000 });
      return resp.data?.state ?? null;
    } catch (e: any) {
      this.logger.warn(`veo getFileState failed: ${e.message}`);
      return null;
    }
  }

  /** Download the finished mp4 bytes (key required in the header). */
  async downloadVideo(uri: string): Promise<Buffer> {
    if (!this.apiKey) throw new Error('GOOGLE_AI_API_KEY not configured');
    const resp = await axios.get(uri, {
      headers: { 'x-goog-api-key': this.apiKey },
      responseType: 'arraybuffer',
      timeout: 120_000,
      maxContentLength: 200 * 1024 * 1024,
    });
    return Buffer.from(resp.data);
  }
}
