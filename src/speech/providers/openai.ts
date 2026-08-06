// src/speech/providers/openai.ts
import OpenAI from 'openai';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  // Ленивая инициализация: без неё отсутствие ключа роняет весь Nest-bootstrap
  // на test-сервере — ровно та же грабля, что уже описана в tg-voice.service.ts.
  if (!client) client = new OpenAI({ apiKey });
  return client;
}

/**
 * Синтез через OpenAI tts-1. Просим mp3, а не opus: в MinIO клип лежит одним
 * каноническим форматом для веба и мобилки, Telegram конвертирует его сам.
 */
export async function synthesizeOpenai(text: string, voice: string): Promise<Buffer> {
  const resp = await getClient().audio.speech.create({
    model: 'tts-1',
    voice: voice as any,
    input: text,
    response_format: 'mp3',
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length === 0) throw new Error('OpenAI TTS returned empty body');
  return buf;
}
