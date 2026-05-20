// worker/remotion/src/components/CTA.tsx
import { AbsoluteFill, Img, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { AssistantRole } from '../types';

interface Props {
  atSec: number;
  durationSec: number;
  assistantRole: AssistantRole;
  isLinkeonOfficial: boolean;
  ctaHandle?: string;
  ctaLabel?: string;
  /** Creator-mode: uploaded logo URL — replaces Linkeon-logo in centre. */
  logoUrl?: string;
  /** Creator-mode: short slogan between logo and handle. */
  ctaSlogan?: string;
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

// Linkeon brand palette (matches tailwind.config: forest-*)
const FOREST_500 = '#4ade80';
const FOREST_600 = '#2dd4bf';
const FOREST_700 = '#0d9488';
const FOREST_900 = '#134e4a';

export const CTA: React.FC<Props> = ({
  atSec,
  durationSec,
  assistantRole,
  isLinkeonOfficial,
  ctaHandle,
  ctaLabel,
  logoUrl,
  ctaSlogan,
}) => {
  const headline = ROLE_HEADLINE[assistantRole] ?? 'ИИ-ассистент Linkeon';
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const startFrame = Math.round(atSec * fps);
  const durFrames = Math.round(durationSec * fps);
  const localFrame = frame - startFrame;

  const scale = interpolate(localFrame, [0, 10], [0.85, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const opacity = interpolate(localFrame, [0, 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // Logo gets a gentle floating breath
  const logoFloat = Math.sin(localFrame / 8) * 4;

  // Shared forest gradient background — brand stays in fabric even for creator-mode
  // (это нативная реклама платформы).
  const background = (
    <>
      {/* Soft accent glow behind logo for depth */}
      <div
        style={{
          position: 'absolute',
          top: '20%',
          width: 600,
          height: 600,
          background: `radial-gradient(circle, ${FOREST_500}33 0%, transparent 70%)`,
          filter: 'blur(40px)',
        }}
      />
    </>
  );

  const officialContent = (
    <>
      <div
        style={{
          transform: `scale(${scale}) translateY(${logoFloat}px)`,
          marginBottom: 50,
          zIndex: 1,
        }}
      >
        <Img
          src={staticFile('linkeon-logo.png')}
          style={{
            width: 200,
            height: 200,
            objectFit: 'contain',
            filter: 'drop-shadow(0 8px 24px rgba(0,0,0,0.4))',
          }}
        />
      </div>

      <div
        style={{
          transform: `scale(${scale})`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          zIndex: 1,
        }}
      >
        <div
          style={{
            fontSize: 78,
            fontWeight: 800,
            color: '#ffffff',
            fontFamily: 'Inter, sans-serif',
            textAlign: 'center',
            letterSpacing: -1,
            lineHeight: 1.05,
          }}
        >
          {headline}
        </div>
        <div
          style={{
            fontSize: 48,
            fontWeight: 500,
            color: '#a7f3d0',
            marginTop: 20,
            textAlign: 'center',
            fontFamily: 'Inter, sans-serif',
            letterSpacing: 0.5,
          }}
        >
          всегда на связи
        </div>

        <div
          style={{
            marginTop: 56,
            padding: '22px 56px',
            background: '#ffffff',
            color: FOREST_700,
            fontSize: 46,
            fontWeight: 800,
            borderRadius: 999,
            fontFamily: 'Inter, sans-serif',
            boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
            letterSpacing: -0.5,
          }}
        >
          my.linkeon.io
        </div>
      </div>
    </>
  );

  // Centre logo: creator's uploaded logo if provided, else Linkeon as fallback brand.
  const centreLogoSrc = logoUrl ?? staticFile('linkeon-logo.png');
  const hasOwnLogo = !!logoUrl;

  const creatorContent = (
    <>
      {/* When the creator uploaded their own logo, Linkeon-logo shrinks to a corner badge. */}
      {hasOwnLogo && (
        <div
          style={{
            position: 'absolute',
            top: 40,
            right: 40,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            zIndex: 2,
            opacity: 0.85,
          }}
        >
          <Img
            src={staticFile('linkeon-logo.png')}
            style={{
              width: 36,
              height: 36,
              objectFit: 'contain',
              filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.4))',
            }}
          />
          <span style={{
            fontSize: 22,
            fontWeight: 600,
            color: 'rgba(255,255,255,0.85)',
            fontFamily: 'Inter, sans-serif',
          }}>
            на my.linkeon.io
          </span>
        </div>
      )}

      <div
        style={{
          transform: `scale(${scale}) translateY(${logoFloat}px)`,
          marginBottom: 24,
          zIndex: 1,
        }}
      >
        <Img
          src={centreLogoSrc}
          style={{
            width: hasOwnLogo ? 220 : 100,
            height: hasOwnLogo ? 220 : 100,
            objectFit: 'contain',
            borderRadius: hasOwnLogo ? 24 : 0,
            background: hasOwnLogo ? 'rgba(255,255,255,0.95)' : undefined,
            padding: hasOwnLogo ? 16 : 0,
            filter: 'drop-shadow(0 8px 24px rgba(0,0,0,0.4))',
          }}
        />
      </div>

      <div
        style={{
          transform: `scale(${scale})`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          zIndex: 1,
        }}
      >
        <div
          style={{
            fontSize: 70,
            fontWeight: 800,
            color: '#ffffff',
            fontFamily: 'Inter, sans-serif',
            textAlign: 'center',
            letterSpacing: -1,
            lineHeight: 1.05,
          }}
        >
          {ctaLabel ?? 'Подписывайся'}
        </div>

        {/* Optional creator slogan between headline and handle */}
        {ctaSlogan && (
          <div
            style={{
              fontSize: 32,
              fontWeight: 500,
              color: '#d1fae5',
              marginTop: 16,
              maxWidth: '85%',
              textAlign: 'center',
              fontFamily: 'Inter, sans-serif',
              letterSpacing: 0.2,
              lineHeight: 1.25,
            }}
          >
            {ctaSlogan}
          </div>
        )}

        <div
          style={{
            fontSize: 72,
            fontWeight: 800,
            color: '#a7f3d0',
            marginTop: ctaSlogan ? 24 : 28,
            textAlign: 'center',
            fontFamily: 'Inter, sans-serif',
            letterSpacing: -0.5,
            lineHeight: 1.05,
          }}
        >
          {ctaHandle ?? ''}
        </div>

        {!hasOwnLogo && (
          <div
            style={{
              marginTop: 56,
              fontSize: 30,
              fontWeight: 500,
              color: 'rgba(255,255,255,0.7)',
              fontFamily: 'Inter, sans-serif',
              letterSpacing: 0.3,
            }}
          >
            создано на my.linkeon.io
          </div>
        )}
      </div>
    </>
  );

  return (
    <Sequence from={startFrame} durationInFrames={durFrames}>
      <AbsoluteFill
        style={{
          // Linkeon forest gradient — top-left lighter to bottom-right deeper
          background: `linear-gradient(135deg, ${FOREST_700} 0%, ${FOREST_900} 100%)`,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          opacity,
        }}
      >
        {background}
        {isLinkeonOfficial ? officialContent : creatorContent}
      </AbsoluteFill>
    </Sequence>
  );
};
