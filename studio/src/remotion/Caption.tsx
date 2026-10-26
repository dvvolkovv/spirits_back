import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { captionCues, splitCaption } from '../captions';
import type { ClipCue, Segment } from '../types';
import { C, fontFamily } from './theme';

/**
 * Субтитр: крупно, в средней трети кадра — снизу и справа Shorts и Клипы
 * рисуют свои кнопки и подпись.
 */
const CaptionBox: React.FC<{ text: string }> = ({ text }) => (
  <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', padding: '0 160px 560px 80px' }}>
    <div
      style={{
        fontFamily,
        fontWeight: 900,
        fontSize: 62,
        lineHeight: 1.15,
        color: C.white,
        background: C.shade,
        borderRadius: 28,
        padding: '18px 30px',
        textAlign: 'center',
      }}
    >
      {text}
    </div>
  </AbsoluteFill>
);

/** Субтитры с готовыми кадрами: реплики сценок и, через Captions, озвученные реплики. */
export const CueCaptions: React.FC<{ cues: ClipCue[] }> = ({ cues }) => (
  <>
    {cues.map((c) => (
      <Sequence key={c.key} from={c.from} durationInFrames={c.duration}>
        <CaptionBox text={c.text} />
      </Sequence>
    ))}
  </>
);

/** Субтитры озвученных реплик: длинная режется на куски по словам. */
export const Captions: React.FC<{ segments: Segment[] }> = ({ segments }) => (
  <CueCaptions
    cues={segments.flatMap((s) => captionCues(splitCaption(s.text), s.from, s.duration).map((cue, i) => ({ key: `${s.lineId}-${i}`, ...cue })))}
  />
);
