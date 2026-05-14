// worker/remotion/src/components/ChatBubble.tsx
import { Audio, interpolate, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { DialogTurnProps } from '../types';

interface Props extends DialogTurnProps {}

export const ChatBubble: React.FC<Props> = (props) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const startFrame = Math.round(props.tStart * fps);
  const durFrames = Math.round((props.tEnd - props.tStart) * fps);
  const localFrame = frame - startFrame;

  const isHero = props.speaker === 'hero';

  // Fade-in 0.2s
  const opacity = interpolate(localFrame, [0, 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // Slide-in 8px
  const offsetY = interpolate(localFrame, [0, 6], [8, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <Sequence from={startFrame} durationInFrames={durFrames}>
      <Audio src={props.voiceUrl} volume={1.0} />
      <div
        style={{
          position: 'absolute',
          top: 200,
          left: isHero ? 80 : 'auto',
          right: isHero ? 'auto' : 80,
          maxWidth: 800,
          padding: '32px 40px',
          borderRadius: 36,
          background: isHero ? '#3b82f6' : '#ffffff',
          color: isHero ? '#ffffff' : '#0f172a',
          fontSize: 44,
          fontWeight: 500,
          lineHeight: 1.3,
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          opacity,
          transform: `translateY(${offsetY}px)`,
          fontFamily: 'sans-serif',
        }}
      >
        {props.text}
      </div>
    </Sequence>
  );
};
