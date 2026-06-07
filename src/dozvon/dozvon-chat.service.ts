import { Injectable, Logger } from '@nestjs/common';
import { Response } from 'express';
import { PgService } from '../common/services/pg.service';
import { query } from '@anthropic-ai/claude-agent-sdk';

const MODEL = 'claude-sonnet-4-5';
const MAX_HISTORY = 40;

/**
 * Chat-сервис для планирования обзвона.
 * Один чат-тред = одна dozvon_campaign. session_id в custom_chat_history = `dozvon_camp_{id}`.
 *
 * Протокол:
 *  - юзер пишет сообщение → стримим ответ Claude
 *  - Claude в какой-то момент выдаёт inline-блок [[CAMPAIGN_PLAN]]{json}[[/CAMPAIGN_PLAN]]
 *    с полями {goal, calls:[{name, phone, script_hint?}], notes?}.
 *    Фронт парсит его и показывает карточку «▶️ Запустить обзвон».
 *  - Когда план подтверждён и execute запущен — результаты звонков пишутся в тот же чат
 *    (как сообщения с sender_type='ai', agent=0) в handleCallComplete.
 */
const SYSTEM_PROMPT = `Ты — ассистент-планировщик телефонного обзвона на платформе my.linkeon.io.

Пользователь ставит тебе задачу — позвонить кому-то (одному или многим). Это может быть:
- бизнес-обзвон (найти 5 автосервисов и узнать цены, обзвонить клиентов и согласовать встречи);
- личный звонок (позвонить другу и поздравить, позвонить маме и напомнить про лекарства, позвонить ребёнку в школу);
- служебный (уточнить расписание, забронировать столик, узнать наличие товара);
- любая другая задача, где нужно просто позвонить.

Твоя роль:
1. Если юзер уже дал номер(а) и цель — СРАЗУ формируй план, не задавай лишних вопросов. Это самый частый случай.
2. Если юзер описал задачу, но не дал контактов (например, «найди автосервисы в Москве») — используй встроенный инструмент web_search, чтобы найти реальные телефоны. Не выдумывай.
3. Если нужны уточнения (что именно спросить/передать, город, критерии) — задай 1-2 точных вопроса.
4. ВСЕГДА продумывай встречные вопросы. Подумай, о чём собеседник скорее всего спросит («кто звонит», «откуда у вас мой номер», «от кого именно», «по какому вопросу», «когда перезвонить», «могу ли я говорить с живым человеком», «какие ваши услуги», и т.п.) и собери пары {q, a} с ответами из контекста юзера. Если для ответа нужна инфа которой у тебя нет — задай её юзеру прежде чем формировать план.
5. Когда план готов — выведи его СТРОГО в inline-формате (в одну последовательность без переносов внутри маркера):
   [[CAMPAIGN_PLAN]]{"goal":"краткое описание цели","calls":[{"name":"...","phone":"+7XXXXXXXXXX","script_hint":"что сказать/спросить","qa":[{"q":"вопрос собеседника","a":"ответ агента"}]}],"notes":"доп. инфо"}[[/CAMPAIGN_PLAN]]
   После маркера — 1-2 предложения резюме. Маркер обязательно ДО резюме.
6. Если юзер просит правки плана — выведи новый маркер [[CAMPAIGN_PLAN]] с изменённым JSON.

Правила:
- Отвечай коротко, по делу, на русском.
- Не отказывайся помочь потому что «это личный звонок» или «я не знаю этого человека» — доверяй юзеру, он звонит от своего имени своим людям.
- Телефоны только в формате +7XXXXXXXXXX (нормализуй сам, если юзер прислал 8-..., +7 ..., 9-...).
- НЕ ВЫДУМЫВАЙ номера. Если не знаешь — используй web_search или попроси у юзера.
- В script_hint — буквально одно предложение: что агент должен сказать/спросить/передать («Поздоровайся, скажи что это Дмитрий просит пожелать хорошего дня, попрощайся» / «Спроси цену ремонта BMW X5, уточни сроки»).
- В qa — 3-6 пар. Предугадывай реалистичные вопросы того типа, кому звонят (бизнесу / другу / врачу). Пример для личного звонка: q «Кто это?» → a «Это голосовой помощник Иван, звоню от имени Дмитрия Волкова». q «Почему Дмитрий сам не звонит?» → a «Он попросил меня позвонить от его имени, чтобы узнать как у вас дела».
- Количество звонков не ограничивай искусственно. Если юзер хочет больше 20 — просто уточни, точно ли столько.
- Имя в поле name — как юзер назвал адресата («Мама», «Друг Ваня», «СТО На Юге»), или название организации если из веб-поиска.
- Единственное что нельзя — помогать в явно злонамеренных сценариях (угрозы, обман, мошенничество). Любые бытовые/деловые/личные звонки — норм.`;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

@Injectable()
export class DozvonChatService {
  private readonly logger = new Logger(DozvonChatService.name);

  constructor(private readonly pg: PgService) {}

  private sessionId(campaignId: number): string {
    return `dozvon_camp_${campaignId}`;
  }

  /** История сообщений треда (для отображения и для LLM-контекста). */
  async getHistory(campaignId: number): Promise<ChatMessage[]> {
    const res = await this.pg.query(
      `SELECT sender_type, content, created_at
       FROM custom_chat_history
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [this.sessionId(campaignId)],
    );
    return res.rows.map((r) => ({
      role: r.sender_type === 'human' ? 'user' : 'assistant',
      content: r.content,
    }));
  }

  /** Добавить сообщение в тред (используется и ботом для system-уведомлений). */
  async addMessage(campaignId: number, role: 'user' | 'assistant', content: string): Promise<void> {
    const sender = role === 'user' ? 'human' : 'ai';
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
       VALUES ($1, $2, 0, $3, 'text')`,
      [this.sessionId(campaignId), sender, content],
    );
  }

  /** Стриминг ответа планировщика в ответ на новое сообщение пользователя. */
  async streamChat(campaignId: number, userMessage: string, res: Response): Promise<void> {
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    await this.addMessage(campaignId, 'user', userMessage);
    const history = await this.getHistory(campaignId);

    // Подхватываем текущий статус/план кампании для контекста.
    const campRes = await this.pg.query(
      `SELECT title, status, call_plan FROM dozvon_campaigns WHERE id = $1`,
      [campaignId],
    );
    const camp = campRes.rows[0];
    const contextNote = camp
      ? `\n\nТекущий статус задачи: ${camp.status}. Текущий title: "${camp.title || 'Новая задача'}".${
          camp.call_plan ? ` Текущий план:\n${JSON.stringify(camp.call_plan)}` : ''
        }`
      : '';

    // Agent SDK не принимает messages-array — собираем prompt из истории.
    const priorTurns = history
      .slice(-MAX_HISTORY)
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');

    let assistantText = '';
    try {
      for await (const event of query({
        prompt: priorTurns,
        options: {
          model: MODEL,
          systemPrompt: SYSTEM_PROMPT + contextNote,
          allowedTools: ['WebSearch'],
          permissionMode: 'bypassPermissions',
          settingSources: [],
          includePartialMessages: true,
        } as any,
      })) {
        // Text deltas → стриминг во фронт как раньше.
        if (event.type === 'stream_event') {
          const inner = (event as any).event;
          if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta'
              && typeof inner.delta.text === 'string') {
            const text = inner.delta.text;
            assistantText += text;
            res.write(JSON.stringify({ type: 'delta', text }) + '\n');
          }
        }
        // Сигнал фронту о начале web-поиска (нужно для UI-индикатора "ищу").
        if (event.type === 'assistant') {
          for (const block of ((event as any).message?.content || []) as any[]) {
            if (block.type === 'tool_use' && block.name === 'WebSearch') {
              const q = String(block.input?.query || '');
              res.write(JSON.stringify({ type: 'tool', name: 'web_search', query: q }) + '\n');
            }
          }
        }
      }
    } catch (e: any) {
      this.logger.error(`streamChat error: ${e.message}`);
      assistantText = assistantText || 'Произошла ошибка. Попробуйте ещё раз.';
      res.write(JSON.stringify({ type: 'error', text: e.message }) + '\n');
    }

    await this.addMessage(campaignId, 'assistant', assistantText);

    // Извлекаем план если он есть в ответе — сохраняем в campaign.call_plan.
    const plan = this.extractPlan(assistantText);
    if (plan) {
      // Дедуп по номеру телефона: Claude любит галлюцинировать одинаковые
      // номера у разных фирм — отбрасываем дубли, сохраняя первое вхождение.
      if (Array.isArray(plan.calls)) {
        const seen = new Set<string>();
        plan.calls = plan.calls.filter((c: any) => {
          const p = String(c.phone || '').replace(/\D/g, '');
          if (!p || seen.has(p)) return false;
          seen.add(p);
          return true;
        });
      }
      await this.pg.query(
        `UPDATE dozvon_campaigns SET call_plan = $1, status = 'ready', updated_at = now() WHERE id = $2`,
        [JSON.stringify(plan), campaignId],
      );
    }

    // Обновляем title на первом реальном сообщении (если дефолтный).
    await this.maybeGenerateTitle(campaignId, userMessage);

    res.write(JSON.stringify({ type: 'done', hasPlan: !!plan }) + '\n');
    res.end();
  }

  private extractPlan(text: string): any | null {
    // Preferred: explicit [[CAMPAIGN_PLAN]]...[[/CAMPAIGN_PLAN]] block.
    const closed = text.match(/\[\[CAMPAIGN_PLAN\]\]([\s\S]*?)\[\[\/CAMPAIGN_PLAN\]\]/);
    if (closed) {
      try { return JSON.parse(closed[1].trim()); } catch { /* fall through */ }
    }

    // Fallback: Claude sometimes loses the closing marker when the response
    // follows a tool-use block (ends with `</parameter></invoke>` residue).
    // Extract the first balanced JSON object right after [[CAMPAIGN_PLAN]].
    const open = text.indexOf('[[CAMPAIGN_PLAN]]');
    if (open < 0) return null;
    const start = text.indexOf('{', open);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const json = text.slice(start, i + 1);
          try { return JSON.parse(json); } catch { return null; }
        }
      }
    }
    return null;
  }

  private async maybeGenerateTitle(campaignId: number, userMessage: string): Promise<void> {
    const r = await this.pg.query(
      `SELECT title FROM dozvon_campaigns WHERE id = $1`, [campaignId],
    );
    const currentTitle = r.rows[0]?.title;
    if (currentTitle && currentTitle !== 'Новая задача') return;
    // Короткое имя из первой фразы юзера — просто обрезаем, без LLM.
    const clean = userMessage.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!clean) return;
    await this.pg.query(
      `UPDATE dozvon_campaigns SET title = $1, updated_at = now() WHERE id = $2`,
      [clean, campaignId],
    );
  }
}
