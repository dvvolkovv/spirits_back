// worker/remotion/src/components/CTA.tsx
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { AssistantRole } from '../types';

interface Props {
  atSec: number;
  durationSec: number;
  assistantRole: AssistantRole;
}

const ROLE_HEADLINE: Record<string, string> = {
  psy: 'ИИ-психолог',
  coach: 'ИИ-коуч',
  lawyer: 'ИИ-юрист',
  accountant: 'ИИ-бухгалтер',
  marketer: 'ИИ-маркетолог',
  hr: 'ИИ-HR-эксперт',
  business: 'ИИ-бизнес-эксперт',
  copywriter: 'ИИ-копирайтер',
  astrologer: 'ИИ-астролог',
  numerologist: 'ИИ-нумеролог',
  humandesign: 'ИИ-Human Design',
  gamepractic: 'ИИ-игропрактик',
  mindfulness: 'ИИ-наставник осознанности',
  assistant: 'ИИ-ассистент',
};

export const CTA: React.FC<Props> = ({ atSec, durationSec, assistantRole }) => {
  const headline = ROLE_HEADLINE[assistantRole] ?? 'ИИ-ассистент Linkeon';
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const startFrame = Math.round(atSec * fps);
  const durFrames = Math.round(durationSec * fps);
  const localFrame = frame - startFrame;

  const scale = interpolate(localFrame, [0, 10], [0.8, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const opacity = interpolate(localFrame, [0, 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <Sequence from={startFrame} durationInFrames={durFrames}>
      <AbsoluteFill
        style={{
          background: 'rgba(15, 23, 42, 0.95)',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 40,
          opacity,
        }}
      >
        <div style={{ transform: `scale(${scale})` }}>
          <div
            style={{
              fontSize: 72,
              fontWeight: 800,
              color: '#fbbf24',
              fontFamily: 'sans-serif',
              textAlign: 'center',
            }}
          >
            {headline}
          </div>
          <div
            style={{
              fontSize: 56,
              fontWeight: 700,
              color: '#ffffff',
              marginTop: 24,
              textAlign: 'center',
            }}
          >
            всегда на связи
          </div>
          <div
            style={{
              marginTop: 60,
              padding: '24px 48px',
              background: '#fbbf24',
              color: '#0f172a',
              fontSize: 52,
              fontWeight: 800,
              borderRadius: 16,
              fontFamily: 'sans-serif',
            }}
          >
            my.linkeon.io
          </div>
        </div>
      </AbsoluteFill>
    </Sequence>
  );
};
