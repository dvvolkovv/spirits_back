// worker/src/tts/index.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
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

const FFMPEG_BIN = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string) || 'ffmpeg';

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

/**
 * Always writes MP3 to disk so downstream Remotion can play it.
 * For ElevenLabs (already MP3): write bytes directly.
 * For Yandex (raw LPCM 48kHz s16le mono): pipe through ffmpeg to encode as MP3.
 */
export async function writeSynthResultToFile(
  result: SynthResult,
  outDir: string,
  basename: string,
): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  const mp3Path = path.join(outDir, `${basename}.mp3`);

  if (result.format === 'mp3') {
    await fs.writeFile(mp3Path, result.bytes);
    return mp3Path;
  }

  // LPCM → MP3 via ffmpeg stdin
  await new Promise<void>((resolve, reject) => {
    const args = [
      '-y',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '1',
      '-i', 'pipe:0',
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',
      mp3Path,
    ];
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`ffmpeg spawn: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg lpcm→mp3 exit=${code}: ${stderr.slice(-300)}`));
    });
    proc.stdin.end(result.bytes);
  });

  return mp3Path;
}
