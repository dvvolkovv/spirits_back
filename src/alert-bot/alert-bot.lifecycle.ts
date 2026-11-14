import {
  BeforeApplicationShutdown, Injectable, Logger, OnModuleDestroy, OnModuleInit,
} from '@nestjs/common';
import { setAlertSentSink } from '../common/telegram-alert';
import { PgService } from '../common/services/pg.service';
import { alertBotEnabled } from './alert-bot.config';
import { AlertBotOpsServer } from './alert-bot.ops-server';
import { RepairStore } from './alert-bot.repair-store';
import { AlertBotService } from './alert-bot.service';
import { AlertBotStore } from './alert-bot.store';
import { AlertBotTelegram } from './alert-bot.telegram';
import { AlertBotTurns } from './alert-bot.turns';

const SHUTDOWN_DRAIN_MS = 10000;
const RETRY_INTERVAL_MS = 5000;

@Injectable()
export class AlertBotLifecycle implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown {
  private cleanupTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private shutdown: Promise<void> | null = null;
  private retryRunning = false;
  private readonly logger = new Logger(AlertBotLifecycle.name);

  constructor(
    private readonly store: AlertBotStore,
    private readonly repairStore: RepairStore,
    private readonly ops: AlertBotOpsServer,
    private readonly telegram: AlertBotTelegram,
    private readonly turns: AlertBotTurns,
    private readonly service: AlertBotService,
    private readonly pg: PgService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.migrate();
    await this.repairStore.migrate();
    await this.repairStore.interruptActive();
    this.pg.registerPreCloseHook(() => this.beforeApplicationShutdown());
    await this.store.cleanup().catch(() => {});
    await this.repairStore.cleanup().catch(() => {});
    this.cleanupTimer = setInterval(() => {
      void this.store.cleanup().catch(() => {});
      void this.repairStore.cleanup().catch(() => {});
    }, 24 * 60 * 60 * 1000);
    this.cleanupTimer.unref();
    if (!alertBotEnabled()) return;
    await this.ops.start();
    const interrupted = await this.store.interruptInProgress();
    await this.store.requeueProcessingUpdates();
    setAlertSentSink((chatId, messageId, text) => this.store.recordAlert(chatId, messageId, text));
    for (const turn of interrupted) {
      await this.telegram.sendMessage(turn.chatId, 'Ответ оборвался перезапуском — спросите ещё раз', turn.questionMessageId)
        .catch(() => {});
    }
    this.retryTimer = setInterval(() => { void this.retryDue(); }, RETRY_INTERVAL_MS);
    this.retryTimer.unref();
    void this.telegram.registerWebhook().catch((e: any) => {
      this.logger.error(`alert-bot registration failed: ${e?.code || 'error'}`);
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.shutdown = (async () => {
      let timer: NodeJS.Timeout | undefined;
      let expired = false;
      try {
        const draining = (async () => {
          await this.service.stopAdmission();
          if (!expired) await this.turns.idle();
        })();
        await Promise.race([
          draining,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => { expired = true; resolve(); }, SHUTDOWN_DRAIN_MS);
            timer.unref();
          }),
        ]);
      } catch {
        this.logger.error('alert-bot shutdown drain failed kind=idle_failed');
      } finally {
        if (timer) clearTimeout(timer);
      }
      await this.ops.stop();
    })();
    return this.shutdown;
  }

  async onModuleDestroy(): Promise<void> {
    setAlertSentSink(null);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.cleanupTimer = null;
    this.retryTimer = null;
  }

  private async retryDue(): Promise<void> {
    if (this.retryRunning) return;
    this.retryRunning = true;
    try {
      await this.service.retryFailedUpdates();
    } catch {
      this.logger.error('alert-bot retry pass failed kind=retry_failed');
    } finally {
      this.retryRunning = false;
    }
  }
}
