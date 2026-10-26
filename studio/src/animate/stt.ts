import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StudioError } from '../errors';

const run = promisify(execFile);
const STT_URL = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';
/** Паузы перед повторами: сбой SpeechKit на десятки секунд пережидается здесь, а не пересъёмкой. */
const STT_PAUSES_MS = [2_000, 10_000, 30_000];
/** Распознавание 10 секунд звука занимает секунды; без таймаута fetch ждёт до 5 минут. */
const STT_TIMEOUT_MS = 30_000;
/** Предел SpeechKit v1 — 30 с звука. */
const MAX_SPEECH_SEC = 29;

export interface SttCreds {
  apiKey: string;
  folderId: string;
}

export interface SttOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Звук клипа → ogg/opus, моно 48 кГц, не длиннее 29 с: так его принимает
 * SpeechKit v1 (до 30 с и 1 МБ). Минус 6 дБ — запас: сведение стерео в моно
 * поднимает громкий звук выше 0 dBFS.
 */
export async function speechAudio(clip: string, out: string): Promise<string> {
  try {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', clip,
      '-vn', '-t', String(MAX_SPEECH_SEC), '-ac', '1', '-af', 'volume=-6dB', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg',
      out,
    ]);
  } catch (e) {
    const stderr = String((e as { stderr?: string }).stderr ?? '').trim().split('\n').pop();
    throw new Error(`ffmpeg: звук клипа не извлёкся — ${stderr || (e instanceof Error ? e.message.split('\n')[0] : String(e))}`);
  }
  return out;
}

/** Текст сетевой ошибки с причиной: у fetch она лежит в cause.code (ECONNREFUSED и т. п.). */
function netError(e: unknown): string {
  const cause = (e as { cause?: { code?: string } })?.cause?.code;
  return `${e instanceof Error ? e.message : String(e)}${cause ? ` (${cause})` : ''}`;
}

/**
 * Распознавание SpeechKit v1 (те же ключи, что у синтеза). Числа — словами
 * (`rawResults=true`): реплики сценок пишутся словами. Сбой сети, таймаут,
 * обрыв или не-JSON тела, 5xx и 429 повторяются здесь же: клип Omni уже
 * оплачен, и пересъёмка из-за моргнувшего SpeechKit стоила бы денег. Поэтому
 * наружу ошибка выходит только `stt` и без повтора. Ключ из текста ответа
 * вырезается.
 */
export async function recognize(ogg: Buffer, creds: SttCreds, o: SttOptions = {}): Promise<string> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${STT_URL}?${new URLSearchParams({ lang: 'ru-RU', format: 'oggopus', rawResults: 'true', folderId: creds.folderId })}`;
  const hide = (s: string): string => (creds.apiKey ? s.split(creds.apiKey).join('***') : s);
  let last = '';
  for (let attempt = 0; attempt <= STT_PAUSES_MS.length; attempt++) {
    if (attempt > 0) await sleep(STT_PAUSES_MS[attempt - 1]);
    let status = 0;
    let raw = '';
    try {
      const resp = await f(url, {
        method: 'POST',
        headers: { Authorization: `Api-Key ${creds.apiKey}` },
        body: new Uint8Array(ogg),
        signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      });
      status = resp.status;
      raw = await resp.text();
    } catch (e) {
      last = netError(e);
      continue;
    }
    if (status >= 200 && status < 300) {
      let reply: { result?: unknown; error_code?: unknown } | null = null;
      try {
        reply = JSON.parse(raw) as { result?: unknown; error_code?: unknown } | null;
      } catch {
        reply = null;
      }
      if (reply && typeof reply.result === 'string') return reply.result;
      if (reply && reply.result === undefined && reply.error_code === undefined) return '';
      last = `SpeechKit ${status}: в ответе нет распознанного текста — ${hide(raw.slice(0, 200))}`;
      continue;
    }
    last = `SpeechKit ${status} ${hide(raw.slice(0, 200))}`;
    if (status < 500 && status !== 429) break;
  }
  throw new StudioError('stt', `stt: распознать речь не удалось — ${last}`, false);
}
