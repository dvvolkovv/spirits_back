import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { config } from '../config';
import { logger } from '../logger';

const NANO_BANANA_MODEL = 'gemini-2.5-flash-image';

export async function generateKeyframe(prompt: string): Promise<string> {
  const apiKey = config.media.googleAiApiKey;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${NANO_BANANA_MODEL}:generateContent?key=${apiKey}`;
  const r = await axios.post(url, {
    contents: [{ parts: [{ text: prompt + ' --ar 9:16 --photorealistic' }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  }, { timeout: 90_000, validateStatus: () => true });
  if (r.status !== 200) {
    logger.error({ status: r.status, body: JSON.stringify(r.data).slice(0, 300) }, 'nano-banana error');
    throw new Error(`nano-banana ${r.status}`);
  }
  const part = r.data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  const b64 = part?.inlineData?.data;
  if (!b64) throw new Error('nano-banana returned no image');
  const buf = Buffer.from(b64, 'base64');
  const out = path.join(os.tmpdir(), `keyframe-${crypto.randomUUID()}.jpg`);
  await fs.writeFile(out, buf);
  return out;
}
