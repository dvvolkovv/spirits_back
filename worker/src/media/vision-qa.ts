import axios from 'axios';
import * as fs from 'fs/promises';
import { config } from '../config';
import { logger } from '../logger';

const VISION_MODEL = 'gemini-2.5-flash';
const GOOD_THRESHOLD = 0.4;

export interface ClipScore { score: number; reason: string; good: boolean; }

export async function scoreClip(videoPath: string, motionPrompt: string): Promise<ClipScore> {
  const apiKey = config.media.googleAiApiKey;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not configured');
  const videoB64 = (await fs.readFile(videoPath)).toString('base64');

  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${apiKey}`,
    {
      contents: [{
        parts: [
          { inlineData: { mimeType: 'video/mp4', data: videoB64 } },
          { text:
`Ты QA-аналитик короткого AI-сгенерированного видео-клипа (5 сек, kling).
Сравни клип с описанием намерения: "${motionPrompt}".
Оцени по шкале 0.0-1.0, насколько визуал соответствует намерению, выглядит чисто (без артефактов
лиц/конечностей/текста), и подходит для социальной сети.
Верни СТРОГО JSON: {"score": <0-1>, "reason": "<краткое объяснение>"}.` },
        ],
      }],
      generationConfig: { responseMimeType: 'application/json' },
    },
    { timeout: 60_000, validateStatus: () => true },
  );

  if (r.status !== 200) {
    logger.error({ status: r.status }, 'vision-qa error');
    return { score: 0.5, reason: `qa-api-${r.status}`, good: true };
  }

  try {
    const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text);
    const score = Number(parsed.score) || 0;
    return { score, reason: String(parsed.reason ?? ''), good: score >= GOOD_THRESHOLD };
  } catch (e: any) {
    logger.warn(`vision-qa parse error: ${e.message}`);
    return { score: 0.5, reason: 'parse-failed', good: true };
  }
}
