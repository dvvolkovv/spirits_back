import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Секреты продукта (токен бота, ключи бирж) под AES-256-GCM.
 *
 * Предел защиты назван в спеке явно: секрет всё равно становится переменной
 * окружения в контейнере, где работает агент клиента. Шифрование защищает от
 * утечки нашей базы, а не от владельца секрета.
 */
@Injectable()
export class SecretsService {
  constructor(private readonly config: ConfigService) {}

  private key(): Buffer {
    const hex = this.config.get<string>('PRODUCT_SECRETS_KEY');
    if (!hex || hex.length !== 64) {
      throw new Error('PRODUCT_SECRETS_KEY не задан или не 32 байта в hex');
    }
    return Buffer.from(hex, 'hex');
  }

  encrypt(secrets: Record<string, string>): Buffer {
    const iv = crypto.randomBytes(IV_LEN);
    const c = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const body = Buffer.concat([c.update(JSON.stringify(secrets), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }

  decrypt(box: Buffer): Record<string, string> {
    // Обрезанная коробка и без этой проверки не расшифруется, но упадёт
    // сообщением «Invalid authentication tag length: 8» — из него не читается,
    // что в базе лежит обрезок. Проверка про диагностику, не про стойкость.
    if (box.length <= IV_LEN + TAG_LEN) {
      throw new Error(
        `шифротекст короче ${IV_LEN + TAG_LEN + 1} байт: коробка повреждена или не того формата`,
      );
    }
    const iv = box.subarray(0, IV_LEN);
    const tag = box.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const d = crypto.createDecipheriv('aes-256-gcm', this.key(), iv);
    d.setAuthTag(tag);
    const out = Buffer.concat([d.update(box.subarray(IV_LEN + TAG_LEN)), d.final()]);
    return JSON.parse(out.toString('utf8'));
  }
}
