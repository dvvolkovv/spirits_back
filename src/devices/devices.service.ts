import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { parseUserAgent, signatureOf } from './user-agent';

/**
 * С каких устройств заходят пользователи.
 *
 * Запись делается в двух точках входа в аккаунт — при входе и при продлении
 * токена. Продление случается примерно раз в два часа активного использования,
 * поэтому «последний визит» остаётся свежим без глобального перехватчика на
 * каждый запрос: такого механизма в проекте нет, и заводить его ради сбора
 * статистики значило бы положить его на горячий путь стриминга чата.
 */
@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(private readonly pg: PgService) {}

  /**
   * Записать устройство. Никогда не бросает.
   *
   * Вход по SMS в этом проекте уже ломался, и цеплять к нему необязательную
   * аналитику без страховки нельзя: человек, который не может войти из-за
   * упавшего сбора статистики, — цена, несопоставимая с пользой от неё.
   */
  async record(userId: string, userAgent: string | undefined | null): Promise<void> {
    if (!userId) return;

    try {
      const parsed = parseUserAgent(userAgent);
      const signature = signatureOf(parsed);

      await this.pg.query(
        `INSERT INTO user_devices
           (user_id, signature, platform, os_name, os_version, browser_name, browser_version, raw_user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, signature) DO UPDATE
            SET last_seen = now(),
                raw_user_agent = EXCLUDED.raw_user_agent,
                seen_count = user_devices.seen_count + 1`,
        [
          userId,
          signature,
          parsed.platform,
          parsed.osName,
          parsed.osVersion,
          parsed.browserName,
          parsed.browserVersion,
          (userAgent ?? '').slice(0, 500),
        ],
      );
    } catch (e: any) {
      this.logger.warn(`не удалось записать устройство для ${userId}: ${e?.message}`);
    }
  }
}
