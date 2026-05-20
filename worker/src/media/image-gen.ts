// worker/src/media/image-gen.ts
import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../logger';

export interface ImageGenInput {
  prompt: string;
  aspectRatio?: '1:1' | '9:16' | '16:9' | '4:3' | '3:4';
}

// Imagen tier ladder — try each in order, switch to next on 429 (quota) or 5xx.
// imagen-4.0-fast has the largest day-quota on paid-tier-1; ultra is best quality
// but capped at 30/day. We prefer balanced quality+headroom: generate-001.
const IMAGEN_MODELS = [
  'imagen-4.0-generate-001',
  'imagen-4.0-fast-generate-001',
  'imagen-4.0-ultra-generate-001',
];

// Gemini fallback if all Imagen tiers exhaust. Use the stable name without
// preview-date suffix — those expire when Google publishes a new preview.
const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';

export async function generateImage(input: ImageGenInput): Promise<Buffer> {
  const apiKey = config.media.googleAiApiKey;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not configured');
  const aspect = input.aspectRatio || '9:16';

  for (const model of IMAGEN_MODELS) {
    try {
      const r = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`,
        {
          instances: [{ prompt: input.prompt }],
          parameters: { sampleCount: 1, aspectRatio: aspect, personGeneration: 'allow_adult' },
        },
        { timeout: 60000, validateStatus: () => true },
      );
      if (r.status === 200) {
        const pred = (r.data?.predictions || [])[0];
        const b64 = pred?.bytesBase64Encoded || pred?.image?.bytesBase64Encoded;
        if (b64) {
          const buf = Buffer.from(b64, 'base64');
          logger.debug({ model, bytes: buf.length }, 'image gen ok');
          return buf;
        }
      }
      // Quota exhausted (429) or transient — try next tier.
      logger.warn({ status: r.status, model }, 'Imagen model unavailable, trying next');
    } catch (err: any) {
      logger.warn({ err: err.message, model }, 'Imagen errored, trying next');
    }
  }

  // Final fallback: Gemini 2.5 Flash Image (multimodal text-to-image).
  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`,
    {
      contents: [{ parts: [{ text: `${input.prompt}. Vertical 9:16 portrait composition.` }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    },
    { timeout: 60000, validateStatus: () => true },
  );
  if (r.status !== 200) {
    throw new Error(`Gemini Flash Image ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  const parts = r.data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      const buf = Buffer.from(part.inlineData.data, 'base64');
      logger.debug({ model: GEMINI_IMAGE_MODEL, bytes: buf.length }, 'image gen ok');
      return buf;
    }
  }
  throw new Error('Gemini Flash returned no image data');
}

export async function writeImageToFile(bytes: Buffer, outDir: string, basename: string): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  const filename = path.join(outDir, `${basename}.png`);
  await fs.writeFile(filename, bytes);
  return filename;
}
