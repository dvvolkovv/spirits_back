// worker/remotion/src/compositions/ChatCase.tsx
import { AbsoluteFill, Img } from 'remotion';
import { CaseVideoProps } from '../types';
import { ChatBubble } from '../components/ChatBubble';
import { BRollImage } from '../components/BRollImage';
import { BRollVideo } from '../components/BRollVideo';
import { Subtitle } from '../components/Subtitle';
import { CTA } from '../components/CTA';
import { BackgroundMusic } from '../components/BackgroundMusic';

const DEFAULT_BG = 'linear-gradient(180deg, #1a1a2e 0%, #0f3460 50%, #16213e 100%)';

export const defaultProps: CaseVideoProps = {
  title: 'Sample',
  assistantRole: 'psy',
  mood: 'neutral',
  dialog: [],
  broll: [],
  subtitles: [],
  musicUrl: null,
  totalDurationSec: 60,
  isLinkeonOfficial: true,
  ctaHandle: undefined,
  ctaLabel: undefined,
};

export const ChatCase: React.FC<CaseVideoProps> = (props) => {
  // CTA always covers the last 5 seconds
  const ctaAt = Math.max(0, props.totalDurationSec - 5);

  // Background precedence (creator-mode):
  // 1. bgImageUrl — Remotion <Img> covers the whole frame (waits for image load)
  // 2. bgColor — CSS color/gradient string passed straight to style.background
  // 3. default forest gradient
  const useBgImage = !!props.bgImageUrl;
  const bgStyle = useBgImage
    ? { background: '#000' } // placeholder behind the <Img>
    : { background: props.bgColor || DEFAULT_BG };

  return (
    <AbsoluteFill style={bgStyle}>
      {/* Layer 0: Background image (if uploaded) — sits below everything else */}
      {useBgImage && (
        <Img
          src={props.bgImageUrl!}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      )}

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
      <CTA
        atSec={ctaAt}
        durationSec={5}
        assistantRole={props.assistantRole}
        isLinkeonOfficial={props.isLinkeonOfficial}
        ctaHandle={props.ctaHandle}
        ctaLabel={props.ctaLabel}
        logoUrl={props.logoUrl}
        ctaSlogan={props.ctaSlogan}
      />

      {/* Layer 5: Background music */}
      {props.musicUrl ? <BackgroundMusic src={props.musicUrl} volume={0.15} /> : null}
    </AbsoluteFill>
  );
};
