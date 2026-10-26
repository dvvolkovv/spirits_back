import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StudioError } from '../errors';

const run = promisify(execFile);
const STT_URL = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';
const STT_ATTEMPTS = 3;
const STT_PAUSE_MS = 2000;

export interface SttCreds {
  apiKey: string;
  folderId: string;
}

export interface SttOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Звук клипа → ogg/opus, моно 48 кГц: так его принимает SpeechKit v1 (до 30 с и 1 МБ). */
export async function speechAudio(clip: string, out: string): Promise<string> {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', clip, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', out]);
  return out;
}

/**
 * Распознавание SpeechKit v1 (те же ключи, что у синтеза). Сбой сети и 5xx
 * повторяются здесь же, до трёх раз: клип Omni уже оплачен, и пересъёмка из-за
 * моргнувшего SpeechKit стоила бы денег. Поэтому наружу ошибка выходит без
 * повтора. В ошибку не попадают ни ключ, ни звук.
 */
export async function recognize(ogg: Buffer, creds: SttCreds, o: SttOptions = {}): Promise<string> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${STT_URL}?${new URLSearchParams({ lang: 'ru-RU', format: 'oggopus', folderId: creds.folderId })}`;
  let last = '';
  for (let attempt = 1; attempt <= STT_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(STT_PAUSE_MS);
    let resp: Response;
    try {
      resp = await f(url, { method: 'POST', headers: { Authorization: `Api-Key ${creds.apiKey}` }, body: new Uint8Array(ogg) });
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      continue;
    }
    const raw = await resp.text();
    if (resp.ok) return String((JSON.parse(raw) as { result?: string }).result ?? '');
    last = `SpeechKit ${resp.status} ${raw.slice(0, 200)}`;
    if (resp.status < 500) break;
  }
  throw new StudioError('stt', `stt: распознать речь не удалось — ${last}`, false);
}
