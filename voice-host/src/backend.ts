import { createHmac } from 'node:crypto';

const BACKEND = process.env.BACKEND_URL || 'https://my.linkeon.io';
const SECRET = process.env.VOICE_CALLBACK_SECRET || '';

function sign(raw: string): string {
  return createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex');
}

/**
 * Таймауты подобраны под роль вызова, а не одинаковые.
 *
 * `ask` живёт внутри тула, который OpenAI Realtime исполняет СИНХРОННО и
 * держит разговор, пока тот не вернётся. Зависший бэкенд без таймаута — это
 * тишина в трубке на весь undici-дефолт (300 с), то есть ровно то поведение,
 * ради ухода от которого мы отказались от remote MCP. Две секунды хватает:
 * ручка только пишет строку и ставит job в очередь.
 */
const TIMEOUT_MS: Record<string, number> = {
  ask: 2_000,
  document: 2_000,
  complete: 15_000,
  failed: 5_000,
  // Отметка «во встречу пришёл первый человек» — учётная. Ждать её долго
  // незачем: разговор от неё не зависит.
  'meeting-first-human': 5_000,
};

async function post<T>(path: string, body: unknown): Promise<T> {
  const raw = JSON.stringify(body);
  const res = await fetch(`${BACKEND}/webhook/voice-call/internal/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-voice-signature': sign(raw) },
    body: raw,
    signal: AbortSignal.timeout(TIMEOUT_MS[path] ?? 10_000),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export type AskResult =
  | { status: 'asked'; jobId: string; specialist: string }
  | { status: 'rejected'; reason: 'unknown_specialist' };

/** Реплика из транскрипта звонка — то же, что бэкенд ждёт в /internal/complete. */
export type TranscriptEntry = {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  /**
   * Кто это сказал — по активному говорящему LiveKit. Есть только на встрече
   * и только у человеческих реплик. Разметка приблизительная: при перебивании
   * и хоровой речи имя будет неверным.
   */
  speaker?: string;
};

/** Учёт аудио-токенов Realtime-сессии — то же, что CompletePayload['usage'] на бэке. */
export type CallUsage = { audioInputTokens: number; audioOutputTokens: number; model: string };

export type DocumentResult =
  | { status: 'accepted'; docId: string; title: string; specialist?: string }
  | { status: 'rejected'; reason: 'no_title' };

export const backend = {
  ask: (callId: string, specialist: string, question: string) =>
    post<AskResult>('ask', { callId, specialist, question }),
  document: (callId: string, title: string, instructions: string, specialist?: string) =>
    post<DocumentResult>('document', { callId, title, instructions, specialist }),
  complete: (callId: string, transcript: TranscriptEntry[], usage: CallUsage) =>
    post<{ ok: true }>('complete', { callId, transcript, usage }),
  // Прогресс-флаш транскрипта во время звонка: сбой Realtime API / пересоздание сессии
  // не теряют уже сказанное. Не финализирует — бэкенд стейджит keep-longest (owner 2026-09-01).
  progress: (callId: string, transcript: TranscriptEntry[]) =>
    post<{ ok: true }>('progress', { callId, transcript }),
  failed: (callId: string, reason: string) =>
    post<{ ok: true }>('failed', { callId, reason }),
  meetingFirstHuman: (callId: string) =>
    post<{ ok: true }>('meeting-first-human', { callId }),
};
