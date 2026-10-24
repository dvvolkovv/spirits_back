import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { panOffset } from '../../pan';
import type { ImageBox, Segment } from '../../types';
import { ANCHOR_Y, C, H, W } from '../theme';

/** Кадров на переезд к следующему абзацу. */
const MOVE = 15;
/** Пик приближения абзаца. */
const ZOOM = 1.08;
/**
 * Отступ рамки от краёв скриншота. На пике приближения край рамки уходит
 * наружу; чтобы он остался в кадре, нужно ≥ (W/2)·(1 − 1/ZOOM) = 40 px. Берём 60 — с запасом.
 */
const RING_INSET = 60;
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/**
 * Ответ: высокий скриншот едет к абзацу, о котором говорит голос,
 * приближается к нему и обводит рамкой. segments — реплики сцены answer
 * с кадрами от начала ролика; sceneFrom переводит их в кадры сцены.
 */
export const Answer: React.FC<{
  answerShot: string;
  imageHeight: number;
  boxes: ImageBox[];
  segments: Segment[];
  sceneFrom: number;
}> = ({ answerShot, imageHeight, boxes, segments, sceneFrom }) => {
  const frame = useCurrentFrame();
  if (segments.length === 0 || boxes.length === 0) return <AbsoluteFill style={{ backgroundColor: C.white }} />;

  let idx = 0;
  segments.forEach((s, i) => {
    if (s.from - sceneFrom <= frame) idx = i;
  });
  const boxOf = (s: Segment): ImageBox => boxes.find((b) => b.n === s.box) ?? boxes[0];
  const offsetOf = (s: Segment): number => {
    const b = boxOf(s);
    return panOffset({ boxTop: b.top, boxHeight: b.height, imageHeight, frameHeight: H, anchorY: ANCHOR_Y });
  };

  const seg = segments[idx];
  const t = frame - (seg.from - sceneFrom);
  const prev = idx > 0 ? offsetOf(segments[idx - 1]) : 0;
  const y = interpolate(t, [0, MOVE], [prev, offsetOf(seg)], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const hold = Math.max(MOVE + 1, seg.duration - 10);
  const stop = Math.max(hold + 1, seg.duration);
  const zoom = interpolate(t, [0, MOVE, hold, stop], [1, ZOOM, ZOOM, 1], clamp);
  const ring = interpolate(t, [MOVE, MOVE + 10], [0, 1], clamp);
  const b = boxOf(seg);

  return (
    <AbsoluteFill style={{ backgroundColor: C.white, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: W, transform: `translateY(${y}px)` }}>
        <div
          style={{
            position: 'relative',
            width: W,
            height: imageHeight,
            transform: `scale(${zoom})`,
            transformOrigin: `50% ${b.top + b.height / 2}px`,
          }}
        >
          <Img src={staticFile(answerShot)} style={{ width: W, height: imageHeight, display: 'block' }} />
          <div
            style={{
              position: 'absolute',
              left: RING_INSET,
              right: RING_INSET,
              top: b.top - 14,
              height: b.height + 28,
              borderRadius: 24,
              border: `6px solid ${C.forest600}`,
              opacity: ring,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
