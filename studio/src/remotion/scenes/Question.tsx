import React from 'react';
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { C, fontFamily } from '../theme';

/** Задача: снимок чата с вопросом и лёгкое приближение; у реального кейса — подпись сверху. */
export const Question: React.FC<{ questionShot: string; durationInFrames: number; badge?: string }> = ({
  questionShot,
  durationInFrames,
  badge,
}) => {
  const frame = useCurrentFrame();
  const zoom = interpolate(frame, [0, Math.max(1, durationInFrames)], [1, 1.06], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ backgroundColor: C.white }}>
      <Img
        src={staticFile(questionShot)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${zoom})`, transformOrigin: '50% 70%' }}
      />
      {badge ? (
        <div
          style={{
            position: 'absolute',
            top: 140,
            left: 60,
            right: 60,
            padding: '20px 32px',
            borderRadius: 28,
            background: C.shade,
            color: C.white,
            fontFamily,
            fontWeight: 800,
            fontSize: 40,
            lineHeight: 1.2,
            textAlign: 'center',
          }}
        >
          {badge}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
