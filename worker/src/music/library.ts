// worker/src/music/library.ts
import { apiClient } from '../api-client';
import { logger } from '../logger';

export type Mood = 'dramatic' | 'inspiring' | 'calm' | 'uplifting' | 'tense' | 'neutral';

export interface PickedTrack {
  id: string;
  title: string;
  mood: Mood;
  durationSec: number;
  publicUrl: string;
}

let _cachedTracks: PickedTrack[] | null = null;

export async function pickTrackByMood(mood: Mood, durationSec = 60): Promise<PickedTrack | null> {
  if (!_cachedTracks) {
    _cachedTracks = await apiClient.listMusicTracks();
  }
  const matches = _cachedTracks.filter((t) => t.mood === mood && t.durationSec >= durationSec);
  if (matches.length === 0) {
    logger.warn({ mood }, 'no music track for mood, falling back to neutral or first');
    return _cachedTracks.find((t) => t.mood === 'neutral') ?? _cachedTracks[0] ?? null;
  }
  return matches[0];
}
