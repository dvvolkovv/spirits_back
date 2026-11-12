import { Injectable } from '@nestjs/common';
import { isAlertBotRepairAdmin } from './alert-bot.config';
import { RepairStore } from './alert-bot.repair-store';
import { RepairIdentity } from './alert-bot.types';

@Injectable()
export class AlertBotRepairAuth {
  constructor(private readonly store: RepairStore) {}

  async authorize(identity: RepairIdentity): Promise<boolean> {
    return isAlertBotRepairAdmin(identity.adminTgId) && this.store.isActiveRepair(identity);
  }
}
