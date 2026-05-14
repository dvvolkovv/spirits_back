// worker/remotion/src/components/Subtitle.tsx
import { Sequence, useVideoConfig } from 'remotion';
import { SubtitleChunkProps } from '../types';

export const Subtitle: React.FC<SubtitleChunkProps> = (props) => {
  const { fps } = useVideoConfig();
  const startFrame = Math.round(props.tStart * fps);
  const durFrames = Math.max(1, Math.round((props.tEnd - props.tStart) * fps));

  return (
    <Sequence from={startFrame} durationInFrames={durFrames}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 280,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            background: 'rgba(0,0,0,0.85)',
            color: '#ffffff',
            padding: '20px 36px',
            borderRadius: 20,
            fontSize: 56,
            fontWeight: 700,
            maxWidth: 900,
            textAlign: 'center',
            lineHeight: 1.2,
            fontFamily: 'sans-serif',
            textShadow: '0 2px 6px rgba(0,0,0,0.6)',
          }}
        >
          {props.text}
        </div>
      </div>
    </Sequence>
  );
};
