// worker/remotion/src/Root.tsx
import { Composition, registerRoot } from 'remotion';
import { ChatCase, defaultProps } from './compositions/ChatCase';
import { CaseVideoProps } from './types';

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

const Root: React.FC = () => {
  return (
    <Composition
      id="ChatCase"
      component={ChatCase}
      durationInFrames={defaultProps.totalDurationSec * FPS}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={defaultProps}
      calculateMetadata={async ({ props }) => {
        const p = props as CaseVideoProps;
        return { durationInFrames: Math.round(p.totalDurationSec * FPS) };
      }}
    />
  );
};

registerRoot(Root);
