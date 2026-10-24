import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { BacklogService } from '../backlog/backlog.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { buildKeyboard, insightsChatId } from './insights-digest';
import { InsightsStore, type CallbackFinding } from './insights-store.service';
import { FRICTION_LABELS } from './insights.types';

export function shouldRouteToInsights(data?: string): boolean {
  return String(data || '').startsWith('ins:');
}

export function parseInsightsCallback(data: string): { action: 'b' | 'r' | 'noop'; findingId: string } | null {
  const m = /^ins:(b|r|noop):([0-9a-f-]{36})$/i.exec(String(data || ''));
  return m ? { action: m[1] as 'b' | 'r' | 'noop', findingId: m[2] } : null;
}

/**
 * Описание задачи бэклога — без цифр о людях: задача в статусе done уходит
 * темой в публичный блог (blogTopicFromBacklog — заголовок и первые 500 знаков).
 */
export function backlogAnalysis(f: Pick<CallbackFinding, 'type' | 'description' | 'proposal'>): string {
  return [
    '## Проблема',
    '',
    f.description,
    '',
    '## Предложение',
    '',
    f.proposal,
    '',
    `_Находка бота «Затыки недели», тип: ${FRICTION_LABELS[f.type].toLowerCase()}._`,
  ].join('\n');
}

/** Счётчики — в комментарий: комментарии в блог не уходят. */
export function backlogCounts(f: Pick<CallbackFinding, 'people' | 'conversations' | 'assistants' | 'weeks' | 'firstWeek'>): string {
  return (
    `Счётчики на момент передачи: людей — ${f.people}, разговоров — ${f.conversations}; ` +
    `ассистенты: ${f.assistants.join(', ') || '—'}; недель с находкой — ${f.weeks}, впервые — неделя с ${f.firstWeek}.`
  );
}

@Injectable()
export class InsightsCallbackService {
  private readonly log = new Logger('InsightsCallback');

  constructor(
    private readonly store: InsightsStore,
    private readonly backlog: BacklogService,
    @Inject(forwardRef(() => TgGrammyClient)) private readonly tg: TgGrammyClient,
  ) {}

  async handleCallback(cb: any): Promise<void> {
    const answer = (text: string) => this.tg.answerCallbackQuery(cb?.id, { text }).catch(() => undefined);
    const chatId = insightsChatId();
    // Кнопки сводки — только у владельца и только в его чате.
    if (!chatId || Number(cb?.from?.id) !== chatId || Number(cb?.message?.chat?.id) !== chatId) {
      await answer('Недоступно');
      return;
    }
    const parsed = parseInsightsCallback(cb?.data);
    if (!parsed) {
      await answer('Не понял кнопку');
      return;
    }
    if (parsed.action === 'noop') {
      await answer('Уже обработано');
      return;
    }
    const f = await this.store.findingForCallback(parsed.findingId);
    if (!f) {
      await answer('Находка не найдена');
      return;
    }
    let reply: string;
    if (parsed.action === 'b') {
      if (!(await this.store.claimBacklog(f.id))) {
        await answer('Уже обработано');
        return;
      }
      try {
        const item = await this.backlog.create('insights', { title: f.title, analysis_md: backlogAnalysis(f), status: 'approved' });
        await this.store.setBacklogItem(f.id, item.id);
        try {
          await this.backlog.addComment(item.id, 'insights', backlogCounts(f));
        } catch (e: any) {
          this.log.warn(`комментарий со счётчиками к задаче ${item.id} не записан: ${e?.message}`);
        }
        reply = 'В бэклоге';
      } catch (e: any) {
        this.log.error(`задача из находки ${f.id} не заведена: ${e?.message}`);
        await this.store.revertToOpen(f.id);
        await answer('Не получилось завести задачу');
        return;
      }
    } else {
      if (!(await this.store.reject(f.id, f.people))) {
        await answer('Уже обработано');
        return;
      }
      reply = 'Отклонено';
    }
    await this.refreshKeyboard(f.runFindingIds, cb.message);
    await answer(reply);
  }

  private async refreshKeyboard(ids: string[] | null, message: any): Promise<void> {
    if (!ids?.length || !message?.message_id) return;
    const st = await this.store.statuses(ids);
    const reply_markup = buildKeyboard(ids.map((id) => ({ id, status: st.get(id) ?? 'open' })));
    try {
      await this.tg.getBot().api.editMessageReplyMarkup(message.chat.id, message.message_id, { reply_markup });
    } catch (e: any) {
      // Старое сообщение или та же клавиатура — не повод ронять нажатие.
      this.log.warn(`клавиатура сводки не обновлена: ${e?.message}`);
    }
  }
}
