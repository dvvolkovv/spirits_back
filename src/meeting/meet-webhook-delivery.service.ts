import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { LiveKitClient } from '../voice-call/livekit.client';
import { VoiceCallService } from '../voice-call/voice-call.service';
import { ClaimedInboxEvent, MeetingWebhookInboxStore } from './meet-webhook-inbox.store';

const BATCH_SIZE = 20;
const CONCURRENCY = 5;
const SEND_TIMEOUT_MS = 10_000;
const MAX_ERROR_LEN = 500;
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000];
const RETRY_CAP_MS = 60_000;

/** Задержка перед следующей попыткой после `attempts`-й неудачной. */
export function retryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[attempts - 1] ?? RETRY_CAP_MS;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Фоновая доставка событий из inbox в LiveKit-комнату (at-least-once).
 *
 * Исход после send неопределён, если запись статуса упала: тогда событие
 * уйдёт повторно. Воркер идемпотентен к повторам join/leave/speech.
 */
@Injectable()
export class MeetingWebhookDeliveryService {
  private readonly logger = new Logger(MeetingWebhookDeliveryService.name);
  private running = false;

  constructor(
    private readonly inbox: MeetingWebhookInboxStore,
    private readonly calls: VoiceCallService,
    private readonly livekit: LiveKitClient,
  ) {}

  kick(): void {
    this.pump().catch((e: any) => {
      this.logger.error(`[meet] pump упал: ${e?.message}`);
    });
  }

  @Interval(1000)
  poll(): void {
    this.kick();
  }

  @Interval(60 * 60 * 1000)
  async retention(): Promise<void> {
    try {
      const r = await this.inbox.cleanup();
      this.logger.log(`[meet] cleanup inbox: completed=${r.completed} dead=${r.dead}`);
    } catch (e: any) {
      this.logger.error(`[meet] cleanup inbox упал: ${e?.message}`);
    }
  }

  async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const events = await this.inbox.claimBatch(BATCH_SIZE);
      await mapLimit(events, CONCURRENCY, (e) => this.process(e));
    } finally {
      this.running = false;
    }
  }

  private async process(event: ClaimedInboxEvent): Promise<void> {
    try {
      if (event.recovered) {
        this.logger.warn(`[meet] восстановлено после stale lease, event=${event.id}`);
      }
      const call = await this.calls.load(event.callId);
      if (!call || !this.calls.isActive(call)) {
        const ok = await this.inbox.markDiscarded(event.id, event.attempts, 'call missing or inactive');
        if (!ok) this.logger.debug(`[meet] stale discard, event=${event.id} attempt=${event.attempts}`);
        return;
      }
      await this.sendWithTimeout(call.room_name, event.message);
      const done = await this.inbox.markDelivered(event.id, event.attempts);
      if (!done) {
        this.logger.warn(`[meet] stale completion, event=${event.id} attempt=${event.attempts}`);
      }
    } catch (e: any) {
      await this.fail(event, e);
    }
  }

  private async sendWithTimeout(room: string, message: Record<string, unknown>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('livekit send timeout')), SEND_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.livekit.send(room, message as any), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fail(event: ClaimedInboxEvent, e: any): Promise<void> {
    const error = String(e?.message ?? e).slice(0, MAX_ERROR_LEN);
    const delay = retryDelayMs(event.attempts);
    try {
      const status = await this.inbox.markFailed(event.id, event.attempts, error, new Date(Date.now() + delay));
      const info = `event=${event.id} attempt=${event.attempts} status=${status} delay=${delay}ms error=${error}`;
      if (status === null) {
        this.logger.debug(`[meet] stale failure, ${info}`);
      } else if (status === 'dead') {
        this.logger.error(`[meet] событие мертво, ${info}`);
      } else {
        this.logger.warn(`[meet] доставка не удалась, повтор, ${info}`);
      }
    } catch (err: any) {
      this.logger.error(
        `[meet] markFailed упал, event=${event.id} attempt=${event.attempts}: ${err?.message}; исходная ошибка: ${error}`,
      );
    }
  }
}
