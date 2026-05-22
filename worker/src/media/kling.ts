// worker/src/media/kling.ts
// Minimal Kling text2video wrapper for SMM b-roll fallback when Pexels finds nothing.
// Polls the task ~3 min max. Returns mp4 URL or null on failure/timeout.
import axios from 'axios';
import * as fs from 'fs/promises';
import * as jwt from 'jsonwebtoken';
import { logger } from '../logger';

const POLL_INTERVAL_MS = 8_000;
const POLL_MAX_ATTEMPTS = 60;   // 60 × 8s = 8 minutes max wait (china peak hours)
const KLING_PREMIUM_MODEL = 'kling-v2-master';

function getKlingToken(): string | null {
  const ak = process.env.KLING_ACCESS_KEY;
  const sk = process.env.KLING_SECRET_KEY;
  if (!ak || !sk) return null;
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: ak, exp: now + 1800, nbf: now - 5 },
    sk,
    { algorithm: 'HS256', header: { alg: 'HS256', typ: 'JWT' } as any },
  );
}

/**
 * Generate a 5-second 9:16 vertical clip via Kling text2video.
 * Returns the public mp4 URL or null on any failure / missing creds.
 */
export async function klingText2Video(prompt: string): Promise<string | null> {
  const token = getKlingToken();
  if (!token) {
    logger.warn('Kling credentials not set (KLING_ACCESS_KEY/SECRET_KEY) — skipping fallback');
    return null;
  }

  let taskId: string;
  try {
    const resp = await axios.post(
      'https://api.klingai.com/v1/videos/text2video',
      {
        model_name: 'kling-v1-6',
        prompt,
        cfg_scale: 0.5,
        mode: 'std',
        duration: '5',
        aspect_ratio: '9:16',
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 30_000,
        validateStatus: () => true,
      },
    );
    if (resp.status !== 200 || resp.data?.code !== 0) {
      logger.error(
        { status: resp.status, body: JSON.stringify(resp.data).slice(0, 300) },
        'Kling text2video create failed',
      );
      return null;
    }
    taskId = resp.data?.data?.task_id;
    if (!taskId) return null;
    logger.info({ taskId, prompt: prompt.slice(0, 80) }, 'Kling text2video task created');
  } catch (e: any) {
    logger.error(`Kling create error: ${e.message}`);
    return null;
  }

  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const pollToken = getKlingToken();
      if (!pollToken) return null;
      const resp = await axios.get(
        `https://api.klingai.com/v1/videos/text2video/${taskId}`,
        {
          headers: { Authorization: `Bearer ${pollToken}` },
          timeout: 30_000,
          validateStatus: () => true,
        },
      );
      const status = (resp.data?.data?.task_status as string | undefined)?.toLowerCase();
      if (status === 'succeed') {
        const videoUrl = resp.data?.data?.task_result?.videos?.[0]?.url;
        if (videoUrl) {
          logger.info({ taskId, videoUrl }, 'Kling text2video done');
          return videoUrl as string;
        }
        return null;
      }
      if (status === 'failed') {
        logger.warn({ taskId, msg: resp.data?.data?.task_status_msg }, 'Kling text2video failed');
        return null;
      }
      // submitted / processing — keep polling
    } catch (e: any) {
      logger.warn(`Kling poll error: ${e.message}`);
    }
  }

  logger.warn({ taskId }, `Kling text2video timeout after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`);
  return null;
}

export async function klingImage2Video(
  keyframePath: string,
  motionPrompt: string,
  opts: { durationSec?: number } = {},
): Promise<string | null> {
  const token = getKlingToken();
  if (!token) { logger.warn('Kling credentials not set'); return null; }

  const imgB64 = (await fs.readFile(keyframePath)).toString('base64');
  const duration = String(opts.durationSec ?? 5);

  let taskId: string;
  try {
    const resp = await axios.post(
      'https://api.klingai.com/v1/videos/image2video',
      {
        model_name: KLING_PREMIUM_MODEL,
        image: imgB64,
        prompt: motionPrompt,
        cfg_scale: 0.5,
        mode: 'std',
        duration,
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30_000, validateStatus: () => true },
    );
    if (resp.status !== 200 || resp.data?.code !== 0) {
      logger.error({ status: resp.status, body: JSON.stringify(resp.data).slice(0, 300) }, 'Kling image2video create failed');
      return null;
    }
    taskId = resp.data?.data?.task_id;
    if (!taskId) return null;
  } catch (e: any) { logger.error(`Kling image2video create error: ${e.message}`); return null; }

  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const t = getKlingToken();
      if (!t) return null;
      const resp = await axios.get(
        `https://api.klingai.com/v1/videos/image2video/${taskId}`,
        { headers: { Authorization: `Bearer ${t}` }, timeout: 30_000, validateStatus: () => true },
      );
      const status = (resp.data?.data?.task_status as string | undefined)?.toLowerCase();
      if (status === 'succeed') {
        const url = resp.data?.data?.task_result?.videos?.[0]?.url;
        if (url) { logger.info({ taskId, url }, 'Kling image2video done'); return url as string; }
        return null;
      }
      if (status === 'failed') {
        logger.warn({ taskId, msg: resp.data?.data?.task_status_msg }, 'Kling image2video failed');
        return null;
      }
    } catch (e: any) { logger.warn(`Kling image2video poll error: ${e.message}`); }
  }
  logger.warn({ taskId }, `Kling image2video timeout`);
  return null;
}
