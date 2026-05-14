import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';

/**
 * Автоматическая компакция профиля в Neo4j.
 *
 * Три прохода по каждому активному пользователю:
 *   1) Source-validation — отбросить сущности с support<5, которые не находятся
 *      в собственных human-репликах пользователя (значит пришли из слов
 *      ассистента, а не от самого юзера).
 *   2) Semantic merge — LLM-проход по каждой категории: объединить синонимы
 *      («Human Design анализ» + «Human Design и карты» → один).
 *   3) Stale prune — выбросить support<2 + relation.updated_at старше 30 дней.
 *
 * Под «активным» имеется в виду user с human-сообщениями за последние 7 дней.
 *
 * Запуск: ежедневный cron 04:00 UTC + admin endpoint для ручного триггера.
 */
@Injectable()
export class ProfileCompactionService {
  private readonly logger = new Logger(ProfileCompactionService.name);
  private isRunning = false;

  private readonly CATEGORIES = ['values', 'beliefs', 'desires', 'intents', 'interests', 'skills'] as const;
  // Сущности с support >= этого порога не валидируем через chat history —
  // считаем что многократное появление само по себе доказательство.
  // Поднято до 20 потому что support 5-15 на практике мог набиваться
  // от ассистентских повторений (старый промпт извлекал из обеих сторон).
  // Кейсы: «кришна и личностный бог» 7x (юзер упомянул имя один раз),
  // «дети и духовные каналы» 4x (юзер вообще не говорил, только substring
  // на "духовн"/"канал"). LLM-валидация на ~$0.0005 за entity — дёшево
  // прогнать всё что ниже 20x.
  private readonly TRUSTED_SUPPORT = 20;
  private readonly STRICT_VALIDATE_SUPPORT = 20;
  // Stale prune: support<2 + не обновлялось дольше 30 дней.
  private readonly STALE_DAYS = 30;
  // Семантический merge запускать только если категория крупная.
  private readonly MERGE_THRESHOLD = 12;

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly neo4j?: Neo4jService,
  ) {}

  /** Ежедневный cron 04:00 UTC. */
  @Cron('0 4 * * *')
  async runDailyCompaction(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Compaction already running, skipping cron tick');
      return;
    }
    if (!this.neo4j) return;
    this.isRunning = true;
    try {
      const users = await this.pg.query(
        `SELECT DISTINCT split_part(session_id, '_', 1) AS user_id
           FROM custom_chat_history
           WHERE sender_type = 'human'
             AND created_at > now() - interval '7 days'`,
      );
      this.logger.log(`Compacting ${users.rows.length} active users…`);
      for (const row of users.rows) {
        try {
          await this.compactUser(row.user_id);
        } catch (e: any) {
          this.logger.error(`compact user ${row.user_id} failed: ${e?.message}`);
        }
      }
      this.logger.log('Daily compaction done');
    } finally {
      this.isRunning = false;
    }
  }

  /** Один пользователь — все три прохода. Возвращает stats для лога/UI. */
  async compactUser(userId: string): Promise<Record<string, any>> {
    if (!this.neo4j) return { skipped: 'no neo4j' };
    const stats: Record<string, any> = { userId, perCategory: {} };
    for (const cat of this.CATEGORIES) {
      const c: any = { dropped_noSource: 0, dropped_stale: 0, merged_groups: 0, before: 0, after: 0 };
      const entities = await this.neo4j.listEntitiesForCompaction(userId, this.singular(cat));
      c.before = entities.length;
      if (entities.length === 0) { stats.perCategory[cat] = c; continue; }

      // ── 1) Source-validation ───────────────────────────────────────────
      // Сущности с support < TRUSTED_SUPPORT проходят два слоя:
      // (a) substring-поиск любого ключевого слова имени/алиаса в HUMAN-сообщениях.
      //     Это быстрый отсев совсем безосновательных entries (как «пересчёт
      //     данных и корректировка», которой явно нет в репликах юзера).
      // (b) для support < STRICT_VALIDATE_SUPPORT — дополнительный LLM-проход:
      //     спрашиваем модель, действительно ли юзер УТВЕРЖДАЕТ этот концепт
      //     по найденным фрагментам. Это ловит случаи, когда слово попало в
      //     human-реплику в нерелевантном контексте (например название текста
      //     «Виджняна-Бхайрава-Тантра» не доказывает убеждение «бхайрава
      //     везде и всегда»).
      const suspect = entities.filter(e => e.support < this.TRUSTED_SUPPORT);
      for (const e of suspect) {
        const matches = await this.findUserMatches(userId, e.name, e.aliases);
        if (matches.length === 0) {
          await this.neo4j.dropEntityRelation(userId, this.singular(cat), e.canonicalKey);
          c.dropped_noSource++;
          continue;
        }
        if (e.support < this.STRICT_VALIDATE_SUPPORT) {
          const verdict = await this.llmValidateEntity(cat, e.name, matches);
          if (verdict === false) {
            await this.neo4j.dropEntityRelation(userId, this.singular(cat), e.canonicalKey);
            c.dropped_llmReject = (c.dropped_llmReject || 0) + 1;
          }
        }
      }

      // ── 2) Stale prune ─────────────────────────────────────────────────
      const cutoff = Date.now() - this.STALE_DAYS * 24 * 3600 * 1000;
      const remaining = await this.neo4j.listEntitiesForCompaction(userId, this.singular(cat));
      for (const e of remaining) {
        if (e.support >= 2) continue;
        const ts = e.updatedAt ? Date.parse(e.updatedAt) : 0;
        if (ts > 0 && ts < cutoff) {
          await this.neo4j.dropEntityRelation(userId, this.singular(cat), e.canonicalKey);
          c.dropped_stale++;
        }
      }

      // ── 3) Semantic merge — только если категория всё ещё большая ──────
      const afterPrune = await this.neo4j.listEntitiesForCompaction(userId, this.singular(cat));
      if (afterPrune.length >= this.MERGE_THRESHOLD) {
        const groups = await this.llmGroupSynonyms(cat, afterPrune);
        for (const g of groups) {
          if (g.merge_from.length < 2) continue; // singleton — пропускаем
          await this.neo4j.mergeEntitiesInProfile(userId, this.singular(cat), g.merge_from, g.canonical);
          c.merged_groups++;
        }
      }

      const finalList = await this.neo4j.listEntitiesForCompaction(userId, this.singular(cat));
      c.after = finalList.length;
      stats.perCategory[cat] = c;
    }
    this.logger.log(`compactUser ${userId}: ${JSON.stringify(stats.perCategory)}`);
    return stats;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────

  /** Категория во множ. числе → singular для entityType в Neo4j. */
  private singular(cat: string): string {
    // intents → intent, values → value, beliefs → belief, etc.
    return cat.replace(/s$/, '');
  }

  /**
   * Возвращает до N human-сообщений юзера, в которых встречается имя или
   * любой alias сущности. Используется как substring-pre-filter + источник
   * фрагментов для последующего LLM-validation.
   */
  private async findUserMatches(userId: string, name: string, aliases: string[]): Promise<string[]> {
    const candidates = [name, ...(aliases || [])]
      .map(s => (s || '').trim())
      .filter(s => s.length >= 4);
    if (candidates.length === 0) return ['__skip_validation__']; // нечего искать

    const terms = new Set<string>();
    for (const c of candidates) {
      terms.add(c.toLowerCase());
      for (const w of c.toLowerCase().split(/[\s,.;:()«»"'\-–—]+/)) {
        if (w.length >= 5) terms.add(w);
      }
    }
    const termList = Array.from(terms).slice(0, 30);

    const sessionLike = `${userId}_%`;
    const placeholders = termList.map((_, i) => `content ILIKE $${i + 2}`).join(' OR ');
    const params = [sessionLike, ...termList.map(t => `%${t}%`)];
    try {
      const res = await this.pg.query(
        `SELECT content FROM custom_chat_history
           WHERE session_id LIKE $1 AND sender_type = 'human'
             AND (${placeholders})
           ORDER BY created_at DESC
           LIMIT 8`,
        params,
      );
      return res.rows.map(r => String(r.content || ''));
    } catch (e: any) {
      this.logger.warn(`findUserMatches query failed: ${e?.message}`);
      return ['__skip_validation__']; // на ошибке — не дропаем
    }
  }

  /**
   * LLM-проверка: «утверждает ли юзер этот концепт» в реальных human-репликах.
   * Возвращает true (keep), false (drop), null (неоднозначно — keep).
   * Цена ≈ 1 Haiku call ≈ 500 input tokens ≈ $0.0005 за entity.
   */
  private async llmValidateEntity(category: string, entityName: string, userMessages: string[]): Promise<boolean | null> {
    // Спец-маркер из findUserMatches: validation пропускаем.
    if (userMessages.length === 1 && userMessages[0] === '__skip_validation__') return null;
    if (userMessages.length === 0) return false;

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const orKey = process.env.OPENROUTER_API_KEY;
    if (!anthropicKey && !orKey) return null; // нет ключей — keep

    const samples = userMessages
      .map((m, i) => `[${i + 1}] ${m.slice(0, 400)}`)
      .join('\n\n');

    const prompt = `Ты валидируешь профиль пользователя. Категория: "${category}".

Кандидат: "${entityName}"

Это фрагменты из РЕПЛИК ПОЛЬЗОВАТЕЛЯ (только его, не ассистента) где встречается слово/тема:

${samples}

Вопрос: пользователь действительно УТВЕРЖДАЕТ или ЯВНО ПРИЗНАЁТ концепт "${entityName}" применимо к самому себе (как своё ${category === 'values' ? 'ценность' : category === 'beliefs' ? 'убеждение' : category === 'desires' ? 'желание' : category === 'intents' ? 'намерение' : category === 'interests' ? 'интерес' : 'навык'})?

Правила решения:
- YES — если пользователь явно сказал об этом про себя («я верю», «я ценю», «мне важно», «хочу», «умею»), или явно согласился с такой формулировкой.
- NO — если пользователь только упомянул слово/тему в нерелевантном контексте (например в названии текста, как описание чужой ситуации, как вопрос, или из любопытства), не присвоив себе.
- NO — если все упоминания нейтральные/информационные (спросил, узнал, поделился цитатой).

Ответь ОДНИМ словом: YES или NO. Без объяснений.`;

    try {
      let content: string | null = null;
      if (anthropicKey) {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: anthropicKey });
        const msg = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{ role: 'user', content: prompt }],
        });
        content = msg.content?.[0]?.text || null;
      } else if (orKey) {
        const resp = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: process.env.CONSOLIDATION_MODEL || 'openai/gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 10,
          },
          { headers: { Authorization: `Bearer ${orKey}` }, timeout: 30000 },
        );
        content = resp.data.choices?.[0]?.message?.content;
      }
      if (!content) return null;
      const verdict = content.trim().toUpperCase();
      if (verdict.startsWith('NO')) return false;
      if (verdict.startsWith('YES')) return true;
      return null;
    } catch (e: any) {
      this.logger.warn(`llmValidateEntity failed for "${entityName}": ${e?.message}`);
      return null;
    }
  }

  /**
   * Семантическое группирование через Claude Haiku 4.5 (fallback OpenRouter
   * gpt-4o-mini). Принимает список сущностей категории, возвращает группы
   * синонимов с canonical именем и списком исходных canonical_key для merge.
   */
  private async llmGroupSynonyms(
    category: string,
    entities: Array<{ canonicalKey: string; name: string; aliases: string[]; support: number }>,
  ): Promise<Array<{ canonical: string; merge_from: string[] }>> {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const orKey = process.env.OPENROUTER_API_KEY;
    if (!anthropicKey && !orKey) return [];

    const listing = entities
      .map((e, i) => `${i + 1}. "${e.name}" (key=${e.canonicalKey}, support=${e.support})`)
      .join('\n');

    const prompt = `Тебе даны сущности категории "${category}" из профиля пользователя. Задача — найти семантически синонимичные группы и предложить для каждой канонические имя.

Правила:
- Группа = две или более сущности, означающие одно и то же по смыслу. Разные формулировки одного концепта.
- Для каждой группы дай канонически удачную, общеупотребительную формулировку (можно одну из исходных, можно новую более точную).
- Сущности, которые не входят ни в одну группу синонимов, в результат НЕ включай.
- Не объединяй смежные но разные концепты (например «здоровье» и «спорт» — это разное; «здоровье» и «физическое благополучие» — синонимы).
- Не объединяй на основании пересечения темы (тема «бизнес» содержит много под-концептов, не сливай их все в один).

Список сущностей (имя + canonical_key + support):
${listing}

Верни ТОЛЬКО валидный JSON и ничего кроме:
{"groups":[{"canonical":"...","merge_from":["key1","key2","key3"]}, ...]}

Если синонимичных групп нет — верни {"groups":[]}.`;

    let content: string | null = null;
    try {
      if (anthropicKey) {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: anthropicKey });
        const msg = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        });
        content = msg.content?.[0]?.text || null;
      } else if (orKey) {
        const resp = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: process.env.CONSOLIDATION_MODEL || 'openai/gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
          },
          {
            headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
            timeout: 60000,
          },
        );
        content = resp.data.choices?.[0]?.message?.content;
      }
    } catch (e: any) {
      this.logger.warn(`llmGroupSynonyms call failed: ${e?.message}`);
      return [];
    }
    if (!content) return [];

    const parsed = this.parseJsonTolerant(content);
    if (!parsed?.groups || !Array.isArray(parsed.groups)) return [];

    // Валидируем: все merge_from существуют среди наших keys.
    const validKeys = new Set(entities.map(e => e.canonicalKey));
    const out: Array<{ canonical: string; merge_from: string[] }> = [];
    for (const g of parsed.groups) {
      if (!g?.canonical || !Array.isArray(g.merge_from)) continue;
      const cleanKeys = g.merge_from.map((k: any) => String(k).toLowerCase()).filter((k: string) => validKeys.has(k));
      if (cleanKeys.length < 2) continue;
      out.push({ canonical: String(g.canonical).trim(), merge_from: cleanKeys });
    }
    return out;
  }

  /**
   * Толерантный JSON-парсер (копия из Neo4jService.extractJsonObject — пока
   * не вынесли в общий helper).
   */
  private parseJsonTolerant(text: string): any | null {
    if (!text) return null;
    let s = text.trim();
    if (s.startsWith('```')) {
      s = s.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    }
    try { return JSON.parse(s); } catch {}
    const start = s.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { if (inStr) esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }
}
