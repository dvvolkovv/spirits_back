import { Injectable } from '@nestjs/common';
import { SupportService } from '../support/support.service';
import { AlertBotStatusService } from './alert-bot.status';

interface AlertBotIdentity {
  tgUserId: string;
  adminUserId: string;
}

@Injectable()
export class AlertBotCommands {
  constructor(
    private readonly statusService: AlertBotStatusService,
    private readonly support: SupportService,
  ) {}

  async start(): Promise<string> {
    return [
      'Команды бота:',
      '/ask <вопрос> — спросить ИИ о состоянии Linkeon;',
      '/status — краткая сводка алертов, здоровья сервисов и тикетов без вызова модели;',
      '/close #1234abcd — закрыть тикет по первым 8 символам его id.',
      '',
      'Ответ на сообщение об эскалации создаёт черновик: перед публикацией в тикет его нужно подтвердить кнопкой.',
    ].join('\n');
  }

  status(): Promise<string> {
    return this.statusService.summary();
  }

  async close(ref: string, identity: AlertBotIdentity): Promise<string> {
    const prefix = String(ref || '').trim().replace(/^#/, '');
    const short = /^[0-9a-f]{8}$/i.test(prefix);
    const full = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(prefix);
    if (!short && !full) return `Не нашёл тикет #${prefix}.`;

    let ticket: Awaited<ReturnType<SupportService['findTicketByPrefix']>>;
    try {
      ticket = await this.support.findTicketByPrefix(prefix);
    } catch (error) {
      if ((error as { name?: unknown })?.name !== 'TicketPrefixAmbiguousError') throw error;
      return 'Найдено несколько тикетов с таким префиксом. Укажите полный UUID.';
    }
    if (!ticket) return `Не нашёл тикет #${prefix}.`;

    await this.support.setStatusFromTelegram(ticket.id, identity.tgUserId, 'resolved', identity.adminUserId);
    return `✅ Тикет #${prefix} закрыт.`;
  }
}
