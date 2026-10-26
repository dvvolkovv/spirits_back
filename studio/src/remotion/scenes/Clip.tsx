import React from 'react';
import { AbsoluteFill, OffthreadVideo, Sequence, staticFile } from 'remotion';
import { HookText } from './Hook';

/**
 * Сценка — клип Omni на весь кадр (720×1280 растягивается до 1080×1920),
 * со своим звуком. У конфликта первые секунды поверх идёт надпись-зацепка:
 * в верхней трети, выше субтитров реплик.
 */
export const Clip: React.FC<{ video: string; hook?: string; hookFrames?: number }> = ({ video, hook, hookFrames = 0 }) => (
  <AbsoluteFill style={{ backgroundColor: '#000' }}>
    <OffthreadVideo src={staticFile(video)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    {hook && hookFrames > 0 ? (
      <Sequence durationInFrames={hookFrames}>
        <AbsoluteFill
          style={{
            justifyContent: 'flex-start',
            alignItems: 'center',
            padding: '260px 90px 0',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 45%)',
          }}
        >
          <HookText text={hook} />
        </AbsoluteFill>
      </Sequence>
    ) : null}
  </AbsoluteFill>
);
