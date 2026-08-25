import { Body, Controller, Logger, OnModuleInit, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { PgService } from '../common/services/pg.service';
import { IdentityService } from '../identity/identity.service';
import { JwtService } from '../common/services/jwt.service';
import { verifyInitData } from './init-data';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
};

@Controller('tma')
export class TmaController implements OnModuleInit {
  private readonly logger = new Logger(TmaController.name);

  constructor(
    private readonly pg: PgService,
    private readonly identity: IdentityService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Проверка при старте, а не только в ответе на запрос: verifyInitData
   * намеренно отдаёт один и тот же 401 и на битую подпись, и на пустой
   * TG_BOT_TOKEN — иначе ручка превращается в оракул. Но это значит, что
   * забытая переменная на свежем деплое выглядит как обычный поток отказов
   * и молчит, пока кто-то не пожалуется, что Mini App не пускает. Здесь —
   * громкий сигнал один раз при старте вместо тишины.
   */
  onModuleInit() {
    if (!process.env.TG_BOT_TOKEN) {
      this.logger.error(
        'TG_BOT_TOKEN не задан — все запросы к /webhook/tma/auth будут получать 401, пока переменная не установлена',
      );
    }
  }

  @Post('auth')
  async auth(
    @Body() body: { initData?: string; intent?: 'signup' },
    @Res() res: Response,
  ) {
    const verified = verifyInitData(body?.initData || '', process.env.TG_BOT_TOKEN || '');
    if (!verified) {
      return res.set(CORS).status(401).json({ error: 'invalid initData' });
    }
    const sub = String(verified.tgUserId);

    // Свежая ручка без единой строки в логах на ошибку — трудно отлаживать
    // по репорту «не входит». stage фиксирует, на каком шаге упало: тот же
    // catch-блок обслуживает три разные ветки ниже.
    let stage = 'lookup:user_identities';
    try {
      // 1) Основная система идентичностей
      const known = await this.pg.query(
        `SELECT user_id FROM user_identities WHERE provider = 'telegram' AND provider_sub = $1 LIMIT 1`,
        [sub],
      );
      if (known.rows.length) {
        await this.identity.touchIdentity('telegram', sub);
        return this.issue(res, known.rows[0].user_id);
      }

      // 2) Старожилы бота: связка живёт только в tg_user_identities.
      // Без этой ветки они получили бы экран регистрации и завели бы двойников.
      stage = 'lookup:tg_user_identities';
      const fromBot = await this.pg.query(
        `SELECT linkeon_user_id FROM tg_user_identities WHERE tg_user_id = $1 LIMIT 1`,
        [verified.tgUserId],
      );
      if (fromBot.rows.length) {
        const userId = fromBot.rows[0].linkeon_user_id;
        stage = 'backfill:user_identities';
        await this.pg.query(
          `INSERT INTO user_identities (user_id, provider, provider_sub, email_verified, last_used_at)
           VALUES ($1, 'telegram', $2, false, now())
           ON CONFLICT (provider, provider_sub) DO NOTHING`,
          [userId, sub],
        );
        // Бэкфилл выше пишет last_used_at только при первой вставке — при
        // повторном визите сработает ON CONFLICT DO NOTHING и дата замрёт
        // навсегда. touchIdentity обновляет её на каждый вход.
        await this.identity.touchIdentity('telegram', sub);
        return this.issue(res, userId);
      }

      // 3) Незнакомый Telegram. Аккаунт заводим ТОЛЬКО по явному выбору:
      // авторегистрация на каждом открытии наплодила бы пустых аккаунтов у всех,
      // кто просто заглянул.
      if (body?.intent !== 'signup') {
        return res.set(CORS).status(404).json({ needsChoice: true });
      }

      stage = 'signup:resolveOrCreate';
      const { userId } = await this.identity.resolveOrCreate('telegram', { sub });
      stage = 'signup:tg_user_identities upsert';
      await this.pg.query(
        `INSERT INTO tg_user_identities (linkeon_user_id, tg_user_id, tg_username, tg_first_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (linkeon_user_id) DO UPDATE SET
           tg_user_id = EXCLUDED.tg_user_id,
           tg_username = EXCLUDED.tg_username,
           tg_first_name = EXCLUDED.tg_first_name`,
        [userId, verified.tgUserId, verified.tgUsername, verified.tgFirstName],
      );
      return this.issue(res, userId);
    } catch (e: any) {
      this.logger.error(
        `tma auth failed at ${stage} for tgUserId=${verified.tgUserId}: ${e?.message}`,
        e?.stack,
      );
      throw e;
    }
  }

  private issue(res: Response, userId: string) {
    return res.set(CORS).status(200).json({
      'access-token': this.jwt.signAccess(userId),
      'refresh-token': this.jwt.signRefresh(userId),
    });
  }
}
