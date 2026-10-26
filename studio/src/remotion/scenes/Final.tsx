import React from 'react';
import { AbsoluteFill, Img, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { assistantsLabel } from '../../plural';
import { C, fontFamily } from '../theme';

/** Финал: логотип, число ассистентов из базы, адрес и где искать ссылку. */
export const Final: React.FC<{ assistantsCount: number; disclaimer?: string }> = ({ assistantsCount, disclaimer }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12 } });
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(160deg, ${C.forest700}, ${C.forest900})`,
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily,
        color: C.white,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 300,
          height: 300,
          borderRadius: 150,
          background: C.white,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: `scale(${pop})`,
        }}
      >
        <Img src={staticFile('logo.png')} style={{ width: 240, height: 240 }} />
      </div>
      <div style={{ fontWeight: 900, fontSize: 104, marginTop: 44 }}>Linkeon</div>
      <div style={{ fontWeight: 800, fontSize: 58, marginTop: 8 }}>{assistantsLabel(assistantsCount)}</div>
      <div style={{ fontWeight: 900, fontSize: 64, marginTop: 72, color: C.forest500 }}>my.linkeon.io</div>
      <div style={{ fontWeight: 700, fontSize: 44, marginTop: 18 }}>Ссылка — в описании и в профиле</div>
      {disclaimer ? (
        <div style={{ position: 'absolute', bottom: 140, left: 80, right: 80, fontWeight: 700, fontSize: 34, opacity: 0.85 }}>
          {disclaimer}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
