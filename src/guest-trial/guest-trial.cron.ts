// src/guest-trial/guest-trial.cron.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GuestSessionsService } from './guest-sessions.service';

/** Уборка проб раз в час: обещание политики — 7 дней для неперенесённых. */
@Injectable()
export class GuestTrialCron {
  private readonly log = new Logger('GuestTrialCron');

  constructor(private readonly sessions: GuestSessionsService) {}

  @Cron('0 17 * * * *', { name: 'guest-trial-purge' })
  async purge(): Promise<void> {
    try {
      const n = await this.sessions.purge();
      if (n > 0) this.log.log(`guest trials purged: ${n}`);
    } catch (e: any) {
      this.log.warn(`guest trial purge failed: ${e?.message}`);
    }
  }
}
