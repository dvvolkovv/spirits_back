// worker/src/tts/index.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { synthesizeYandex } from './yandex';
import { synthesizeElevenlabs } from './elevenlabs';
import {
  pickYandexVoice,
  pickElevenlabsVoice,
  Speaker,
  AssistantRole,
  HeroGender,
} from './voices';

export type TtsTier = 'economy' | 'premium';

export interface SynthRequest {
  tier: TtsTier;
  speaker: Speaker;
  role: AssistantRole;
  heroGender?: HeroGender;
  text: string;
}

export interface SynthResult {
  format: 'lpcm' | 'mp3';
  bytes: Buffer;
}

export async function synthesize(req: SynthRequest): Promise<SynthResult> {
  if (req.tier === 'economy') {
    const voice = pickYandexVoice(req.speaker, req.role, req.heroGender);
    const bytes = await synthesizeYandex({ text: req.text, voice });
    return { format: 'lpcm', bytes };
  }
  const voice = pickElevenlabsVoice(req.speaker, req.role, req.heroGender);
  const bytes = await synthesizeElevenlabs({ text: req.text, voice });
  return { format: 'mp3', bytes };
}

export async function writeSynthResultToFile(
  result: SynthResult,
  outDir: string,
  basename: string,
): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  const ext = result.format === 'lpcm' ? 'pcm' : 'mp3';
  const filename = path.join(outDir, `${basename}.${ext}`);
  await fs.writeFile(filename, result.bytes);
  return filename;
}
