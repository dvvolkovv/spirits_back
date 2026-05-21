import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import axios from 'axios';
import { klingImage2Video } from '../media/kling';
import { generateKeyframe } from '../media/keyframe-gen';
import { scoreClip } from '../media/vision-qa';
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

export async function processPremiumScenes(scenario: PremiumScenario): Promise<void> {
  for (let i = 0; i < scenario.scenes.length; i++) {
    const scene = scenario.scenes[i];
    if (scene.type !== 'kling') continue;
    if (!scene.keyframe_prompt || !scene.motion_prompt) {
      throw new Error(`scene ${i}: kling type requires keyframe_prompt + motion_prompt`);
    }
    const keyframePath = await generateKeyframe(scene.keyframe_prompt);
    scene.keyframeUrl = keyframePath;
    scene.attempts = 0;
    let videoUrl: string | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      scene.attempts = attempt;
      videoUrl = await klingImage2Video(keyframePath, scene.motion_prompt);
      if (!videoUrl) {
        logger.warn(`scene ${i} attempt ${attempt}: kling returned null`);
        continue;
      }
      const localClip = await downloadToTmp(videoUrl, '.mp4');
      const qa = await scoreClip(localClip, scene.motion_prompt);
      logger.info({ sceneIdx: i, attempt, score: qa.score, reason: qa.reason }, 'vision-QA verdict');
      if (qa.good) { scene.videoUrl = videoUrl; break; }
      videoUrl = null;
    }
    if (!videoUrl) {
      throw new EscapeHatchError(i, `scene ${i}: 3 attempts failed vision-QA`);
    }
  }
}
