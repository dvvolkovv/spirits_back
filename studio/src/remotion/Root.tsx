import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import type { ShortProps, SkitShortProps } from '../types';
import { Short } from './Short';
import { SkitShort } from './SkitShort';
import { H, W } from './theme';

/** Длина ролика — из таймлайна в пропсах: её задаёт озвучка (и клипы сценок). */
const calculateMetadata: CalculateMetadataFunction<ShortProps> = ({ props }) => ({
  durationInFrames: props.timeline.totalFrames,
  fps: props.fps,
});
const calculateSkitMetadata: CalculateMetadataFunction<SkitShortProps> = ({ props }) => ({
  durationInFrames: props.timeline.totalFrames,
  fps: props.fps,
});

/** Пропсы-заглушки. Настоящие приходят из src/render/run-render.ts. */
const PLACEHOLDER: ShortProps = {
  fps: 30,
  hook: 'Зацепка',
  questionShot: 'question.png',
  answerShot: 'answer.png',
  answerShotHeight: 1920,
  boxes: [{ n: 1, top: 400, height: 200, text: '' }],
  timeline: {
    segments: [],
    scenes: {
      hook: { from: 0, duration: 60 },
      question: { from: 60, duration: 90 },
      answer: { from: 150, duration: 600 },
      final: { from: 750, duration: 150 },
    },
    totalFrames: 900,
  },
  final: { assistantsCount: 18 },
};

const SKIT_PLACEHOLDER: SkitShortProps = {
  fps: 30,
  hook: 'Зацепка',
  questionShot: 'question.png',
  answerShot: 'answer.png',
  answerShotHeight: 1920,
  boxes: [{ n: 1, top: 400, height: 200, text: '' }],
  timeline: {
    segments: [],
    scenes: {
      conflict: { from: 0, duration: 240 },
      question: { from: 240, duration: 120 },
      answer: { from: 360, duration: 360 },
      punchline: { from: 720, duration: 240 },
      final: { from: 960, duration: 120 },
    },
    totalFrames: 1080,
  },
  final: { assistantsCount: 18 },
  clips: { conflict: { video: 'conflict.mp4', cues: [] }, punchline: { video: 'punchline.mp4', cues: [] } },
};

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="Short"
      component={Short}
      width={W}
      height={H}
      fps={30}
      durationInFrames={PLACEHOLDER.timeline.totalFrames}
      defaultProps={PLACEHOLDER}
      calculateMetadata={calculateMetadata}
    />
    <Composition
      id="SkitShort"
      component={SkitShort}
      width={W}
      height={H}
      fps={30}
      durationInFrames={SKIT_PLACEHOLDER.timeline.totalFrames}
      defaultProps={SKIT_PLACEHOLDER}
      calculateMetadata={calculateSkitMetadata}
    />
  </>
);
