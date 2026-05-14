// worker/remotion/src/components/BRollImage.tsx
import { AbsoluteFill, Img, interpolate, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { BrollProps } from '../types';

export const BRollImage: React.FC<BrollProps> = (props) => {
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

  // Ken-burns zoom 1.0 → 1.08
  const scale = interpolate(localFrame, [0, durFrames], [1.0, 1.08], { extrapolateRight: 'clamp' });

  return (
    <Sequence from={startFrame} durationInFrames={durFrames}>
      <AbsoluteFill style={{ overflow: 'hidden', opacity }}>
        <Img
          src={props.mediaUrl}
          style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${scale})` }}
        />
      </AbsoluteFill>
    </Sequence>
  );
};
