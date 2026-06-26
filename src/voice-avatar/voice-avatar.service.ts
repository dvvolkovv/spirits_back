import { Injectable, Logger, OnModuleInit, Optional, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';

/**
 * Видео «голосом оригинала» (backlog 96cba3f7).
 *
 * Пайплайн (валидирован POC'ами):
 *  - profile():  Gemini multimodal слушает сэмпл → дескриптор голоса
 *    (пол/возраст/регистр/темп/тембр + veo_voice_prompt), которым задаётся
 *    голос Veo-рассказчика — чтобы источник для STS был близок к юзеру.
 *  - clone():    ElevenLabs instant voice clone сэмпла → voice_id.
 *  - convert():  ElevenLabs speech-to-speech — переносит тембр клиента на
 *    аудиодорожку Veo, СОХРАНЯЯ тайминг (губы остаются синхронны). Используется
 *    в video-пайплайне (Фаза 2).
 *
 * Клонируем ТОЛЬКО собственный голос юзера, с явным consent (privacy-правило).
 */

export interface VoiceDescriptor {
  gender?: string;
  approx_age_range?: string;
  pitch_register?: string;
  pace?: string;
  timbre?: string;
  accent_or_language?: string;
  veo_voice_prompt?: string;
}

export interface UserVoiceRow {
  user_id: string;
  elevenlabs_voice_id: string | null;
  voice_descriptor: VoiceDescriptor | null;
  sample_url: string | null;
  consent_at: string | null;
  status: 'pending' | 'ready' | 'failed';
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

const GEMINI_MODEL = 'gemini-2.5-flash';
const STS_MODEL = 'eleven_multilingual_sts_v2';
const EL_BASE = 'https://api.elevenlabs.io/v1';

const PROFILE_PROMPT =
  `You are a voice casting director. Listen to this voice sample and describe the speaker's voice so a ` +
  `video-generation model can synthesize a NARRATOR whose voice closely matches this person. Return ONLY ` +
  `minified JSON with keys: gender, approx_age_range, pitch_register (low|medium-low|medium|medium-high|high), ` +
  `pace (slow|medium|fast), timbre (2-4 adjectives), accent_or_language, veo_voice_prompt (ONE English sentence ` +
  `instructing a video model what voice to use to mimic this speaker). JSON only, no prose.`;

@Injectable()
export class VoiceAvatarService implements OnModuleInit {
  private readonly logger = new Logger(VoiceAvatarService.name);

  constructor(@Optional() private readonly pg?: PgService) {}

  async onModuleInit() {
    if (!this.pg) return;
    const candidates = [
      path.join(__dirname, 'migrations', '001_user_voice.sql'),
      path.join(__dirname, '..', '..', 'src', 'voice-avatar', 'migrations', '001_user_voice.sql'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const sql = fs.readFileSync(p, 'utf8');
          await this.pg.query(sql);
          this.logger.log(`voice-avatar migration 001 applied from ${p}`);
          return;
        }
      } catch (e: any) {
        this.logger.error(`voice-avatar migration failed (${p}): ${e.message}`);
      }
    }
    this.logger.warn('voice-avatar migration sql not found, skipping');
  }

  get configured(): boolean {
    return !!process.env.ELEVENLABS_API_KEY && !!process.env.GOOGLE_AI_API_KEY;
  }

  // ─────────────────────────── DB ───────────────────────────

  async getUserVoice(userId: string): Promise<UserVoiceRow | null> {
    if (!this.pg) return null;
    const r = await this.pg.query(`SELECT * FROM user_voice WHERE user_id = $1`, [userId]);
    return (r.rows[0] as UserVoiceRow) || null;
  }

  /** True если у юзера есть готовый клон, пригодный для генерации. */
  async hasReadyVoice(userId: string): Promise<boolean> {
    const v = await this.getUserVoice(userId);
    return !!(v && v.status === 'ready' && v.elevenlabs_voice_id);
  }

  // ─────────────────────────── ffmpeg ───────────────────────────

  /** Нормализует входной сэмпл (любой формат) в mono mp3 для Gemini/ElevenLabs. */
  async normalizeToMp3(buf: Buffer): Promise<Buffer> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'va-'));
    const inPath = path.join(dir, 'in');
    const outPath = path.join(dir, 'out.mp3');
    try {
      await fs.promises.writeFile(inPath, buf);
      await this.runFfmpeg(['-y', '-i', inPath, '-ac', '1', '-ar', '44100', '-b:a', '192k', outPath]);
      return await fs.promises.readFile(outPath);
    } finally {
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', args);
      let err = '';
      ff.stderr.on('data', (d) => { err += d.toString(); });
      ff.on('error', (e) => reject(e));
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-400)}`))));
    });
  }

  // ─────────────────────────── Gemini profiler ───────────────────────────

  async profile(mp3Buf: Buffer): Promise<VoiceDescriptor> {
    const key = process.env.GOOGLE_AI_API_KEY;
    if (!key) throw new Error('GOOGLE_AI_API_KEY not configured');
    const body = {
      contents: [{ parts: [
        { inline_data: { mime_type: 'audio/mpeg', data: mp3Buf.toString('base64') } },
        { text: PROFILE_PROMPT },
      ] }],
    };
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
      body,
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 },
    );
    const text: string = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const json = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    try {
      return JSON.parse(json) as VoiceDescriptor;
    } catch {
      throw new Error(`profiler: bad JSON from Gemini: ${text.slice(0, 200)}`);
    }
  }

  // ─────────────────────────── ElevenLabs ───────────────────────────

  /** Instant voice clone сэмпла → voice_id. */
  async clone(mp3Buf: Buffer, name: string): Promise<string> {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('ELEVENLABS_API_KEY not configured');
    const fd = new FormData();
    fd.append('name', name);
    fd.append('remove_background_noise', 'true');
    fd.append('files', new Blob([new Uint8Array(mp3Buf)], { type: 'audio/mpeg' }), 'sample.mp3');
    const resp = await axios.post(`${EL_BASE}/voices/add`, fd, {
      headers: { 'xi-api-key': key },
      timeout: 120000,
    });
    const voiceId = resp.data?.voice_id;
    if (!voiceId) throw new Error(`clone: no voice_id in response: ${JSON.stringify(resp.data).slice(0, 200)}`);
    return voiceId;
  }

  /**
   * Speech-to-speech: переносит голос voiceId на входное аудио, сохраняя тайминг.
   * Возвращает mp3-байты. (Используется в video-пайплайне, Фаза 2.)
   */
  async convert(voiceId: string, audioBuf: Buffer, opts: { speed?: number } = {}): Promise<Buffer> {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('ELEVENLABS_API_KEY not configured');
    const settings: Record<string, unknown> = {
      stability: 0.45, similarity_boost: 1.0, style: 0.0, use_speaker_boost: true,
    };
    if (opts.speed != null) settings.speed = opts.speed;
    const fd = new FormData();
    fd.append('model_id', STS_MODEL);
    fd.append('remove_background_noise', 'true');
    fd.append('voice_settings', JSON.stringify(settings));
    fd.append('audio', new Blob([new Uint8Array(audioBuf)], { type: 'audio/mpeg' }), 'src.mp3');
    const resp = await axios.post(
      `${EL_BASE}/speech-to-speech/${voiceId}?output_format=mp3_44100_128`,
      fd,
      { headers: { 'xi-api-key': key }, responseType: 'arraybuffer', timeout: 180000 },
    );
    const out = Buffer.from(resp.data);
    // ElevenLabs при ошибке отдаёт JSON (а не аудио) с 200/4xx — детектим.
    const head = out.slice(0, 1).toString('utf8');
    if (head === '{') throw new Error(`STS error: ${out.slice(0, 200).toString('utf8')}`);
    return out;
  }

  async deleteClone(voiceId: string): Promise<void> {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return;
    try {
      await axios.delete(`${EL_BASE}/voices/${voiceId}`, { headers: { 'xi-api-key': key }, timeout: 30000 });
    } catch (e: any) {
      this.logger.warn(`deleteClone ${voiceId} failed: ${e.message}`);
    }
  }

  // ─────────────────────────── Orchestration ───────────────────────────

  /**
   * Принять сэмпл с consent: upsert строки в pending и запустить async
   * профилирование+клонирование (не блокируя ответ юзеру).
   */
  async ingestSample(userId: string, rawBuf: Buffer, consent: boolean): Promise<void> {
    if (!this.pg) throw new Error('pg not available');
    if (!consent) throw new BadRequestException('consent required');
    if (!this.configured) throw new BadRequestException('voice cloning not configured');
    if (!rawBuf?.byteLength) throw new BadRequestException('empty sample');

    // Если был старый клон — удалить, чтобы не плодить голоса в аккаунте.
    const existing = await this.getUserVoice(userId);
    if (existing?.elevenlabs_voice_id) await this.deleteClone(existing.elevenlabs_voice_id);

    await this.pg.query(
      `INSERT INTO user_voice (user_id, status, consent_at, elevenlabs_voice_id, voice_descriptor, error_message, updated_at)
         VALUES ($1, 'pending', now(), NULL, NULL, NULL, now())
       ON CONFLICT (user_id) DO UPDATE
         SET status='pending', consent_at=now(), elevenlabs_voice_id=NULL,
             voice_descriptor=NULL, error_message=NULL, updated_at=now()`,
      [userId],
    );

    // Нормализуем сейчас (нужен буфер), профиль+клон — async.
    let mp3: Buffer;
    try {
      mp3 = await this.normalizeToMp3(rawBuf);
    } catch (e: any) {
      await this.markFailed(userId, `normalize: ${e.message}`);
      throw new BadRequestException('could not process audio sample');
    }
    setImmediate(() => this.profileAndClone(userId, mp3).catch(() => {}));
  }

  private async profileAndClone(userId: string, mp3: Buffer): Promise<void> {
    if (!this.pg) return;
    try {
      const descriptor = await this.profile(mp3);
      const voiceId = await this.clone(mp3, `user_${userId}`);
      await this.pg.query(
        `UPDATE user_voice
            SET status='ready', elevenlabs_voice_id=$2, voice_descriptor=$3,
                error_message=NULL, updated_at=now()
          WHERE user_id=$1`,
        [userId, voiceId, JSON.stringify(descriptor)],
      );
      this.logger.log(`voice ready for ${userId} (voice ${voiceId})`);
    } catch (e: any) {
      this.logger.error(`profileAndClone failed for ${userId}: ${e.message}`);
      await this.markFailed(userId, e.message);
    }
  }

  private async markFailed(userId: string, msg: string): Promise<void> {
    if (!this.pg) return;
    await this.pg.query(
      `UPDATE user_voice SET status='failed', error_message=$2, updated_at=now() WHERE user_id=$1`,
      [userId, String(msg).slice(0, 500)],
    );
  }

  async removeVoice(userId: string): Promise<void> {
    if (!this.pg) return;
    const v = await this.getUserVoice(userId);
    if (v?.elevenlabs_voice_id) await this.deleteClone(v.elevenlabs_voice_id);
    await this.pg.query(`DELETE FROM user_voice WHERE user_id = $1`, [userId]);
  }
}
