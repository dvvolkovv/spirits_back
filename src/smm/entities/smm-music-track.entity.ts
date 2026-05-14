// src/smm/entities/smm-music-track.entity.ts
import { SmmMood } from './smm-scenario.entity';

export interface SmmMusicTrack {
  id: string;
  title: string;
  mood: SmmMood;
  durationSec: number;
  storageKey: string;
  license: string | null;
  createdAt: Date;
}

export function rowToMusicTrack(row: any): SmmMusicTrack {
  return {
    id: row.id,
    title: row.title,
    mood: row.mood,
    durationSec: row.duration_sec,
    storageKey: row.storage_key,
    license: row.license ?? null,
    createdAt: row.created_at,
  };
}
