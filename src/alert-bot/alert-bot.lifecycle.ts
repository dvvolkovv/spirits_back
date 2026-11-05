import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { setAlertSentSink } from '../common/telegram-alert';
import { alertBotEnabled } from './alert-bot.config';
import { AlertBotOpsServer } from './alert-bot.ops-server';
import { AlertBotStore } from './alert-bot.store';
import { AlertBotTelegram } from './alert-bot.telegram';

@Injectable()
export class AlertBotLifecycle implements OnModuleInit, OnModuleDestroy {
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly logger = new Logger(AlertBotLifecycle.name);

  constructor(
    private readonly store: AlertBotStore,
    private readonly ops: AlertBotOpsServer,
    private readonly telegram: AlertBotTelegram,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.migrate();
    if (!alertBotEnabled()) return;
    const interrupted = await this.store.interruptInProgress();
    await this.ops.start();
    setAlertSentSink((chatId, messageId, text) => this.store.recordAlert(chatId, messageId, text));
    for (const turn of interrupted) {
      await this.telegram.sendMessage(turn.chatId, 'Ответ оборвался перезапуском — спросите ещё раз', turn.questionMessageId)
        .catch(() => {});
    }
    await this.store.cleanup().catch(() => {});
    this.cleanupTimer = setInterval(() => this.store.cleanup().catch(() => {}), 24 * 60 * 60 * 1000);
    this.cleanupTimer.unref();
    void this.telegram.registerWebhook().catch((e: any) => {
      this.logger.error(`alert-bot registration failed: ${e?.code || 'error'}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    setAlertSentSink(null);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.ops.stop();
  }
}
