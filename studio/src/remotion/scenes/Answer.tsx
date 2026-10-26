import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import { RING_INSET, answerMotion } from '../../answer-motion';
import type { ImageBox, Segment } from '../../types';
import { ANCHOR_Y, C, H, W } from '../theme';

/**
 * Ответ: высокий снимок едет к абзацу, о котором говорит голос, приближается к
 * нему и обводит рамкой. Расчёт движения — answer-motion.ts (с тестами).
 */
export const Answer: React.FC<{
  answerShot: string;
  imageHeight: number;
  boxes: ImageBox[];
  segments: Segment[];
  sceneFrom: number;
}> = ({ answerShot, imageHeight, boxes, segments, sceneFrom }) => {
  const frame = useCurrentFrame();
  const m = answerMotion({ frame, segments, sceneFrom, boxes, imageHeight, frameHeight: H, anchorY: ANCHOR_Y });
  if (!m) return <AbsoluteFill style={{ backgroundColor: C.white }} />;

  return (
    <AbsoluteFill style={{ backgroundColor: C.white, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: W, transform: `translateY(${m.y}px)` }}>
        <div
          style={{
            position: 'relative',
            width: W,
            height: imageHeight,
            transform: `scale(${m.zoom})`,
            transformOrigin: `50% ${m.box.top + m.box.height / 2}px`,
          }}
        >
          <Img src={staticFile(answerShot)} style={{ width: W, height: imageHeight, display: 'block' }} />
          <div
            style={{
              position: 'absolute',
              left: RING_INSET,
              right: RING_INSET,
              top: m.box.top - 14,
              height: m.box.height + 28,
              borderRadius: 24,
              border: `6px solid ${C.forest600}`,
              opacity: m.ring,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
