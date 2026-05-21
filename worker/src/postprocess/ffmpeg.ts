// worker/src/postprocess/ffmpeg.ts
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { logger } from '../logger';

/**
 * Probe audio/video file duration in seconds via ffmpeg stderr.
 * Returns 0 if probe failed.
 */
export async function probeDurationSec(filePath: string): Promise<number> {
  return new Promise<number>((resolve) => {
    const bin = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string) || 'ffmpeg';
    const proc = spawn(bin, ['-i', filePath, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', () => resolve(0));
    proc.on('close', () => {
      // ffmpeg prints: "  Duration: 00:00:05.66, ..." (HH:MM:SS.MS)
      const m = stderr.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return resolve(0);
      const sec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
      resolve(sec);
    });
  });
}

// Prefer the statically-bundled binary; fall back to $FFMPEG_PATH env override or
// the system ffmpeg if the static binary is unavailable / not executable.
const FFMPEG_BIN =
  process.env.FFMPEG_PATH ||
  (ffmpegStatic as unknown as string) ||
  'ffmpeg';

/**
 * Извлекает последний кадр видео в JPG. Используется в premium-pipeline для
 * seamless-перехода: keyframe следующей kling-сцены = последний кадр предыдущей.
 * Берём -1 сек до конца чтобы избежать чёрного / артефактов на самом краю.
 */
export async function extractLastFrame(videoPath: string, outputJpg: string): Promise<void> {
  const dur = await probeDurationSec(videoPath);
  const seek = Math.max(0, dur - 0.2); // 200 мс до конца
  const args = [
    '-y',
    '-ss', String(seek),
    '-i', videoPath,
    '-frames:v', '1',
    '-q:v', '2',
    outputJpg,
  ];
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', (err) => reject(new Error(`ffmpeg lastframe error: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) {
        logger.info({ videoPath, outputJpg, seek }, 'last frame extracted');
        resolve();
      } else {
        reject(new Error(`ffmpeg lastframe exited code=${code}: ${stderr.slice(-500)}`));
      }
    });
  });
}

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
