#!/usr/bin/env ts-node
// worker/remotion/scripts/smoke-render.ts
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import * as path from 'path';
import { CaseVideoProps } from '../src/types';

async function main() {
  const out = process.argv[2] || '/tmp/smm-smoke-render.mp4';

  const props: CaseVideoProps = {
    title: 'Кейс: тревога перед сном',
    assistantRole: 'psy',
    mood: 'calm',
    dialog: [
      {
        speaker: 'hero',
        text: 'Не могу уснуть, мысли крутятся.',
        tStart: 3,
        tEnd: 8,
        voiceUrl: 'https://my.linkeon.io/smm-media/linkeon-smm-music/calm.mp3',
      },
      {
        speaker: 'assistant',
        text: 'Давай попробуем технику 4-7-8 — дыхание поможет успокоиться.',
        tStart: 9,
        tEnd: 20,
        voiceUrl: 'https://my.linkeon.io/smm-media/linkeon-smm-music/calm.mp3',
      },
    ],
    broll: [
      {
        atSec: 0,
        durationSec: 3,
        mediaUrl: 'https://images.unsplash.com/photo-1455642305367-68834a9c8db0?w=1080',
        type: 'image',
      },
    ],
    subtitles: [
      { text: 'Не могу уснуть', tStart: 3, tEnd: 5.5 },
      { text: 'мысли крутятся', tStart: 5.5, tEnd: 8 },
      { text: 'Техника 4-7-8', tStart: 9, tEnd: 14 },
      { text: 'дыхание успокоит', tStart: 14, tEnd: 20 },
    ],
    musicUrl: 'https://my.linkeon.io/smm-media/linkeon-smm-music/calm.mp3',
    totalDurationSec: 30,
  };

  console.log('Bundling...');
  const bundled = await bundle({ entryPoint: path.join(__dirname, '..', 'src', 'Root.tsx') });
  console.log('Selecting composition...');
  const inputProps = props as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl: bundled, id: 'ChatCase', inputProps });
  console.log(`Rendering ${composition.durationInFrames} frames @ ${composition.fps}fps...`);
  await renderMedia({
    composition,
    serveUrl: bundled,
    codec: 'h264',
    outputLocation: out,
    inputProps,
  });
  console.log(`Done: ${out}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
