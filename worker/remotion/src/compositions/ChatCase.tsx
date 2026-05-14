// worker/remotion/src/compositions/ChatCase.tsx
import { AbsoluteFill } from 'remotion';
import { CaseVideoProps } from '../types';
import { ChatBubble } from '../components/ChatBubble';
import { BRollImage } from '../components/BRollImage';
import { BRollVideo } from '../components/BRollVideo';
import { Subtitle } from '../components/Subtitle';
import { CTA } from '../components/CTA';
import { BackgroundMusic } from '../components/BackgroundMusic';

export const defaultProps: CaseVideoProps = {
  title: 'Sample',
  assistantRole: 'psy',
  mood: 'neutral',
  dialog: [],
  broll: [],
  subtitles: [],
  musicUrl: null,
  totalDurationSec: 60,
};

export const ChatCase: React.FC<CaseVideoProps> = (props) => {
  // CTA always covers the last 5 seconds
  const ctaAt = Math.max(0, props.totalDurationSec - 5);

  return (
    <AbsoluteFill style={{ background: 'linear-gradient(180deg, #1a1a2e 0%, #0f3460 50%, #16213e 100%)' }}>
      {/* Layer 1: B-roll (background) */}
      {props.broll.map((b, i) =>
        b.type === 'image' ? (
          <BRollImage key={`b-${i}`} {...b} />
        ) : (
          <BRollVideo key={`b-${i}`} {...b} />
        ),
      )}

      {/* Layer 2: Chat dialog bubbles */}
      {props.dialog.map((d, i) => (
        <ChatBubble key={`d-${i}`} {...d} />
      ))}

      {/* Layer 3: Subtitles */}
      {props.subtitles.map((s, i) => (
        <Subtitle key={`s-${i}`} {...s} />
      ))}

      {/* Layer 4: CTA overlay last 5s */}
      <CTA atSec={ctaAt} durationSec={5} />

      {/* Layer 5: Background music */}
      {props.musicUrl ? <BackgroundMusic src={props.musicUrl} volume={0.15} /> : null}
    </AbsoluteFill>
  );
};
