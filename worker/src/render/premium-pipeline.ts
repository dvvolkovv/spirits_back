import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import axios from 'axios';
import { klingImage2Video } from '../media/kling';
import { generateKeyframe } from '../media/keyframe-gen';
import { scoreClip } from '../media/vision-qa';
import { extractLastFrame } from '../postprocess/ffmpeg';
import { EscapeHatchError } from './escape-hatch.error';
import { logger } from '../logger';

const MAX_ATTEMPTS = 3;

export interface PremiumScene {
  type: 'kling' | 'imagen';
  keyframe_prompt?: string;
  motion_prompt?: string;
  videoUrl?: string;
  keyframeUrl?: string;
  attempts?: number;
}

export interface PremiumScenario {
  scenes: PremiumScene[];
}

async function downloadToTmp(url: string, ext: string): Promise<string> {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000 });
  const out = path.join(os.tmpdir(), `dl-${crypto.randomUUID()}${ext}`);
  await fs.writeFile(out, Buffer.from(r.data));
  return out;
}

/**
 * Обрабатывает kling-сцены сценария ПОСЛЕДОВАТЕЛЬНО:
 *   - Сцена 1: nano-banana keyframe (из keyframe_prompt)
 *   - Сцены 2..N: keyframe = последний кадр предыдущего kling-клипа (ffmpeg extract)
 * Это даёт визуально бесшовный переход между сценами — конец сцены N и начало N+1
 * совпадают по кадру.
 *
 * Если у сцены N>1 явно указан keyframe_prompt и lastFramePath не извлечён — используем prompt.
 * (например, если сцены не подряд — между ними imagen-сцена).
 */
export async function processPremiumScenes(scenario: PremiumScenario): Promise<void> {
  // lastKlingClipPath — путь к скачанному mp4-клипу последней успешной kling-сцены,
  // используется чтобы extractLastFrame подал keyframe следующей сцене.
  let lastKlingClipPath: string | null = null;

  for (let i = 0; i < scenario.scenes.length; i++) {
    const scene = scenario.scenes[i];
    if (scene.type !== 'kling') {
      // imagen-сцена «разрывает» chain: следующая kling-сцена снова нуждается в своём keyframe_prompt
      lastKlingClipPath = null;
      continue;
    }
    if (!scene.motion_prompt) {
      throw new Error(`scene ${i}: kling type requires motion_prompt`);
    }

    // keyframe: либо из предыдущего kling-клипа (chain), либо nano-banana (новый сегмент)
    let keyframePath: string;
    if (lastKlingClipPath) {
      keyframePath = path.join(os.tmpdir(), `lastframe-${crypto.randomUUID()}.jpg`);
      try {
        await extractLastFrame(lastKlingClipPath, keyframePath);
        logger.info({ sceneIdx: i, source: 'last-frame-chain' }, 'keyframe from previous clip');
      } catch (e: any) {
        logger.warn({ sceneIdx: i, err: e.message }, 'extractLastFrame failed — falling back to nano-banana');
        if (!scene.keyframe_prompt) {
          throw new Error(`scene ${i}: last-frame extract failed and no keyframe_prompt fallback`);
        }
        keyframePath = await generateKeyframe(scene.keyframe_prompt);
      }
    } else {
      if (!scene.keyframe_prompt) {
        throw new Error(`scene ${i}: first kling scene requires keyframe_prompt`);
      }
      keyframePath = await generateKeyframe(scene.keyframe_prompt);
      logger.info({ sceneIdx: i, source: 'nano-banana' }, 'keyframe generated');
    }
    scene.keyframeUrl = keyframePath;
    scene.attempts = 0;

    // Best-of-N: запускаем kling до MAX_ATTEMPTS раз. Если qa.good — берём сразу.
    // Если все < threshold, берём с максимальным score (не escape hatch — ролик всё равно
    // лучше доставить чем уйти в refund flow на каждой проблемной сцене).
    // Escape hatch фирится только когда kling вообще не вернул mp4 ни разу (API down).
    const durationSec = (scene as any).duration === 10 ? 10 : 5;
    let bestUrl: string | null = null;
    let bestClipPath: string | null = null;
    let bestScore = -1;
    let bestReason = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      scene.attempts = attempt;
      const videoUrl = await klingImage2Video(keyframePath, scene.motion_prompt, { durationSec });
      if (!videoUrl) {
        logger.warn(`scene ${i} attempt ${attempt}: kling returned null`);
        continue;
      }
      const localClip = await downloadToTmp(videoUrl, '.mp4');
      const qa = await scoreClip(localClip, scene.motion_prompt);
      logger.info({ sceneIdx: i, attempt, score: qa.score, reason: qa.reason }, 'vision-QA verdict');
      if (qa.score > bestScore) {
        bestScore = qa.score;
        bestUrl = videoUrl;
        bestClipPath = localClip;
        bestReason = qa.reason;
      }
      if (qa.good) break; // ранний выход на первом good
    }
    if (!bestUrl) {
      // Только сюда попадаем если kling вернул null на ВСЕ 3 попытки (API down).
      throw new EscapeHatchError(i, `scene ${i}: kling returned no video in ${MAX_ATTEMPTS} attempts`);
    }
    scene.videoUrl = bestUrl;
    if (bestScore < 0.4) {
      logger.warn({ sceneIdx: i, bestScore, bestReason }, 'best-of-N below threshold — using anyway');
    }
    // Для следующей kling-сцены извлечём lastFrame из этого клипа.
    lastKlingClipPath = bestClipPath;
  }
}
