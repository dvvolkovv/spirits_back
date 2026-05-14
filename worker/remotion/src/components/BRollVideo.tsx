// worker/remotion/src/components/BRollVideo.tsx
import { AbsoluteFill, OffthreadVideo, interpolate, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { BrollProps } from '../types';

export const BRollVideo: React.FC<BrollProps> = (props) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const startFrame = Math.round(props.atSec * fps);
  const durFrames = Math.round(props.durationSec * fps);
  const localFrame = frame - startFrame;

  const fadeIn = interpolate(localFrame, [0, 8], [0, 1], { extrapolateRight: 'clamp' });
  const fadeOut = interpolate(localFrame, [durFrames - 8, durFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const opacity = Math.min(fadeIn, fadeOut);

  return (
    <Sequence from={startFrame} durationInFrames={durFrames}>
      <AbsoluteFill style={{ overflow: 'hidden', opacity }}>
        <OffthreadVideo
          src={props.mediaUrl}
          muted
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </AbsoluteFill>
    </Sequence>
  );
};
