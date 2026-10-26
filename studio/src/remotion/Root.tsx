import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import type { ShortProps } from '../types';
import { Short } from './Short';
import { H, W } from './theme';

/** Длина ролика — из таймлайна в пропсах: её задаёт озвучка. */
const calculateMetadata: CalculateMetadataFunction<ShortProps> = ({ props }) => ({
  durationInFrames: props.timeline.totalFrames,
  fps: props.fps,
});

/** Пропсы-заглушка. Настоящие приходят из src/render/run-render.ts. */
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

export const RemotionRoot: React.FC = () => (
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
);
