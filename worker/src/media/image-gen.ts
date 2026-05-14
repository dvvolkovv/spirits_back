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

export async function generateImage(input: ImageGenInput): Promise<Buffer> {
  const apiKey = config.media.googleAiApiKey;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not configured');
  const aspect = input.aspectRatio || '9:16';

  // Try Imagen 4.0 Ultra first
  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-ultra-generate-001:predict?key=${apiKey}`,
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
        logger.debug({ model: 'imagen-4.0-ultra', bytes: buf.length }, 'image gen ok');
        return buf;
      }
    }
    logger.warn({ status: r.status }, 'Imagen failed, falling back to Gemini Flash');
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Imagen errored, falling back');
  }

  // Fallback: Gemini 2.5 Flash Image (Nano Banana 2)
  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`,
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
      logger.debug({ model: 'gemini-2.5-flash-preview-05-20', bytes: buf.length }, 'image gen ok');
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
