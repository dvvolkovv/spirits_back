import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { AgentsService } from '../agents/agents.service';

/**
 * «Поговорить начисто» [owner 2026-08-24] — запрос в облачный LLM, НЕ связанный с пользователем.
 *
 * Обычный чат тянет в промпт профиль из Neo4j и пишет историю под аккаунт — это ровно то, чего здесь
 * НЕ должно быть. Тут отдельный чистый путь:
 *   • промпт = нейтральная системная строка + сам вопрос. Ни профиля, ни имени, ни контекста аккаунта.
 *   • sessionId — ЭФЕМЕРНЫЙ, случайный на каждый запрос (`anon_<uuid>`), НЕ `<userId>_...`: релей
 *     (r.linkeon.io) не склеивает вопрос с личными чатами и не переиспользует память по пользователю.
 *   • ничего не сохраняем: ни custom_chat_history, ни профиль. Ответ отдаём и забываем.
 *   • всё идёт через ОБЩИЙ Claude-аккаунт Linkeon → провайдер видит «Linkeon», не человека.
 *
 * Что это НЕ прячет (честно): если сам текст вопроса самоидентифицирующий, архитектура тут бессильна —
 * это на стороне формулировки пользователя.
 */
@Injectable()
export class CleanAskService {
  private readonly logger = new Logger(CleanAskService.name);

  // Ф3 единого чата (owner 2026-08-26): выбор персонажа и в ОБЕЗЛИЧЕННОМ режиме. Персона (роль
  // персонажа) — это НЕ данные пользователя, а определение персонажа; профиль остаётся строго
  // телефон-де-ид (context приходит уже обезличенным). Грузим system_prompt персонажа из БД, как
  // это делает полный чат, и накладываем на телефон-подготовленный контекст.
  constructor(private readonly agents: AgentsService) {}

  private static readonly SYSTEM =
    'Ты — живой, тактичный собеседник в приватном чате. Это ДИАЛОГ, а не справка: отвечай КОРОТКО и ' +
    'по-разговорному — обычно 2–5 предложений, как в переписке, без заголовков и длинных списков. ' +
    'Не вываливай всё сразу и не перечисляй все возможные случаи: дай суть и, если для полезного ' +
    'ответа не хватает деталей, задай ОДИН уточняющий вопрос и остановись. Разворачивай подробно ' +
    'только если человек прямо просит («подробнее», «по пунктам»). Без осуждения и морализаторства; ' +
    'не запрашивай и не предполагай личных данных. Если фраза выглядит как ошибка распознавания ' +
    'речи (несвязное слово) — мягко переспроси, что имелось в виду. Отвечай на русском языке.';

  /**
   * Одноходовый запрос. `context` — УЖЕ обезличенный на устройстве контекст (Egress: без имён и
   * прямых идентификаторов); бэкенд его НЕ перепроверяет и НЕ дополняет профилем — он слепое реле.
   * Возвращает текст ответа; при сбое бросает (контроллер отдаст ошибку).
   */
  async ask(
    text: string,
    context?: string,
    history?: Array<{ role?: string; content?: string }>,
    assistant?: string,
  ): Promise<string> {
    const q = (text || '').trim();
    if (!q) throw new Error('empty question');
    const ctx = (context || '').trim();

    // Персона выбранного персонажа (Ф3). Роль накладывается на телефон-де-ид контекст; профиль
    // с сервера НЕ подтягивается. Если персонаж не найден — тихо падаем на нейтральный SYSTEM.
    let personaBlock = '';
    const who = (assistant || '').trim();
    if (who) {
      try {
        const agent =
          (await this.agents.getAgentByName(who)) ||
          (/^\d+$/.test(who) ? await this.agents.getAgentById(who) : null);
        const sp = agent?.system_prompt ? String(agent.system_prompt).trim() : '';
        if (sp) {
          personaBlock =
            `Ты — ассистент по имени ${agent.name || who}. Твоя персона и стиль:\n${sp}\n\n` +
            `Оставаясь этим персонажем, следуй правилам ниже.\n\n`;
        }
      } catch (e: any) {
        this.logger.warn(`persona load failed for "${who}": ${e?.message || e}`);
      }
    }

    const ctxBlock = ctx
      ? `\n\nОбезличенный контекст о собеседнике (без имён и личных данных — используй, чтобы ответ был ` +
        `уместнее, но не пытайся вычислить, кто это):\n${ctx}`
      : '';
    // Многоходовость: клиент присылает прежние реплики (они живут на устройстве, не на сервере).
    // Реле по-прежнему без сессии — контекст диалога передаём в самом сообщении.
    let histBlock = '';
    if (Array.isArray(history) && history.length) {
      const lines = history
        .filter((t) => t && typeof t.content === 'string' && t.content.trim())
        .map((t) => `${t.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${String(t.content).trim()}`);
      if (lines.length) histBlock = `\n\nПредыдущий разговор:\n${lines.join('\n')}`;
    }
    const message = `${personaBlock}${CleanAskService.SYSTEM}${ctxBlock}${histBlock}\n\nПользователь: ${q}`;
    return this.callRelay(message);
  }

  /**
   * Эфемерный вызов релея (r.linkeon.io) без привязки к пользователю: новая случайная сессия на
   * каждый запрос, ничего не сохраняется. Общая точка обращения к LLM для ask() и firstContact().
   */
  private async callRelay(message: string): Promise<string> {
    const AGENT_URL = process.env.AGENT_URL || 'https://r.linkeon.io';
    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('message', message);
    // Эфемерная, ни к кому не привязанная сессия — новая на каждый запрос.
    fd.append('sessionId', `anon_${randomUUID()}`);

    const chunks: string[] = [];
    const resp = await axios.post(`${AGENT_URL}/chat`, fd, {
      headers: fd.getHeaders(),
      responseType: 'stream',
      timeout: 300000,
    });
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      resp.data.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'delta' || ev.type === 'text') chunks.push(ev.text);
            else if (ev.type === 'result' && ev.text && chunks.length === 0) chunks.push(ev.text);
          } catch {
            /* пропускаем нерелевантные события релея */
          }
        }
      });
      resp.data.on('end', () => resolve());
      resp.data.on('error', reject);
    });
    return this.stripToolTags(chunks.join('')).trim();
  }

  // ── Первый контакт (знакомство с Романом) [spec 2026-08-27-first-contact-experience] ──────────
  // Правила «знакомства»: доброжелательно, с искренним личным интересом к ЧЕЛОВЕКУ. Два режима —
  // следующий вопрос (finish=false) и финальный момент-отклик (finish=true). Анти-фальш встроен.
  private static readonly FC_QUESTION =
    'Это ПЕРВОЕ знакомство: человек только что установил приложение, и ты знакомишься с ним. Будь ' +
    'доброжелательным и дружелюбным, проявляй искренний личный интерес именно к ЭТОМУ человеку — ' +
    'это тёплый разговор, а не анкета. Реагируя на его последний ответ, задай ОДИН следующий живой ' +
    'вопрос и остановись (не перечисляй варианты). Коротко, 1–3 предложения, по-разговорному. Всего в ' +
    'знакомстве не больше 10 вопросов — не тяни. Ничего не выдумывай про человека и не предполагай ' +
    'того, чего он не сказал. Отвечай на русском.';
  private static readonly FC_FINISH =
    'Человек завершает знакомство. Дай тёплый, личный момент-отклик, по-дружески. Сделай три вещи: ' +
    '(1) КОНКРЕТНО отрази то, что он сказал — покажи, что ты его услышал (не пересказ, а понимание); ' +
    '(2) предложи ОДНУ конкретную, выполнимую помощь в духе «давай я…» — именно одну, не список; ' +
    '(3) тепло и искренне, БЕЗ общих дежурных фраз («я здесь, чтобы помочь» и т.п.), без лести и без ' +
    'выводов о том, чего он не говорил. 2–4 предложения. Если он сказал совсем мало — отталкивайся ' +
    'честно от того немногого, что есть. Отвечай на русском.';

  /**
   * Момент-отклик первого контакта в голосе Романа (или иной персоны из FIRST_CONTACT_AGENT).
   * Анонимно и эфемерно, как ask(): без аккаунта, без сохранения. `messages` — весь разговор с
   * устройства ({from:'user'|'roman'}); `finish=false` → следующий вопрос, `finish=true` → отклик.
   */
  async firstContact(messages: Array<{ from?: string; text?: string }>, finish: boolean): Promise<string> {
    const who = (process.env.FIRST_CONTACT_AGENT || 'Роман').trim();
    let personaBlock = '';
    try {
      const agent =
        (await this.agents.getAgentByName(who)) ||
        (/^\d+$/.test(who) ? await this.agents.getAgentById(who) : null);
      const sp = agent?.system_prompt ? String(agent.system_prompt).trim() : '';
      if (sp) {
        personaBlock =
          `Ты — ассистент по имени ${agent.name || who}. Твоя персона и стиль:\n${sp}\n\n` +
          `Оставаясь этим персонажем, следуй правилам ниже.\n\n`;
      }
    } catch (e: any) {
      this.logger.warn(`first-contact persona load failed for "${who}": ${e?.message || e}`);
    }
    const convo = (messages || [])
      .filter((m) => m && typeof m.text === 'string' && m.text.trim())
      .map((m) => `${m.from === 'roman' ? 'Ты (Роман)' : 'Человек'}: ${String(m.text).trim()}`)
      .join('\n');
    const rules = finish ? CleanAskService.FC_FINISH : CleanAskService.FC_QUESTION;
    const message =
      `${personaBlock}${rules}\n\nРазговор так далеко:\n${convo || '(разговор только начинается)'}\n\nТвой ответ:`;
    return this.callRelay(message);
  }

  /** Убрать возможные служебные теги инструментов из ответа релея. */
  private stripToolTags(s: string): string {
    return (s || '')
      .replace(/<tool[\s\S]*?<\/tool>/gi, '')
      .replace(/<\/?[a-z_]+_tool[^>]*>/gi, '')
      .trim();
  }
}
