// worker/remotion/src/compositions/ChatCase.tsx
import { AbsoluteFill } from 'remotion';
import { CaseVideoProps } from '../types';

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
  // Components ChatBubble / BRollImage / BRollVideo / Subtitle / CTA / BackgroundMusic
  // are added in Task 9. For now render a placeholder gradient so the composition
  // can be smoke-rendered end-to-end.
  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(180deg, #1a1a2e 0%, #0f3460 50%, #16213e 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ color: 'white', fontSize: 60, fontWeight: 700 }}>
        {props.title}
      </div>
    </AbsoluteFill>
  );
};
