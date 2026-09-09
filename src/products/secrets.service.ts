import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const VERSION = 1;
const VERSION_LEN = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = VERSION_LEN + IV_LEN + TAG_LEN;

/**
 * Секреты продукта (токен бота, ключи бирж) под AES-256-GCM.
 *
 * Формат коробки: version(1) | iv(12) | tag(16) | body. Ведущий байт версии —
 * чтобы ротация ключа или смена раскладки не превращалась в «все строки в базе
 * нечитаемы и отличить старую от новой нечем».
 *
 * productId уходит в AAD в обе стороны: ключ один на все продукты, поэтому без
 * привязки коробка одного продукта расшифровывается как секреты другого.
 * Защищает не от чтения базы (спека про это), а от нашего же промаха — ошибочный
 * WHERE, подтянувший чужой secrets_encrypted, обязан упасть, а не отдать чужой
 * токен в контейнер.
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
    // Именно hex, а не «64 любых символа»: 'z'.repeat(64) проходил счётчик
    // символов и умирал на Invalid key length — сообщением, из которого причина
    // не читается.
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('PRODUCT_SECRETS_KEY не задан или не 32 байта в hex');
    }
    return Buffer.from(hex, 'hex');
  }

  private aad(productId: string): Buffer {
    if (!productId) {
      throw new Error('productId обязателен: пустой AAD не привязывает коробку ни к чему');
    }
    // Версия тоже в AAD — чтобы коробка одного поколения формата не читалась
    // кодом другого: при ротации ключа или раскладки тег не сойдётся. Именно
    // поколение, а не байт: AAD считается от константы VERSION, а не от
    // ведущего байта коробки, и подмену этого байта ловит проверка равенства в
    // decrypt (измерено: убрать её — и порча ведущего байта проходит молча).
    return Buffer.concat([Buffer.from(productId, 'utf8'), Buffer.from([VERSION])]);
  }

  encrypt(secrets: Record<string, string>, productId: string): Buffer {
    const aad = this.aad(productId);
    const iv = crypto.randomBytes(IV_LEN);
    const c = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    c.setAAD(aad);
    const body = Buffer.concat([c.update(JSON.stringify(secrets), 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), body]);
  }

  decrypt(box: Buffer, productId: string): Record<string, string> {
    // Обрезанная коробка и без этой проверки не расшифруется, но упадёт
    // сообщением «Invalid authentication tag length: 8» — из него не читается,
    // что в базе лежит обрезок. Проверка про диагностику, не про стойкость.
    if (box.length <= HEADER_LEN) {
      throw new Error(
        `шифротекст короче ${HEADER_LEN + 1} байт: коробка повреждена или не того формата`,
      );
    }
    if (box[0] !== VERSION) {
      throw new Error(`неизвестная версия формата секретов: ${box[0]}, поддерживается ${VERSION}`);
    }
    const aad = this.aad(productId);
    const iv = box.subarray(VERSION_LEN, VERSION_LEN + IV_LEN);
    const tag = box.subarray(VERSION_LEN + IV_LEN, HEADER_LEN);
    const d = crypto.createDecipheriv('aes-256-gcm', this.key(), iv);
    d.setAAD(aad);
    d.setAuthTag(tag);
    const out = Buffer.concat([d.update(box.subarray(HEADER_LEN)), d.final()]);
    const parsed = JSON.parse(out.toString('utf8'));
    // Форма проверяется после разбора: значения уедут переменными окружения, а
    // вложенный объект стал бы там [object Object] без единой жалобы.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('секреты продукта не объект');
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'string') {
        throw new Error(`значение секрета ${k} не строка: в переменную окружения уехал бы мусор`);
      }
    }
    return parsed as Record<string, string>;
  }
}
