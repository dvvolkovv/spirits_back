// src/smm/music/music.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import { SmmMusicTrack, rowToMusicTrack } from '../entities/smm-music-track.entity';
import { SmmMood } from '../entities/smm-scenario.entity';

@Injectable()
export class MusicService {
  private readonly logger = new Logger(MusicService.name);
  constructor(private readonly pg: PgService) {}

  async upsert(track: Omit<SmmMusicTrack, 'createdAt'>): Promise<void> {
    await this.pg.query(
      `INSERT INTO smm_music_track (id, title, mood, duration_sec, storage_key, license)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET title = EXCLUDED.title,
             mood = EXCLUDED.mood,
             duration_sec = EXCLUDED.duration_sec,
             storage_key = EXCLUDED.storage_key,
             license = EXCLUDED.license`,
      [track.id, track.title, track.mood, track.durationSec, track.storageKey, track.license ?? null],
    );
    this.logger.log(`upsert music track ${track.id} mood=${track.mood}`);
  }

  async listByMood(mood: SmmMood, minDurationSec = 60): Promise<SmmMusicTrack[]> {
    const r = await this.pg.query(
      `SELECT * FROM smm_music_track WHERE mood = $1 AND duration_sec >= $2`,
      [mood, minDurationSec],
    );
    return r.rows.map(rowToMusicTrack);
  }

  async findById(id: string): Promise<SmmMusicTrack | null> {
    const r = await this.pg.query(`SELECT * FROM smm_music_track WHERE id = $1`, [id]);
    return r.rows[0] ? rowToMusicTrack(r.rows[0]) : null;
  }
}
