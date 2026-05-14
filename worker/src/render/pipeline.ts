// worker/src/render/pipeline.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { apiClient } from '../api-client';
import { logger } from '../logger';
import { synthesize, writeSynthResultToFile } from '../tts';
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

    // STEP 1: Synthesize voices for each dialog turn
    if (!state.voicesSynthesized || state.voicesSynthesized.length !== ctx.scenario.dialog.length) {
      const urls: string[] = [];
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
        urls.push(url);
        logger.info({ videoId: input.videoId, i, url }, 'voice synthesized');
      }
      state.voicesSynthesized = urls;
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
          if (!match) {
            logger.warn({ prompt: stockPrompts[i].prompt }, 'no stock-video match, skipping');
            fresh.push('');
            continue;
          }
          const localPath = await downloadStockVideo(match.downloadUrl, tmp.root, `stock-${i}`);
          const url = await uploadVideoToMinio(localPath, `videos/${input.videoId}/stock-${i}`);
          fresh.push(url);
        } catch (err: any) {
          // Pexels missing API key etc. — gracefully degrade by skipping this clip
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
    const dialog = ctx.scenario.dialog.map((t, i) => ({
      speaker: t.speaker,
      text: t.text,
      tStart: t.tStart,
      tEnd: t.tEnd,
      voiceUrl: state.voicesSynthesized![i],
    }));

    const broll = ctx.scenario.brollPrompts
      .map((b, i) => {
        const isAi = b.type === 'ai_image';
        const mediaUrl = isAi
          ? state.imagesGenerated![aiImagePrompts.findIndex((x) => x === b)]
          : state.stockVideosDownloaded![stockPrompts.findIndex((x) => x === b)];
        return {
          atSec: b.atSec,
          durationSec: 3,
          mediaUrl: mediaUrl || '',
          type: (isAi ? 'image' : 'video') as 'image' | 'video',
        };
      })
      .filter((b) => b.mediaUrl);

    const subtitles = dialog.flatMap((d) => chunkSubtitles(d.text, d.tStart, d.tEnd));

    const totalDurationSec = 60;
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
