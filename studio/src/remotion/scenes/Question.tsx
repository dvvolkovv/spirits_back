import React from 'react';
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { C } from '../theme';

/** Задача: снимок чата с вопросом и лёгкое приближение. */
export const Question: React.FC<{ questionShot: string; durationInFrames: number }> = ({ questionShot, durationInFrames }) => {
  const frame = useCurrentFrame();
  const zoom = interpolate(frame, [0, Math.max(1, durationInFrames)], [1, 1.06], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ backgroundColor: C.white }}>
      <Img
        src={staticFile(questionShot)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${zoom})`, transformOrigin: '50% 70%' }}
      />
    </AbsoluteFill>
  );
};
