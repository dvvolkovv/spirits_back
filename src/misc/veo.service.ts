import { Injectable, Logger, Optional } from '@nestjs/common';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';

/**
 * Видео-провайдер — Gemini Omni Flash (`gemini-omni-1.1-flash`) через
 * Interactions API Gemini Developer API.
 *
 * До 22.10.2026 здесь был Veo 3.1 (predictLongRunning). Google закрыл его
 * превью (veo-3.1-generate-preview, veo-3.1-fast-generate-preview), а GA-версий
 * Veo по ключу Gemini API нет: veo-2.0/3.0 сняты ещё 30.06.2026. Официальная
 * замена — Omni. Имя класса, событие veo_call и поля veo_* в плане задачи
 * остались прежними: на них завязаны строки video_jobs, мониторинг и клиенты.
 *
 * Механика, проверенная живыми вызовами 24.10.2026:
 *  - запуск: POST v1beta/interactions с x-goog-api-key, тело { model,
 *    background: true, input, response_format: { type: 'video', aspect_ratio,
 *    resolution, duration: '8s' } } → сразу { id, status: 'in_progress' }.
 *    input — строка или массив частей { type: 'image', data, mime_type } и
 *    { type: 'text', text }. Ролик 3–10 с, со звуком, 24 к/с.
 *  - опрос: GET v1beta/interactions/{id} → status in_progress | completed |
 *    failed. Готовый ролик — в шаге steps[].type='model_output', часть
 *    content[].type='video', инлайном в data (base64): GET отдаёт инлайн даже
 *    при delivery 'uri'.
 *  - продление: тот же POST с previous_interaction_id прошлого шага и текстом
 *    продолжения. Ответ — ВЕСЬ ролик (4 с + 4 с → 8,0 с), как было у Veo, а в
 *    счёт идут только новые секунды. Предел — 40 с суммарно. Речь в продлении
 *    работает (multi-turn), в том числе с серверов в ЕЭЗ.
 *  - негативного промпта, temperature и system instructions у Omni нет:
 *    запреты пишутся в сам промпт.
 *  - цена: 5 792 видео-токена за секунду 720p и 8 688 за секунду 1080p по
 *    $17.50 за 1M, то есть ≈ $0.10/с и ≈ $0.15/с.
 *
 * Ключ — тот же GOOGLE_AI_API_KEY, что у генерации картинок.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const OMNI_MODEL = 'gemini-omni-1.1-flash';

/** Длина базового клипа и шага продления, секунды. */
const BASE_SEC = 8;
const EXTEND_SEC = 7;

export interface VeoOperationStatus {
  done: boolean;
  /** Готовый mp4 — целиком, у продления это весь ролик с начала. */
  video: Buffer | null;
  error: string | null;
}

type Aspect = '16:9' | '9:16';
type Resolution = '720p' | '1080p';

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

  private videoFormat(aspectRatio: Aspect | undefined, resolution: Resolution | undefined, durationSeconds: number) {
    return {
      type: 'video',
      aspect_ratio: aspectRatio || '16:9',
      resolution: resolution || '720p',
      duration: `${durationSeconds}s`,
    };
  }

  // Map upstream errors to a job error_message. A 429/quota is an operational
  // ceiling (дневной лимит на ключе), not a user error — surface it plainly
  // so the assistant/UI can say "try later" instead of a raw billing message.
  private describeError(e: any, label: 'generate' | 'extend'): string {
    const status = e.response?.status;
    const raw = e.response?.data?.error?.message || e.message || 'unknown error';
    if (status === 429 || /RESOURCE_EXHAUSTED|exceeded your current quota/i.test(raw)) {
      // Когда именно снова заработает. Google иногда кладёт RetryInfo.retryDelay
      // (короткий — это per-minute rate limit). Если его нет — это дневная квота
      // (RPD), которая сбрасывается раз в сутки в полночь по тихоокеанскому
      // времени (≈ 10–11 утра МСК).
      const details: any[] = e.response?.data?.error?.details || [];
      const retry = details.find((d) => typeof d?.['@type'] === 'string' && d['@type'].includes('RetryInfo'));
      const delayStr: string | undefined = retry?.retryDelay; // напр. "57s"
      const delaySec = delayStr ? parseInt(String(delayStr), 10) : NaN;
      if (Number.isFinite(delaySec) && delaySec > 0 && delaySec < 3600) {
        return `Видео: временный лимит частоты запросов. Можно повторить примерно через ${delaySec < 60 ? `${delaySec} сек` : `${Math.ceil(delaySec / 60)} мин`}.`;
      }
      return 'Видео: на сегодня исчерпан дневной лимит генераций видео. Лимит обновляется раз в сутки около 10:00–11:00 МСК — попробуйте позже. (админу: повысить квоту Gemini Omni для ключа в Google AI Studio / Cloud Console.)';
    }
    return `Omni ${label} failed: ${raw}`;
  }

  private trackCall(method: string, ok: boolean, latencyMs: number, errorShort?: string, op?: string) {
    if (!this.pg) return;
    this.pg.query(
      `INSERT INTO events (name, props) VALUES ('veo_call', $1::jsonb)`,
      [JSON.stringify({ method, model: OMNI_MODEL, ok, latency_ms: latencyMs, error_short: errorShort?.slice(0, 200), operation: op })],
    ).catch((e: any) => this.logger.warn(`veo_call event insert failed: ${e.message}`));
  }

  private async startInteraction(body: any, label: 'generate' | 'extend'): Promise<string> {
    if (!this.apiKey) throw new Error('GOOGLE_AI_API_KEY not configured');
    const t0 = Date.now();
    try {
      const resp = await axios.post(`${API_BASE}/interactions`, body, {
        headers: this.headers(),
        timeout: 60_000,
        // До трёх портретов base64 в теле: дефолтный потолок 10 МБ им мал.
        maxBodyLength: Infinity,
      });
      const id = resp.data?.id;
      if (!id) throw new Error(`no interaction id: ${JSON.stringify(resp.data).slice(0, 200)}`);
      this.trackCall(label, true, Date.now() - t0, undefined, id);
      return id;
    } catch (e: any) {
      const msg = this.describeError(e, label);
      this.trackCall(label, false, Date.now() - t0, msg);
      throw new Error(msg);
    }
  }

  /**
   * Start a base generation. Returns the interaction id.
   * Портреты (`referenceImagesB64`, до трёх) ведут сходство персонажа по всему
   * ролику. Одно фото модель использует сама — проба 24.10 дала точное
   * сходство без подсказки. Два-три фото без явной задачи Omni может принять
   * за первый и последний кадр (интерполяцию), поэтому для них задаём
   * reference_to_video.
   */
  async startGenerate(opts: {
    prompt: string;
    durationSeconds?: number;      // 3–10; default 8
    aspectRatio?: Aspect;
    resolution?: Resolution;
    referenceImagesB64?: Array<{ b64: string; mime: string }>;
    negativePrompt?: string;
  }): Promise<string> {
    const images = (opts.referenceImagesB64 || []).slice(0, 3);
    const text = opts.negativePrompt ? `${opts.prompt}\n\nAvoid: ${opts.negativePrompt}` : opts.prompt;
    const body: any = {
      model: OMNI_MODEL,
      background: true,
      input: images.length
        ? [
            ...images.map((r) => ({ type: 'image', data: r.b64, mime_type: r.mime || 'image/jpeg' })),
            { type: 'text', text },
          ]
        : text,
      response_format: this.videoFormat(opts.aspectRatio, opts.resolution, opts.durationSeconds || BASE_SEC),
    };
    if (images.length > 1) body.generation_config = { video_config: { task: 'reference_to_video' } };
    return this.startInteraction(body, 'generate');
  }

  /**
   * Extend the previous step (by its interaction id). Output is the FULL
   * combined video, so the last step of a chain is the finished clip.
   */
  async startExtend(opts: {
    prompt: string;
    previousInteractionId: string;
    durationSeconds?: number;      // default 7
    aspectRatio?: Aspect;
    resolution?: Resolution;
  }): Promise<string> {
    return this.startInteraction({
      model: OMNI_MODEL,
      background: true,
      previous_interaction_id: opts.previousInteractionId,
      input: opts.prompt,
      response_format: this.videoFormat(opts.aspectRatio, opts.resolution, opts.durationSeconds || EXTEND_SEC),
    }, 'extend');
  }

  /** Poll an interaction. A finished one carries the whole mp4. */
  async getOperation(interactionId: string): Promise<VeoOperationStatus> {
    if (!this.apiKey) throw new Error('GOOGLE_AI_API_KEY not configured');
    const resp = await axios.get(`${API_BASE}/interactions/${interactionId}`, {
      headers: this.headers(),
      timeout: 120_000,
      maxContentLength: 300 * 1024 * 1024,
    });
    const d = resp.data || {};
    if (d.status === 'in_progress') return { done: false, video: null, error: null };
    if (d.status !== 'completed') {
      // Провал приходит массивом errors: [{ message, code }] (живой ответ
      // 24.10.2026); одиночный error — на случай другой формы.
      const errs: any[] = Array.isArray(d.errors) ? d.errors : (d.error ? [d.error] : []);
      const first = errs.find((x) => x?.message) ?? errs[0];
      let reason = first?.message ? String(first.message) : `interaction ${d.status ?? 'without status'}`;
      // Отказ фильтра (узнаваемый человек, запретная тема) Omni отдаёт как
      // INVALID_ARGUMENT с общим текстом «There was a problem processing your
      // request» — без подсказки человек не поймёт, что менять.
      if (first?.code === 'INVALID_ARGUMENT') {
        reason = `Omni отклонил запрос — чаще всего это фильтр контента (узнаваемые люди, дети на фото, запрещённые темы); переформулируйте описание. ${reason}`;
      }
      return { done: true, video: null, error: reason };
    }

    const outputs = (Array.isArray(d.steps) ? d.steps : []).filter((s: any) => s?.type === 'model_output');
    const parts: any[] = outputs.flatMap((s: any) => (Array.isArray(s.content) ? s.content : []));
    const clip = parts.filter((c) => c?.type === 'video').pop();
    if (clip?.data) return { done: true, video: Buffer.from(clip.data, 'base64'), error: null };
    if (clip?.uri) return { done: true, video: await this.downloadVideo(clip.uri), error: null };

    // Отказ фильтра или модели приходит текстом вместо ролика — отдаём его,
    // чтобы ассистент мог сказать человеку, что переформулировать.
    const said = parts.filter((c) => c?.type === 'text' && c.text).map((c) => c.text).join(' ').trim();
    return {
      done: true,
      video: null,
      error: said ? `Omni не вернул видео: ${said.slice(0, 400)}` : 'interaction completed without video',
    };
  }

  /** Download mp4 bytes by a Files API uri (key required in the header). */
  private async downloadVideo(uri: string): Promise<Buffer> {
    const resp = await axios.get(uri, {
      headers: { 'x-goog-api-key': this.apiKey },
      responseType: 'arraybuffer',
      timeout: 120_000,
      maxContentLength: 200 * 1024 * 1024,
    });
    return Buffer.from(resp.data);
  }
}
