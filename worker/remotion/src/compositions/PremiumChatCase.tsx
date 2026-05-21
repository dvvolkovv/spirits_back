// worker/remotion/src/compositions/PremiumChatCase.tsx
// Премиум-вариант ChatCase: фоном идут kling-клипы (Video) + Imagen-кадры (Img),
// каждый ограничен своим временным окном через <Sequence>. Остальные слои
// (диалог, субтитры, CTA, музыка) — как в ChatCase.
import { AbsoluteFill, Img, Video, Sequence } from 'remotion';
import { CaseVideoProps } from '../types';
import { ChatBubble } from '../components/ChatBubble';
import { Subtitle } from '../components/Subtitle';
import { CTA } from '../components/CTA';
import { BackgroundMusic } from '../components/BackgroundMusic';

const FPS = 30;
const DEFAULT_BG = 'linear-gradient(180deg, #1a1a2e 0%, #0f3460 50%, #16213e 100%)';

export const defaultProps: CaseVideoProps = {
  title: 'Premium Sample',
  assistantRole: 'psy',
  mood: 'neutral',
  dialog: [],
  broll: [],
  subtitles: [],
  musicUrl: null,
  totalDurationSec: 30,
  isLinkeonOfficial: true,
  ctaHandle: undefined,
  ctaLabel: undefined,
  premiumScenes: [],
};

export const PremiumChatCase: React.FC<CaseVideoProps> = (props) => {
  const ctaAt = Math.max(0, props.totalDurationSec - 5);
  const scenes = props.premiumScenes ?? [];

  // Fallback background — за пределами premium-сцен или если scenes пуст.
  const useBgImage = !!props.bgImageUrl;
  const bgStyle = useBgImage
    ? { background: '#000' }
    : { background: props.bgColor || DEFAULT_BG };

  return (
    <AbsoluteFill style={bgStyle}>
      {/* Layer 0a: Fallback bg image (если задана) — под premium-сценами */}
      {useBgImage && (
        <Img
          src={props.bgImageUrl!}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}

      {/* Layer 0b: Premium-сцены — kling видео или Imagen-картинка, каждая в своём <Sequence> */}
      {scenes.map((s, i) => (
        <Sequence
          key={`pscene-${i}`}
          from={Math.round(s.atSec * FPS)}
          durationInFrames={Math.round(s.durationSec * FPS)}
        >
          <AbsoluteFill>
            {s.type === 'kling' ? (
              <Video
                src={s.mediaUrl}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                muted
              />
            ) : (
              <Img
                src={s.mediaUrl}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            )}
          </AbsoluteFill>
        </Sequence>
      ))}

      {/* Layer 1: Chat dialog bubbles */}
      {props.dialog.map((d, i) => (
        <ChatBubble key={`d-${i}`} {...d} />
      ))}

      {/* Layer 2: Subtitles */}
      {props.subtitles.map((s, i) => (
        <Subtitle key={`s-${i}`} {...s} />
      ))}

      {/* Layer 3: CTA */}
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

      {/* Layer 4: Background music */}
      {props.musicUrl ? <BackgroundMusic src={props.musicUrl} volume={0.15} /> : null}
    </AbsoluteFill>
  );
};
