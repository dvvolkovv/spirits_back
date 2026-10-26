import React from 'react';
import { AbsoluteFill, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { HookText } from './Hook';

/** Кадров, за которые гаснет зацепка: резко пропавшее затемнение дёргает верх кадра. */
const HOOK_FADE_FRAMES = 8;

/** Надпись-зацепка в верхней трети, выше субтитров реплик; к концу своего времени гаснет. */
const HookOverlay: React.FC<{ text: string; frames: number }> = ({ text, frames }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [frames - HOOK_FADE_FRAMES, frames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-start',
        alignItems: 'center',
        padding: '260px 90px 0',
        background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 45%)',
        opacity,
      }}
    >
      <HookText text={text} />
    </AbsoluteFill>
  );
};

/**
 * Сценка — клип Omni на весь кадр (720×1280 масштабируется до 1080×1920,
 * objectFit: cover), со своим звуком. У конфликта первые секунды поверх идёт
 * надпись-зацепка.
 */
export const Clip: React.FC<{ video: string; hook?: string; hookFrames?: number }> = ({ video, hook, hookFrames = 0 }) => (
  <AbsoluteFill style={{ backgroundColor: '#000' }}>
    <OffthreadVideo src={staticFile(video)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    {hook && hookFrames > 0 ? (
      <Sequence durationInFrames={hookFrames}>
        <HookOverlay text={hook} frames={hookFrames} />
      </Sequence>
    ) : null}
  </AbsoluteFill>
);
