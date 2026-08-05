import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

export interface DayFramingRow {
  text: string;
  action: any;
  factsHash: string;
  dismissed: boolean;
}

/**
 * Хранилище «day framing» (фрейминг дня — Фаза-3, Task 3) [2026-08-05]: одна строка на
 * (user_id, day, kind) с готовым текстом/действием, чтобы не пересчитывать фрейминг при
 * каждом открытии — TripService дёргает get()/upsert() до/после генерации, markDismissed()
 * когда пользователь закрыл карточку. Самомигрирующаяся таблица (idempotent CREATE TABLE IF
 * NOT EXISTS в onModuleInit), тот же PgService DI-токен, что у LinkeonTasksService/RoutineStore.
 */
@Injectable()
export class DayFramingStore implements OnModuleInit {
  private readonly logger = new Logger(DayFramingStore.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    try {
      await this.pg.query(`
        CREATE TABLE IF NOT EXISTS day_framing (
          user_id text NOT NULL,
          day date NOT NULL,
          kind text NOT NULL,
          text text NOT NULL,
          action_json jsonb,
          facts_hash text NOT NULL,
          generated_at timestamptz NOT NULL DEFAULT now(),
          dismissed boolean NOT NULL DEFAULT false,
          PRIMARY KEY (user_id, day, kind)
        )`);
    } catch (e: any) {
      this.logger.error(`day_framing migration failed: ${e.message}`);
    }
  }

  async get(userId: string, day: string, kind: string): Promise<DayFramingRow | null> {
    const r = await this.pg.query(
      `SELECT text, action_json AS action, facts_hash AS "factsHash", dismissed
         FROM day_framing WHERE user_id=$1 AND day=$2 AND kind=$3`,
      [userId, day, kind],
    );
    return r.rows[0] ?? null;
  }

  async upsert(userId: string, day: string, kind: string, text: string, action: any, factsHash: string): Promise<void> {
    await this.pg.query(
      `INSERT INTO day_framing (user_id, day, kind, text, action_json, facts_hash, generated_at, dismissed)
       VALUES ($1,$2,$3,$4,$5,$6, now(), false)
       ON CONFLICT (user_id, day, kind)
       DO UPDATE SET text=EXCLUDED.text, action_json=EXCLUDED.action_json,
                     facts_hash=EXCLUDED.facts_hash, generated_at=now(), dismissed=false`,
      [userId, day, kind, text, action ? JSON.stringify(action) : null, factsHash],
    );
  }

  async markDismissed(userId: string, day: string, kind: string): Promise<void> {
    await this.pg.query(
      `UPDATE day_framing SET dismissed=true WHERE user_id=$1 AND day=$2 AND kind=$3`,
      [userId, day, kind],
    );
  }
}
