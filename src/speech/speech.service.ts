// src/speech/speech.service.ts
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { LanguageService } from '../common/services/language.service';
import { RedisService } from '../common/services/redis.service';
import { resolveVoice, ResolvedVoice, TtsProvider } from './voices';
import { synthesizeYandex } from './providers/yandex';
import { synthesizeOpenai } from './providers/openai';
import { splitForSpeech } from './split';

const SPEECH_BUCKET = process.env.SPEECH_BUCKET || 'linkeon-assets';
const DEFAULT_ASSISTANT = 'Роман';

export const RATE_LIMIT_PER_MIN = 20;

/**
 * Потолок длины у каждого провайдера свой — единой константы быть не может.
 *
 * Yandex: лимит не на символы, а 15 КБ на тело POST-запроса. В
 * application/x-www-form-urlencoded каждый байт кодируется как %XX, кириллица
 * занимает 2 байта → 6 символов тела на символ текста. Замер: 5000 кириллических
 * символов = 30 005 байт (вдвое сверх лимита), 2000 = 12 005 байт (влезает
 * с запасом). На латинице тот же текст прошёл бы — поэтому баг не ловится
 * короткой тестовой фразой и вылезает на первом длинном русском ответе.
 *
 * OpenAI: у tts-1 жёсткий лимит 4096 символов на input, берём 4000.
 */
const MAX_CHARS_BY_PROVIDER: Record<TtsProvider, number> = {
  yandex: 2000,
  openai: 4000,
};

export function maxCharsFor(provider: TtsProvider): number {
  return MAX_CHARS_BY_PROVIDER[provider];
}

/**
 * 1000 токенов за каждую начатую 1000 символов. Фронт показывает цену кнопки
 * «Прослушать» по той же формуле — listenPrice в
 * spirits_front/src/components/chat/listen/speechText.ts.
 */
export function tokenCostFor(chars: number): number {
  return Math.ceil(chars / 1000) * 1000;
}

/** Ключ кэша: текст + голос + язык. Голос обязан входить в ключ. */
export function cacheKeyFor(text: string, voice: string, lang: string): string {
  return createHash('sha256').update(`${text} ${voice} ${lang}`).digest('hex');
}

/**
 * Оценка длительности: ни Yandex, ни OpenAI её не возвращают, а ffprobe в
 * API-процессе ради подписи под плеером не нужен — точное время покажет
 * сам аудио-тег на клиенте.
 */
export function estimateDurationSec(chars: number): number {
  return Math.round((chars / 15) * 100) / 100;
}

/**
 * Потолок длины ответа для кнопки «Прослушать»: около 11 минут речи и пять
 * запросов к Yandex. Зеркало на фронте — LISTEN_MAX_CHARS в
 * spirits_front/src/components/chat/listen/speechText.ts (там им гасят
 * кнопку до нажатия; источник истины — здесь).
 */
export const LISTEN_MAX_CHARS = 10_000;

/** Сколько кусков одного ответа синтезируются одновременно. */
const LISTEN_CONCURRENCY = 3;

/**
 * Promise.all с потолком одновременных вызовов. Порядок результатов — порядок
 * входа, а не порядок завершения. После первой ошибки новые вызовы не
 * начинаются: у провайдера платим за каждый.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}

export interface SynthesizeInput {
  text: string;
  /** Любой id из каталога. Невалидный молча откатывается на следующий уровень. */
  voice?: string;
}

export type SynthesizeResult =
  | {
      ok: true; clipId: string; audioUrl: string; durationSec: number;
      chars: number; voice: string; provider: TtsProvider;
      tokensSpent: number; cached: boolean;
    }
  | { ok: false; error: 'insufficient_tokens'; balance: number; required: number }
  | { ok: false; error: 'text_too_long'; maxChars: number; provider: TtsProvider }
  | { ok: false; error: 'rate_limited'; retryAfterSec: number }
  | { ok: false; error: string };

export interface ListenInput {
  text: string;
  /** Внутреннее имя ассистента ленты (agents.name). Выбирает только голос. */
  assistant?: string;
}

export type ListenResult =
  | {
      ok: true; parts: string[]; chars: number; tokensSpent: number;
      cached: boolean; voice: string; provider: TtsProvider;
    }
  | { ok: false; error: 'empty_text' }
  | { ok: false; error: 'text_too_long'; maxChars: number }
  | { ok: false; error: 'insufficient_tokens'; balance: number; required: number }
  | { ok: false; error: 'rate_limited'; retryAfterSec: number }
  | { ok: false; error: 'tts_failed' };

@Injectable()
export class SpeechService implements OnModuleInit {
  private readonly logger = new Logger(SpeechService.name);

  constructor(
    private readonly pg: PgService,
    private readonly storage: StorageService,
    private readonly language: LanguageService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Таблицы модуля создаются при старте API: `npm run migrate` на проде
   * застревает на base/001 и до speech/ не доходит. Учёт — в той же
   * schema_migrations и под теми же именами (`speech/<файл>`), что ведёт
   * scripts/migrate.ts; на test и проде speech/001 там уже записан ручным
   * накатом (проверено 06.10.2026). Записанное не катается повторно: ALTER из
   * 001 брал бы эксклюзивную блокировку speech_clips на каждом старте.
   *
   * Каждый файл — своей транзакцией на выделенном соединении с lock_timeout,
   * запись о нём — в той же транзакции. Ошибка пишется в лог и старт API не
   * роняет: файл просто попробуется снова при следующем старте.
   *
   * В dist .sql не копируются (nest-cli без assets), поэтому второй путь —
   * исходники рядом со сборкой.
   */
  async onModuleInit(): Promise<void> {
    const dir = [
      path.join(__dirname, 'migrations'),
      path.join(__dirname, '..', '..', 'src', 'speech', 'migrations'),
    ].find((d) => fs.existsSync(d));
    if (!dir) {
      this.logger.warn('speech migrations dir not found');
      return;
    }
    try {
      await this.pg.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           filename text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
    } catch (e: any) {
      this.logger.error(`speech migrations skipped, schema_migrations unavailable: ${e?.message}`);
      return;
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const name = `speech/${f}`;
      let client: any = null;
      try {
        client = await this.pg.getClient();
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '3s'");
        const done = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [name]);
        if (done.rows.length > 0) {
          await client.query('COMMIT');
          continue;
        }
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
        await client.query('COMMIT');
        this.logger.log(`speech migration applied: ${f}`);
      } catch (e: any) {
        if (client) {
          try { await client.query('ROLLBACK'); } catch { /* соединение уже мёртвое */ }
        }
        this.logger.error(`speech migration failed (${f}): ${e?.message}`);
      } finally {
        client?.release();
      }
    }
  }

  async synthesize(userId: string, input: SynthesizeInput): Promise<SynthesizeResult> {
    const text = String(input.text ?? '').trim();
    if (!text) return { ok: false, error: 'empty text' };

    // Потолок 20/мин, а не 10: сценка по ролям — это десяток синтезов подряд
    // в одном ответе ассистента, она не должна упираться в лимит.
    if (await this.hitRateLimit(userId)) {
      return { ok: false, error: 'rate_limited', retryAfterSec: 60 };
    }

    const lang = await this.language.resolveUserLanguage(userId);

    // Ассистент берётся из БД, а не из аргументов инструмента: по MCP модель
    // сама подставляет аргументы и может назвать чужого ассистента.
    const { assistantName, resolved } = await this.voiceFor(userId, lang, { requested: input.voice });

    // Потолок длины проверяем только здесь: он зависит от провайдера, а провайдер
    // известен лишь после разрешения языка и голоса.
    const maxChars = maxCharsFor(resolved.provider);
    if (text.length > maxChars) {
      return { ok: false, error: 'text_too_long', maxChars, provider: resolved.provider };
    }

    const cacheKey = cacheKeyFor(text, resolved.voice, lang);
    const hit = await this.pg.query(
      'SELECT id, url, duration_sec, chars FROM speech_clips WHERE user_id = $1 AND cache_key = $2',
      [userId, cacheKey],
    );
    if (hit.rows.length) {
      const row = hit.rows[0];
      // Кэш-хит бесплатен, но его надо пометить как выданный ИМЕННО СЕЙЧАС.
      // Блок инъекции маркеров в chat.service.ts отбирает клипы за время стрима,
      // а created_at у кэш-хита старый: без этого UPDATE повтор того же текста
      // не давал пользователю плеера вообще — инструмент возвращал ok, модель
      // сообщала об успехе, а карточки не появлялось.
      //
      // Падение UPDATE не должно ронять выдачу уже готового клипа: хуже, чем
      // отсутствие маркера, только отсутствие ответа.
      try {
        await this.pg.query('UPDATE speech_clips SET last_used_at = now() WHERE id = $1', [row.id]);
      } catch (e: any) {
        this.logger.warn(`failed to bump last_used_at for clip ${row.id}: ${e.message}`);
      }
      return {
        ok: true, clipId: String(row.id), audioUrl: row.url,
        durationSec: Number(row.duration_sec ?? 0), chars: Number(row.chars),
        voice: resolved.voice, provider: resolved.provider, tokensSpent: 0, cached: true,
      };
    }

    const required = tokenCostFor(text.length);
    const balRes = await this.pg.query(
      'SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const balance = Number(balRes.rows[0]?.tokens ?? 0);
    if (balance < required) return { ok: false, error: 'insufficient_tokens', balance, required };

    let bytes: Buffer;
    try {
      bytes = await this.synthesizeWith(resolved.provider, text, resolved.voice);
    } catch (e: any) {
      this.logger.warn(`synthesize failed (${resolved.provider}/${resolved.voice}): ${e.message}`);
      return { ok: false, error: e?.message || 'tts failed' };
    }

    const key = `audio/${cacheKey}.mp3`;
    const url = await this.storage.upload({
      bucket: SPEECH_BUCKET, key, body: bytes,
      contentType: 'audio/mpeg', cacheControl: 'public, max-age=31536000, immutable',
    });

    const durationSec = estimateDurationSec(text.length);

    // ON CONFLICT обязателен: уникальный индекс (user_id, cache_key) — это и есть
    // механизм кэша, а сценка по ролям шлёт несколько синтезов подряд. Два
    // параллельных вызова с одним текстом иначе дали бы 23505 unique_violation
    // и 500-ку вместо кэш-хита.
    //
    // tokens_spent пишем сразу суммой `required`, ещё до списания: строка живёт
    // только если списание прошло — при провале она удаляется компенсацией ниже.
    // Так в таблице нет клипов с записанной, но не взятой платой. Из этой
    // колонки chat.service.ts собирает индикатор «X токенов» под сообщением.
    const ins = await this.pg.query(
      `INSERT INTO speech_clips (user_id, assistant_id, cache_key, url, duration_sec, chars, provider, voice, lang, tokens_spent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, cache_key) DO NOTHING
       RETURNING id`,
      [userId, assistantName, cacheKey, url, durationSec, text.length, resolved.provider, resolved.voice, lang, required],
    );

    if (ins.rows.length === 0) {
      // Гонку выиграл параллельный вызов — он уже оплатил синтез. Отдаём его клип
      // и второй раз денег не берём.
      const existing = await this.pg.query(
        'SELECT id, url, duration_sec, chars FROM speech_clips WHERE user_id = $1 AND cache_key = $2',
        [userId, cacheKey],
      );
      const row = existing.rows[0];
      return {
        ok: true, clipId: String(row.id), audioUrl: row.url,
        durationSec: Number(row.duration_sec ?? 0), chars: Number(row.chars),
        voice: resolved.voice, provider: resolved.provider, tokensSpent: 0, cached: true,
      };
    }

    // Списываем только после успешного синтеза и заливки (debit — условным
    // UPDATE со строкой в реестре).
    //
    // null = денег не хватило. Синтез к этому моменту уже выполнен и файл
    // залит — это осознанная плата за то, что списание идёт последним: лучше
    // один раз впустую сходить к провайдеру, чем увести баланс в минус.
    //
    // А строку в speech_clips в этом случае надо убрать компенсацией: пара
    // (user_id, cache_key) — это и есть кэш, и неоплаченный клип достался бы
    // пользователю бесплатно при первом же повторе того же текста. Удаляем
    // адресно по id только что вставленной строки, чтобы не задеть клип
    // параллельного вызова (тот случай уже отработан веткой ON CONFLICT выше).
    //
    // Объект в MinIO остаётся сиротой — он недостижим без строки (getClip ходит
    // по id + user_id), а ключ детерминирован (audio/<cache_key>.mp3), так что
    // оплаченный повтор просто перезапишет его тем же содержимым.
    const clipId = String(ins.rows[0].id);
    const paid = await this.debit(userId, required, 'Синтез речи', {
      clip_id: clipId, chars: text.length, voice: resolved.voice, provider: resolved.provider,
    });

    if (paid === null) {
      try {
        await this.pg.query('DELETE FROM speech_clips WHERE id = $1 AND user_id = $2', [clipId, userId]);
      } catch (e: any) {
        this.logger.error(`failed to roll back unpaid clip ${clipId}: ${e.message}`);
      }
      const cur = await this.pg.query(
        'SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1',
        [userId],
      );
      const now = Number(cur.rows[0]?.tokens ?? 0);
      this.logger.warn(`speech deduct lost the race: user=${userId} required=${required} balance=${now}`);
      return { ok: false, error: 'insufficient_tokens', balance: now, required };
    }

    return {
      ok: true, clipId, audioUrl: url, durationSec,
      chars: text.length, voice: resolved.voice, provider: resolved.provider,
      tokensSpent: required, cached: false,
    };
  }

  /**
   * Кнопка «Прослушать» под ответом ассистента: весь ответ голосом ассистента
   * ленты. Длинный текст синтезируется кусками под лимит провайдера, а платит
   * пользователь один раз за всю длину по тарифу озвучки — округление вверх на
   * каждом куске переплачивало бы до 1000 токенов за кусок.
   *
   * Кэш — своя таблица speech_listens, не speech_clips (почему — в шапке
   * migrations/002_speech_listens.sql). Строка кэша и списание — одной
   * транзакцией: «строка есть ⇔ оплачено». Параллельный запрос того же ответа
   * ждёт на уникальном индексе исхода этой транзакции и видит строку только
   * оплаченной, а сбой или отказ списания откатывает и её — бесплатного
   * неоплаченного кэша не бывает.
   */
  async listen(userId: string, input: ListenInput): Promise<ListenResult> {
    const text = String(input?.text ?? '').trim();
    if (!text) return { ok: false, error: 'empty_text' };
    if (text.length > LISTEN_MAX_CHARS) {
      return { ok: false, error: 'text_too_long', maxChars: LISTEN_MAX_CHARS };
    }

    const lang = await this.language.resolveUserLanguage(userId);
    // Имя ассистента приходит с фронта, но подделка ничего не даёт: оно
    // выбирает голос только из собственной карты пользователя и дефолтов.
    const assistant = typeof input?.assistant === 'string' ? input.assistant.trim().slice(0, 64) : '';
    const { assistantName, resolved } = await this.voiceFor(userId, lang, { assistant: assistant || undefined });
    const { voice, provider } = resolved;
    const cacheKey = cacheKeyFor(text, voice, lang);

    // Готовое прослушивание отдаём раньше лимита частоты: провайдера повтор не
    // трогает, а бюджет 20 в минуту общий с инструментом generate_speech.
    const hit = await this.findListen(userId, cacheKey);
    if (hit) {
      try {
        await this.pg.query('UPDATE speech_listens SET last_used_at = now() WHERE id = $1', [hit.id]);
      } catch (e: any) {
        this.logger.warn(`failed to bump last_used_at for listen ${hit.id}: ${e.message}`);
      }
      return { ok: true, parts: hit.parts, chars: text.length, tokensSpent: 0, cached: true, voice, provider };
    }

    if (await this.hitRateLimit(userId)) {
      return { ok: false, error: 'rate_limited', retryAfterSec: 60 };
    }

    const required = tokenCostFor(text.length);
    const balRes = await this.pg.query(
      'SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const balance = Number(balRes.rows[0]?.tokens ?? 0);
    if (balance < required) return { ok: false, error: 'insufficient_tokens', balance, required };

    const chunks = splitForSpeech(text, maxCharsFor(provider));
    let audio: Buffer[];
    try {
      audio = await mapLimit(chunks, LISTEN_CONCURRENCY, (chunk) => this.synthesizeWith(provider, chunk, voice));
    } catch (e: any) {
      this.logger.warn(`listen synthesize failed (${provider}/${voice}): ${e.message}`);
      return { ok: false, error: 'tts_failed' };
    }

    // Случайная часть в имени файла: без неё адрес куска вычислялся бы из
    // текста (sha256), и звук, за который списание не прошло, доставался бы
    // даром. Заодно параллельные запросы одного ответа не перезаписывают
    // файлы друг друга (OpenAI синтезирует недетерминированно).
    const nonce = randomBytes(8).toString('hex');
    let parts: string[];
    try {
      parts = await Promise.all(audio.map((body, i) => this.storage.upload({
        bucket: SPEECH_BUCKET, key: `audio/listen/${cacheKey}-${nonce}-${i}.mp3`, body,
        contentType: 'audio/mpeg', cacheControl: 'public, max-age=31536000, immutable',
      })));
    } catch (e: any) {
      this.logger.warn(`listen upload failed: ${e.message}`);
      return { ok: false, error: 'tts_failed' };
    }

    const client = await this.pg.getClient();
    let outcome: 'paid' | 'lost_race' | 'insufficient';
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO speech_listens (user_id, assistant, cache_key, parts, chars, provider, voice, lang, tokens_spent)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)
         ON CONFLICT (user_id, cache_key) DO NOTHING
         RETURNING id`,
        [userId, assistantName, cacheKey, JSON.stringify(parts), text.length, provider, voice, lang, required],
      );
      if (ins.rows.length === 0) {
        outcome = 'lost_race';
        await client.query('ROLLBACK');
      } else {
        const paid = await this.debit(userId, required, 'Озвучка ответа', {
          listen_id: String(ins.rows[0].id), chars: text.length, parts: parts.length, voice, provider,
        }, client);
        outcome = paid === null ? 'insufficient' : 'paid';
        await client.query(outcome === 'paid' ? 'COMMIT' : 'ROLLBACK');
      }
    } catch (e: any) {
      try { await client.query('ROLLBACK'); } catch { /* соединение уже мёртвое */ }
      this.logger.error(`listen payment failed: user=${userId} ${e.message}`);
      throw e;
    } finally {
      client.release();
    }

    if (outcome === 'lost_race') {
      // Гонку выиграл параллельный запрос того же ответа, и его транзакция уже
      // закоммичена — значит, оплачена. Отдаём его куски, второй раз не берём.
      const winner = await this.findListen(userId, cacheKey);
      if (winner) {
        return { ok: true, parts: winner.parts, chars: text.length, tokensSpent: 0, cached: true, voice, provider };
      }
      return { ok: false, error: 'tts_failed' };
    }
    if (outcome === 'insufficient') {
      const cur = await this.pg.query(
        'SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1',
        [userId],
      );
      return { ok: false, error: 'insufficient_tokens', balance: Number(cur.rows[0]?.tokens ?? 0), required };
    }
    return { ok: true, parts, chars: text.length, tokensSpent: required, cached: false, voice, provider };
  }

  private async findListen(userId: string, cacheKey: string): Promise<{ id: string; parts: string[] } | null> {
    const r = await this.pg.query(
      'SELECT id, parts FROM speech_listens WHERE user_id = $1 AND cache_key = $2',
      [userId, cacheKey],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { id: String(row.id), parts: Array.isArray(row.parts) ? row.parts.map(String) : [] };
  }

  /**
   * Лимит частоты: один бюджет на инструмент generate_speech и кнопку
   * «Прослушать». expire ставим только на первом попадании в окно, иначе TTL
   * продлевается каждым вызовом и окно никогда не закрывается.
   */
  private async hitRateLimit(userId: string): Promise<boolean> {
    const rlKey = `speech:rl:${userId}`;
    const hits = await this.redis.incr(rlKey);
    if (hits === 1) await this.redis.expire(rlKey, 60);
    if (hits > RATE_LIMIT_PER_MIN) {
      this.logger.warn(`rate limited: user=${userId} hits=${hits}`);
      return true;
    }
    return false;
  }

  /**
   * Голос: выбор в настройках (profile_data.assistant_voices) → дефолт
   * ассистента → дефолт по полу. Ассистент — переданный явно (кнопка
   * «Прослушать» знает, чья лента), иначе preferred_agent из БД, иначе Роман.
   */
  private async voiceFor(
    userId: string,
    lang: string,
    opts: { assistant?: string; requested?: string } = {},
  ): Promise<{ assistantName: string; resolved: ResolvedVoice }> {
    const profRes = await this.pg.query(
      'SELECT preferred_agent, profile_data FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const assistantName: string = opts.assistant || profRes.rows[0]?.preferred_agent || DEFAULT_ASSISTANT;
    const userChoice: string | undefined =
      profRes.rows[0]?.profile_data?.assistant_voices?.[assistantName];

    const resolved = resolveVoice({ lang, assistantName, userChoice, requested: opts.requested });
    for (const r of resolved.rejected) {
      this.logger.warn(`voice rejected: source=${r.source} voice=${r.voice} lang=${lang}`);
    }
    return { assistantName, resolved };
  }

  /**
   * Списание со строкой в реестре. Остаток после списания или null, если
   * денег не хватило.
   *
   * УСЛОВНЫЙ UPDATE, а не общий MiscService.deductTokens. deductTokens делает
   * безусловный `tokens = tokens - $1`, а проверка баланса у вызывающих —
   * отдельный запрос. Описание инструмента прямо поощряет пачку вызовов подряд
   * («сценка по ролям»), и параллельные вызовы все читают один и тот же
   * достаточный баланс, после чего каждый списывает: баланс 1000 и пять
   * параллельных синтезов дают −4000. Условие `tokens >= $1` делает проверку
   * и списание одной атомарной операцией. Общий deductTokens намеренно НЕ
   * трогаем: им пользуются другие фичи, и менять его поведение за их спиной
   * опасно.
   *
   * Строку в token_transactions пишем сами и в одной транзакции со списанием:
   * consume_user_tokens при нехватке забирает остаток, а здесь нужен отказ
   * целиком. Без этой записи расход на синтез не виден в общей истории —
   * ровно та дыра, которую 20.08.2026 нашла сверка баланса с реестром.
   */
  private async debit(
    userId: string,
    amount: number,
    description: string,
    metadata: Record<string, unknown>,
    // Чужая открытая транзакция: тогда здесь только списание и строка реестра,
    // а BEGIN/COMMIT/ROLLBACK — забота вызывающего (listen держит в той же
    // транзакции строку кэша). Без неё debit открывает свою.
    outer?: PoolClient,
  ): Promise<number | null> {
    if (outer) return this.debitWith(outer, userId, amount, description, metadata);
    const payClient = await this.pg.getClient();
    try {
      await payClient.query('BEGIN');
      const after = await this.debitWith(payClient, userId, amount, description, metadata);
      await payClient.query('COMMIT');
      return after;
    } catch (e: any) {
      try { await payClient.query('ROLLBACK'); } catch {}
      this.logger.error(`speech deduct failed: ${e.message}`);
      throw e;
    } finally {
      payClient.release();
    }
  }

  private async debitWith(
    client: PoolClient,
    userId: string,
    amount: number,
    description: string,
    metadata: Record<string, unknown>,
  ): Promise<number | null> {
    const paid = await client.query(
      'UPDATE ai_profiles_consolidated SET tokens = tokens - $1, updated_at = now() WHERE user_id = $2 AND tokens >= $1 RETURNING tokens',
      [amount, userId],
    );
    if (paid.rows.length === 0) return null;
    await client.query(
      `INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, metadata)
       VALUES ($1, 'consumed', $2, $3, $4, $5::jsonb)`,
      [userId, -amount, Number(paid.rows[0].tokens), description, JSON.stringify(metadata)],
    );
    return Number(paid.rows[0].tokens);
  }

  /** Один ретрай при ошибке провайдера. Фолбэка на другого провайдера нет:
   *  разный тембр на повторе звучит как баг, а не как спасение. */
  private async synthesizeWith(provider: TtsProvider, text: string, voice: string): Promise<Buffer> {
    try {
      return await this.callProvider(provider, text, voice);
    } catch (e: any) {
      this.logger.warn(`tts attempt 1 failed (${provider}/${voice}): ${e.message}, retrying`);
      return await this.callProvider(provider, text, voice);
    }
  }

  /** Выделено отдельным методом, чтобы тесты подменяли сеть одной строкой. */
  private async callProvider(provider: TtsProvider, text: string, voice: string): Promise<Buffer> {
    return provider === 'yandex' ? synthesizeYandex(text, voice) : synthesizeOpenai(text, voice);
  }

  async getClip(userId: string, clipId: string): Promise<any | null> {
    const res = await this.pg.query(
      'SELECT id, url, duration_sec, chars, voice, provider, lang, created_at FROM speech_clips WHERE id = $1 AND user_id = $2',
      [clipId, userId],
    );
    return res.rows[0] ?? null;
  }
}
