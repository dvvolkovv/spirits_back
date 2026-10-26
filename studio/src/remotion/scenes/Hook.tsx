import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, fontFamily } from '../theme';

/** Зацепка: снимок вопроса под затемнением, поверх — крупный текст. */
export const Hook: React.FC<{ hook: string; questionShot: string }> = ({ hook, questionShot }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 14 } });
  return (
    <AbsoluteFill style={{ backgroundColor: C.ink }}>
      <Img src={staticFile(questionShot)} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.3 }} />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 90px' }}>
        <div
          style={{
            fontFamily,
            fontWeight: 900,
            fontSize: 92,
            lineHeight: 1.08,
            color: C.white,
            textAlign: 'center',
            textShadow: '0 6px 24px rgba(0,0,0,0.45)',
            transform: `scale(${interpolate(pop, [0, 1], [0.85, 1])})`,
          }}
        >
          {hook}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
