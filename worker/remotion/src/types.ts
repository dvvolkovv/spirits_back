// worker/remotion/src/types.ts
export type Speaker = 'hero' | 'assistant';
export type AssistantRole = 'psy' | 'lawyer' | 'coach' | string;
export type Mood = 'dramatic' | 'inspiring' | 'calm' | 'uplifting' | 'tense' | 'neutral';

export interface DialogTurnProps {
  speaker: Speaker;
  text: string;
  tStart: number;
  tEnd: number;
  /** Public URL to the synthesized voice file (MP3 served from MinIO) */
  voiceUrl: string;
}

export interface BrollProps {
  atSec: number;
  durationSec: number;
  /** Either a still image URL or a video clip URL */
  mediaUrl: string;
  type: 'image' | 'video';
}

export interface SubtitleChunkProps {
  text: string;
  tStart: number;
  tEnd: number;
}

export interface CaseVideoProps {
  title: string;
  assistantRole: AssistantRole;
  mood: Mood;
  dialog: DialogTurnProps[];
  broll: BrollProps[];
  subtitles: SubtitleChunkProps[];
  /** Public URL of the background music MP3 */
  musicUrl: string | null;
  /** Total duration in seconds. Composition always 60s for MVP. */
  totalDurationSec: number;
}
