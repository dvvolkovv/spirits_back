import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { captionCues, splitCaption } from '../captions';
import type { Segment } from '../types';
import { C, fontFamily } from './theme';

/**
 * Субтитры реплик: крупно, в средней трети кадра — снизу и справа Shorts и
 * Клипы рисуют свои кнопки и подпись.
 */
export const Captions: React.FC<{ segments: Segment[] }> = ({ segments }) => (
  <>
    {segments.flatMap((s) =>
      captionCues(splitCaption(s.text), s.from, s.duration).map((cue, i) => (
        <Sequence key={`${s.lineId}-${i}`} from={cue.from} durationInFrames={cue.duration}>
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
              {cue.text}
            </div>
          </AbsoluteFill>
        </Sequence>
      )),
    )}
  </>
);
