#!/usr/bin/env ts-node
/**
 * Seed smm_music_track with 6 placeholder tracks (one per mood).
 *
 * The actual MP3 files must be present in MinIO at bucket linkeon-smm-music
 * under the storage_key paths below. Plan 2 Task 6 uploads a single
 * generated 60-sec tone MP3 to all 6 keys as placeholders; real curated
 * Pixabay tracks can replace them later via `mc cp`.
 *
 * Usage:
 *   DATABASE_URL=... npm run seed-music
 */
import { Pool } from 'pg';

const TRACKS = [
  { id: 'dramatic_01',  mood: 'dramatic',  title: 'Dramatic Cinematic 1', durationSec: 60, storageKey: 'dramatic.mp3',  license: 'placeholder' },
  { id: 'inspiring_01', mood: 'inspiring', title: 'Uplifting Piano',      durationSec: 60, storageKey: 'inspiring.mp3', license: 'placeholder' },
  { id: 'calm_01',      mood: 'calm',      title: 'Soft Ambient',         durationSec: 60, storageKey: 'calm.mp3',      license: 'placeholder' },
  { id: 'uplifting_01', mood: 'uplifting', title: 'Happy Acoustic',       durationSec: 60, storageKey: 'uplifting.mp3', license: 'placeholder' },
  { id: 'tense_01',     mood: 'tense',     title: 'Suspense Pulse',       durationSec: 60, storageKey: 'tense.mp3',     license: 'placeholder' },
  { id: 'neutral_01',   mood: 'neutral',   title: 'Background Bed',       durationSec: 60, storageKey: 'neutral.mp3',   license: 'placeholder' },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const t of TRACKS) {
    await pool.query(
      `INSERT INTO smm_music_track (id, title, mood, duration_sec, storage_key, license)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET title = EXCLUDED.title, mood = EXCLUDED.mood,
             duration_sec = EXCLUDED.duration_sec, storage_key = EXCLUDED.storage_key,
             license = EXCLUDED.license`,
      [t.id, t.title, t.mood, t.durationSec, t.storageKey, t.license],
    );
    console.log(`upserted ${t.id}`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
