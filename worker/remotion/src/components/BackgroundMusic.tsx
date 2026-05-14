// worker/remotion/src/components/BackgroundMusic.tsx
import { Audio } from 'remotion';

interface Props {
  src: string;
  volume?: number;
}

export const BackgroundMusic: React.FC<Props> = ({ src, volume = 0.15 }) => {
  return <Audio src={src} volume={volume} loop />;
};
