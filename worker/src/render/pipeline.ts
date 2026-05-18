// worker/src/render/pipeline.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { apiClient } from '../api-client';
import { logger } from '../logger';
import { synthesize, writeSynthResultToFile } from '../tts';
import { probeDurationSec } from '../postprocess/ffmpeg';
import { klingText2Video } from '../media/kling';
import { chunkSubtitles } from '../tts/subtitle-chunker';
import { generateImage, writeImageToFile } from '../media/image-gen';
import { searchStockVideo, downloadStockVideo } from '../media/stock-video';
import { pickTrackByMood, Mood } from '../music/library';
import {
  uploadAudioToMinio,
  uploadImageToMinio,
  uploadVideoToMinio,
  uploadFinalMp4,
} from '../storage/minio';
import { postprocessMp4 } from '../postprocess/ffmpeg';
import { RenderState, persist } from './render-state';
import { TempDir } from './temp-dir';

export interface PipelineInput {
  videoId: string;
}

export interface PipelineResult {
  status: 'ready' | 'failed';
  mp4Url?: string;
  durationSec?: number;
  sizeBytes?: number;
  errorMessage?: string;
}

export async function runRenderPipeline(input: PipelineInput): Promise<PipelineResult> {
  const t0 = Date.now();
  let tmp: TempDir | null = null;
  try {
    // STEP 0: Load context
    const ctx = await apiClient.getRenderContext(input.videoId);
    const state: RenderState = { ...(ctx.video.renderState as RenderState), scenarioLoaded: true };
    await persist(input.videoId, state);
    tmp = await TempDir.create(input.videoId);

    // STEP 1: Synthesize voices for each dialog turn + measure actual durations.
    // Real TTS duration can differ from Claude's tStart/tEnd estimates by 2-3 seconds.
    // We re-time the dialog later from these measured durations to avoid cropping words.
    if (!state.voicesSynthesized || state.voicesSynthesized.length !== ctx.scenario.dialog.length) {
      const urls: string[] = [];
      const durations: number[] = [];
      for (let i = 0; i < ctx.scenario.dialog.length; i++) {
        const turn = ctx.scenario.dialog[i];
        const res = await synthesize({
          tier: ctx.scenario.ttsTier,
          speaker: turn.speaker,
          role: ctx.scenario.assistantRole,
          text: turn.text,
        });
        const localPath = await writeSynthResultToFile(res, tmp.root, `voice-${i}`);
        const url = await uploadAudioToMinio(localPath, `videos/${input.videoId}/voice-${i}`);
        const dur = await probeDurationSec(localPath);
        urls.push(url);
        durations.push(dur);
        logger.info({ videoId: input.videoId, i, url, durationSec: dur }, 'voice synthesized');
      }
      state.voicesSynthesized = urls;
      state.voiceDurations = durations;
      await persist(input.videoId, state);
    } else {
      logger.info({ videoId: input.videoId }, 'voices already synthesized — skipping');
    }

    // STEP 2: B-roll — images via AI, videos via Pexels
    const aiImageUrls: string[] = state.imagesGenerated ?? [];
    const stockVideoUrls: string[] = state.stockVideosDownloaded ?? [];
    const aiImagePrompts = ctx.scenario.brollPrompts.filter((b) => b.type === 'ai_image');
    const stockPrompts = ctx.scenario.brollPrompts.filter((b) => b.type === 'stock_video');

    if (aiImageUrls.length !== aiImagePrompts.length) {
      const fresh: string[] = [];
      for (let i = 0; i < aiImagePrompts.length; i++) {
        const bytes = await generateImage({ prompt: aiImagePrompts[i].prompt, aspectRatio: '9:16' });
        const localPath = await writeImageToFile(bytes, tmp.root, `img-${i}`);
        const url = await uploadImageToMinio(localPath, `videos/${input.videoId}/img-${i}`);
        fresh.push(url);
      }
      state.imagesGenerated = fresh;
      await persist(input.videoId, state);
    }

    if (stockVideoUrls.length !== stockPrompts.length) {
      const fresh: string[] = [];
      for (let i = 0; i < stockPrompts.length; i++) {
        try {
          const match = await searchStockVideo({ query: stockPrompts[i].prompt });
          if (match) {
            const localPath = await downloadStockVideo(match.downloadUrl, tmp.root, `stock-${i}`);
            const url = await uploadVideoToMinio(localPath, `videos/${input.videoId}/stock-${i}`);
            fresh.push(url);
            continue;
          }
          // Pexels miss — try Kling text2video as fallback (+3-4 min wait per missed clip)
          logger.warn({ prompt: stockPrompts[i].prompt }, 'no stock-video match, trying Kling fallback');
          const klingUrl = await klingText2Video(stockPrompts[i].prompt);
          if (klingUrl) {
            const localPath = await downloadStockVideo(klingUrl, tmp.root, `stock-${i}`);
            const url = await uploadVideoToMinio(localPath, `videos/${input.videoId}/stock-${i}`);
            fresh.push(url);
            logger.info({ prompt: stockPrompts[i].prompt }, 'Kling fallback succeeded');
          } else {
            logger.warn({ prompt: stockPrompts[i].prompt }, 'Kling fallback also failed, skipping clip');
            fresh.push('');
          }
        } catch (err: any) {
          logger.warn({ prompt: stockPrompts[i].prompt, err: err.message }, 'stock-video step failed, skipping');
          fresh.push('');
        }
      }
      state.stockVideosDownloaded = fresh;
      await persist(input.videoId, state);
    }

    // STEP 3: Music
    const track = ctx.scenario.musicTrackId
      ? null  // explicit track id reserved for future; for MVP we always pick by mood
      : await pickTrackByMood(ctx.scenario.mood as Mood, 60);
    const musicUrl = track ? track.publicUrl : null;

    // STEP 4: Build Remotion props
    // Re-time dialog using measured TTS durations so words don't get cropped.
    // Each turn: tStart = previous tEnd + 0.4s pause; tEnd = tStart + actualVoiceDur + 0.1s tail
    // First turn starts at original tStart (Claude's intro budget, usually 2s).
    const voiceDurations = state.voiceDurations ?? [];
    const TURN_PAUSE = 0.4;
    const TURN_TAIL = 0.15;
    const FIRST_TURN_START = ctx.scenario.dialog[0]?.tStart ?? 2;
    let cursor = FIRST_TURN_START;
    const dialog = ctx.scenario.dialog.map((t, i) => {
      const tStart = i === 0 ? FIRST_TURN_START : cursor;
      const dur = (voiceDurations[i] && voiceDurations[i] > 0)
        ? voiceDurations[i]
        : t.tEnd - t.tStart;
      const tEnd = tStart + dur + TURN_TAIL;
      cursor = tEnd + TURN_PAUSE;
      return {
        speaker: t.speaker,
        text: t.text,
        tStart,
        tEnd,
        voiceUrl: state.voicesSynthesized![i],
      };
    });
    if (voiceDurations.length > 0) {
      logger.info(
        { videoId: input.videoId, voiceDurations, retimed: dialog.map((d) => [d.tStart, d.tEnd]) },
        're-timed dialog using actual TTS durations',
      );
    }

    // Dynamic video duration: stop ~5 sec after the last dialog turn (5 sec for CTA).
    // No more dead silence padding to a hardcoded 60 sec.
    const maxDialogEnd = Math.max(
      0,
      ...ctx.scenario.dialog.map((t) => t.tEnd),
    );
    const CTA_DURATION = 5;
    const totalDurationSec = Math.min(
      60,
      Math.max(30, Math.ceil(maxDialogEnd) + CTA_DURATION),
    );
    const ctaStartsAt = totalDurationSec - CTA_DURATION;

    // Each b-roll fills the visual until the next b-roll starts, or until
    // CTA (last 5s) for the final one. Prevents blank gradient gaps between
    // dialog turns. B-rolls scheduled after totalDurationSec are skipped.
    const brollsSorted = [...ctx.scenario.brollPrompts]
      .filter((b) => b.atSec < ctaStartsAt)
      .sort((a, b) => a.atSec - b.atSec);
    const broll = brollsSorted
      .map((b, i) => {
        const isAi = b.type === 'ai_image';
        const mediaUrl = isAi
          ? state.imagesGenerated![aiImagePrompts.findIndex((x) => x === b)]
          : state.stockVideosDownloaded![stockPrompts.findIndex((x) => x === b)];
        const nextAt = i + 1 < brollsSorted.length ? brollsSorted[i + 1].atSec : ctaStartsAt;
        const durationSec = Math.max(3, nextAt - b.atSec);
        return {
          atSec: b.atSec,
          durationSec,
          mediaUrl: mediaUrl || '',
          type: (isAi ? 'image' : 'video') as 'image' | 'video',
        };
      })
      .filter((b) => b.mediaUrl);

    const subtitles = dialog.flatMap((d) => chunkSubtitles(d.text, d.tStart, d.tEnd));
    const remotionProps = {
      title: ctx.scenario.title,
      assistantRole: ctx.scenario.assistantRole,
      mood: ctx.scenario.mood,
      dialog,
      broll,
      subtitles,
      musicUrl,
      totalDurationSec,
    };

    // STEP 5: Remotion render
    // __dirname is worker/dist/render/ at runtime, so remotion/ is two levels up then into remotion/
    const remotionRoot = path.join(__dirname, '..', '..', 'remotion', 'src', 'Root.tsx');
    const rawMp4 = tmp.file('render-raw.mp4');
    if (!state.remotionRendered) {
      logger.info({ videoId: input.videoId, remotionRoot }, 'remotion render start');
      const bundled = await bundle({ entryPoint: remotionRoot });
      const composition = await selectComposition({
        serveUrl: bundled,
        id: 'ChatCase',
        inputProps: remotionProps as unknown as Record<string, unknown>,
      });
      await renderMedia({
        composition,
        serveUrl: bundled,
        codec: 'h264',
        outputLocation: rawMp4,
        inputProps: remotionProps as unknown as Record<string, unknown>,
      });
      state.remotionRendered = true;
      await persist(input.videoId, state);
    }

    // STEP 6: ffmpeg post-process
    const finalMp4 = tmp.file('final.mp4');
    if (!state.postprocessed) {
      await postprocessMp4(rawMp4, finalMp4);
      state.postprocessed = true;
      await persist(input.videoId, state);
    }

    // STEP 7: Upload to MinIO
    let mp4Url = state.uploadedToMinio;
    if (!mp4Url) {
      mp4Url = await uploadFinalMp4(finalMp4, `videos/${input.videoId}/final.mp4`);
      state.uploadedToMinio = mp4Url;
      await persist(input.videoId, state);
    }
    const stat = await fs.stat(finalMp4);

    const elapsedSec = Math.round((Date.now() - t0) / 1000);
    logger.info(
      { videoId: input.videoId, mp4Url, elapsedSec, sizeBytes: stat.size },
      'render pipeline complete',
    );

    return {
      status: 'ready',
      mp4Url,
      durationSec: totalDurationSec,
      sizeBytes: stat.size,
    };
  } catch (err: any) {
    logger.error({ videoId: input.videoId, err: err.message }, 'render pipeline failed');
    return { status: 'failed', errorMessage: err.message };
  } finally {
    // Keep /tmp/smm-job-* on failure for 7 days (cleanup-cron handles aging).
    // No explicit cleanup here.
  }
}
