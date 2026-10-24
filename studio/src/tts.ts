import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { audioDurationMs } from './ffprobe';

export interface TtsRequest {
  id: string;
  text: string;
  voice: string;
  speed: number;
}

export interface TtsResult {
  id: string;
  file: string;
  durationMs: number;
}

export type Manifest = Record<string, { key: string; durationMs: number }>;

/** Ключ кеша: тот же текст тем же голосом и темпом заново не синтезируется — каждый вызов платный. */
export function ttsKey(r: Pick<TtsRequest, 'text' | 'voice' | 'speed'>): string {
  return createHash('sha1').update(`${r.voice}|${r.speed}|${r.text}`).digest('hex');
}

export function cachedResult(manifest: Manifest, r: TtsRequest, dir: string, exists: (file: string) => boolean): TtsResult | null {
  const entry = manifest[r.id];
  const file = path.join(dir, `${r.id}.mp3`);
  if (entry && entry.key === ttsKey(r) && exists(file)) return { id: r.id, file, durationMs: entry.durationMs };
  return null;
}

/**
 * Озвучка реплик в SpeechKit v1 (тот же вызов, что src/speech/providers/yandex.ts
 * бэкенда). Файлы — dir/<id>.mp3, длительности — dir/manifest.json.
 * В ошибку не попадают ни ключ, ни текст запроса.
 */
export async function synthesizeAll(reqs: TtsRequest[], dir: string, creds: { apiKey: string; folderId: string }): Promise<TtsResult[]> {
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest: Manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  const out: TtsResult[] = [];
  for (const r of reqs) {
    const hit = cachedResult(manifest, r, dir, fs.existsSync);
    if (hit) {
      out.push(hit);
      continue;
    }
    if (!creds.apiKey || !creds.folderId) {
      throw new Error(`tts ${r.id}: реплики нет в кеше озвучки, а ключи SpeechKit не заданы`);
    }
    const body = new URLSearchParams({
      text: r.text,
      lang: 'ru-RU',
      voice: r.voice,
      format: 'mp3',
      speed: String(r.speed),
      folderId: creds.folderId,
    });
    const resp = await fetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
      method: 'POST',
      headers: { Authorization: `Api-Key ${creds.apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!resp.ok) throw new Error(`tts ${r.id}: SpeechKit ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    const file = path.join(dir, `${r.id}.mp3`);
    fs.writeFileSync(file, Buffer.from(await resp.arrayBuffer()));
    const durationMs = await audioDurationMs(file);
    manifest[r.id] = { key: ttsKey(r), durationMs };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    out.push({ id: r.id, file, durationMs });
  }
  return out;
}
