// worker/src/postprocess/ffmpeg.ts
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { logger } from '../logger';

// Prefer the statically-bundled binary; fall back to $FFMPEG_PATH env override or
// the system ffmpeg if the static binary is unavailable / not executable.
const FFMPEG_BIN =
  process.env.FFMPEG_PATH ||
  (ffmpegStatic as unknown as string) ||
  'ffmpeg';

/**
 * Re-encode the raw Remotion output into a TikTok/Reels-friendly MP4:
 *   - H.264 main profile (good balance of compat and quality)
 *   - yuv420p pixel format
 *   - 1080x1920 (enforce)
 *   - 30fps cap
 *   - AAC audio 128kbps stereo
 *   - +faststart for streaming playback
 */
export async function postprocessMp4(inputPath: string, outputPath: string): Promise<void> {
  const args = [
    '-y',
    '-i', inputPath,
    '-c:v', 'libx264',
    '-profile:v', 'main',
    '-preset', 'medium',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-vf', 'scale=1080:1920,fps=30',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    outputPath,
  ];

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) {
        logger.info({ inputPath, outputPath }, 'ffmpeg postprocess ok');
        resolve();
      } else {
        reject(new Error(`ffmpeg exited code=${code}: ${stderr.slice(-500)}`));
      }
    });
  });
}
