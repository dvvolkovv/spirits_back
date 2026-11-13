import { BadRequestException } from '@nestjs/common';
import axios from 'axios';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { DELETION_DISCOVERERS } from '../account-deletion/account-deletion.catalog';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { assertSafeJobSpec } from '../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import { TgBotModule } from './tg-bot.module';
import { TgBotController } from './tg-bot.controller';
import { TgBotService } from './tg-bot.service';
import { TgClaimService } from './tg-claim.service';
import { TgConfigService } from './tg-config.service';
import { TgIdentityService } from './tg-identity.service';
import { TgVideoDispatchService } from './tg-video-dispatch.service';

jest.mock('axios');

const axiosGet = axios.get as jest.Mock;
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const deletionId = '11111111-1111-4111-8111-111111111111';
const account: DeletionAccount = {
  userId: 'u-deleted',
  deletionId,
  deletedAt: new Date('2026-11-11T00:00:00Z'),
};

// require внутри теста позволяет независимым RED-фикстурам identity/video
// выполниться даже до появления нового adapter-файла.
function adapterModule(): any {
  return require('./tg-account-deletion.adapter');
}

interface FakeConfig {
  id: string;
  owner_user_id: string;
  tg_chat_id: string | null;
  tg_chat_title?: string | null;
  custom_agent_id: string | null;
  status: string;
  archived_at: string | null;
  display_name?: string;
}

class FakeDeletionDb {
  readonly users = new Map<string, { state: 'active' | 'deleted'; deletionId: string | null; deletedAt?: string }>();
  configs: FakeConfig[] = [];
  customAgents: Array<Record<string, any>> = [];
  claimTokens: Array<Record<string, any>> = [];
  messages: Array<Record<string, any>> = [];
  videoDeliveries: Array<Record<string, any>> = [];
  adminAgents: Array<Record<string, any>> = [];
  agentVersions: Array<Record<string, any>> = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  readonly events: string[] = [];
  beforeActivation: (() => Promise<void>) | null = null;
  private lockOwner: { key: number } | null = null;

  readonly tryAdvisoryLock = jest.fn(async (key: number) => {
    this.events.push(this.lockOwner ? `lock-busy:${key}` : `lock:${key}`);
    if (this.lockOwner) return null;
    this.lockOwner = { key };
    return {
      release: jest.fn(async () => {
        this.events.push(`release:${key}`);
        this.lockOwner = null;
      }),
    };
  });

  async query(sql: string, params: any[] = []): Promise<any> {
    const s = normalize(sql);
    this.queries.push({ sql: s, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(s)) return { rows: [], rowCount: 0 };
    if (s.includes("profile_data->>'language'")) return { rows: [{ language: 'ru' }] };

    if (s.startsWith('SELECT c.id,c.tg_chat_id FROM tg_bot_configs c WHERE c.owner_user_id=$1')) {
      const rows = this.configs
        .filter((config) => config.owner_user_id === params[0])
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((config) => ({ id: config.id, tg_chat_id: config.tg_chat_id }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT ca.id FROM custom_agents ca WHERE ca.owner_user_id=$1')) {
      const rows = this.customAgents
        .filter((agent) => agent.owner_user_id === params[0])
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((agent) => ({ id: agent.id }));
      return { rows, rowCount: rows.length };
    }

    if (s.startsWith('SELECT t.owner_user_id') && s.includes('FROM tg_claim_tokens t')) {
      const token = this.claimTokens.find((candidate) => candidate.token === params[0]
        && candidate.kind === 'claim' && candidate.consumed_at == null);
      if (!token) return { rows: [], rowCount: 0 };
      const config = this.configs.find((candidate) => candidate.id === token.config_id);
      return {
        rows: [{
          owner_user_id: token.owner_user_id,
          config_id: token.config_id,
          display_name: config?.display_name ?? null,
          status: config?.status ?? null,
        }],
        rowCount: 1,
      };
    }
    if (s.startsWith('SELECT id, owner_user_id FROM tg_bot_configs') && s.includes('id != $2')) {
      const rows = this.configs
        .filter((config) => config.id !== params[1] && config.tg_chat_id === String(params[0])
          && ['active', 'silent'].includes(config.status))
        .map((config) => ({ id: config.id, owner_user_id: config.owner_user_id }));
      return { rows: rows.slice(0, 1), rowCount: rows.length };
    }
    if (s.startsWith('UPDATE tg_claim_tokens SET consumed_at')) {
      const token = this.claimTokens.find((candidate) => candidate.token === params[0] && candidate.consumed_at == null);
      if (!token) return { rows: [], rowCount: 0 };
      token.consumed_at = '2026-11-11T00:00:00.000Z';
      return { rows: [{ token: token.token }], rowCount: 1 };
    }
    if (s.startsWith("UPDATE tg_bot_configs SET status = 'archived', archived_at = now() WHERE id = $1")) {
      const config = this.configs.find((candidate) => candidate.id === params[0]);
      if (!config) return { rows: [], rowCount: 0 };
      config.status = 'archived';
      this.events.push(`member-archive:${config.id}`);
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE tg_bot_configs SET tg_chat_id = $1')) {
      if (this.beforeActivation) await this.beforeActivation();
      const [chatId, title, configId, ownerId] = params;
      const config = this.configs.find((candidate) => candidate.id === configId);
      const activeGuard = s.includes("u.state='active'");
      if (!config || config.status !== 'pending'
        || (activeGuard && this.users.get(ownerId)?.state !== 'active')) {
        return { rows: [], rowCount: 0 };
      }
      config.tg_chat_id = String(chatId);
      config.tg_chat_title = title;
      config.status = 'active';
      this.events.push(`activate:${config.id}`);
      return { rows: [{ id: config.id }], rowCount: 1 };
    }
    if (s.startsWith('SELECT * FROM tg_bot_configs WHERE tg_chat_id = $1')
      || s.startsWith('SELECT c.* FROM tg_bot_configs c JOIN user_id')) {
      const activeAccountGuard = s.includes('JOIN user_id') && s.includes("u.state='active'");
      const rows = this.configs.filter((config) => config.tg_chat_id === String(params[0])
        && ['active', 'silent'].includes(config.status)
        && (!activeAccountGuard || this.users.get(config.owner_user_id)?.state === 'active'));
      return { rows: rows.slice(0, 1), rowCount: rows.length };
    }

    if (s.startsWith('SELECT 1 FROM tg_bot_configs other WHERE other.tg_chat_id=$1')) {
      const statuses = s.includes("'pending'") ? ['active', 'silent', 'pending'] : ['active', 'silent'];
      const rows = this.configs
        .filter((config) => config.id !== params[1]
          && config.tg_chat_id === params[0]
          && statuses.includes(config.status))
        .map(() => ({ '?column?': 1 }));
      return { rows: rows.slice(0, 1), rowCount: rows.length };
    }

    if (s.startsWith("UPDATE tg_bot_configs c SET status='archived'")) {
      this.requirePieces(s, [
        'c.id=$1',
        'c.owner_user_id=$2',
        'archived_at=COALESCE(archived_at,now())',
        "u.state='deleted'",
        'u.deletion_id=$3',
      ]);
      const [id, ownerId, currentDeletionId] = params;
      const config = this.configs.find((candidate) => candidate.id === id && candidate.owner_user_id === ownerId);
      const retryAware = s.includes("c.status IN ('pending','active','silent')")
        && s.includes('c.archived_at>=u.deleted_at');
      const deletionDate = this.users.get(ownerId)?.deletedAt ?? account.deletedAt.toISOString();
      const eligible = retryAware
        ? ['pending', 'active', 'silent'].includes(config?.status ?? '')
          || (config?.status === 'archived' && config.archived_at != null && config.archived_at >= deletionDate)
        : config?.status != null && ['active', 'silent'].includes(config.status);
      if (!config || !this.isCurrentDeletion(ownerId, currentDeletionId) || !eligible) {
        return { rows: [], rowCount: 0 };
      }
      config.status = 'archived';
      config.archived_at ??= deletionDate;
      return { rows: [{ tg_chat_id: config.tg_chat_id, archived_at: config.archived_at }], rowCount: 1 };
    }

    if (s.startsWith('UPDATE tg_claim_tokens t SET consumed_at=now()')) {
      this.requirePieces(s, [
        't.owner_user_id=$1',
        't.consumed_at IS NULL',
        "u.state='deleted'",
        'u.deletion_id=$2',
      ]);
      const [ownerId, currentDeletionId] = params;
      if (!this.isCurrentDeletion(ownerId, currentDeletionId)) return { rows: [], rowCount: 0 };
      let changed = 0;
      for (const token of this.claimTokens) {
        if (token.owner_user_id === ownerId && token.consumed_at == null) {
          token.consumed_at = '2026-11-11T00:00:00.000Z';
          changed += 1;
        }
      }
      return { rows: [], rowCount: changed };
    }

    if (s.startsWith("UPDATE tg_bot_video_jobs tg SET delivery_status='failed',delivery_error='account_deleted'")) {
      this.requirePieces(s, [
        'tg.config_id=$1',
        "tg.delivery_status='pending'",
        'c.owner_user_id=$2',
        "u.state='deleted'",
        'u.deletion_id=$3',
      ]);
      const [configId, ownerId, currentDeletionId] = params;
      const config = this.configs.find((candidate) => candidate.id === configId && candidate.owner_user_id === ownerId);
      if (!config || !this.isCurrentDeletion(ownerId, currentDeletionId)) return { rows: [], rowCount: 0 };
      let changed = 0;
      for (const delivery of this.videoDeliveries) {
        if (delivery.config_id === configId && delivery.delivery_status === 'pending') {
          delivery.delivery_status = 'failed';
          delivery.delivery_error = 'account_deleted';
          changed += 1;
        }
      }
      return { rows: [], rowCount: changed };
    }

    if (s.startsWith('DELETE FROM tg_claim_tokens t')) {
      this.requirePieces(s, [
        't.owner_user_id=$1',
        'u.internal_id=$1',
        "u.state='deleted'",
        'u.deletion_id=$2',
      ]);
      const [ownerId, currentDeletionId] = params;
      if (!this.isCurrentDeletion(ownerId, currentDeletionId)) return { rows: [], rowCount: 0 };
      const before = this.claimTokens.length;
      this.claimTokens = this.claimTokens.filter((token) => token.owner_user_id !== ownerId);
      return { rows: [], rowCount: before - this.claimTokens.length };
    }

    if (s.startsWith('DELETE FROM tg_bot_messages m')) {
      this.requirePieces(s, [
        'm.config_id=$1',
        'c.owner_user_id=$2',
        'u.internal_id=$2',
        "u.state='deleted'",
        'u.deletion_id=$3',
      ]);
      const [configId, ownerId, currentDeletionId] = params;
      const config = this.configs.find((candidate) => candidate.id === configId && candidate.owner_user_id === ownerId);
      if (!config || !this.isCurrentDeletion(ownerId, currentDeletionId)) return { rows: [], rowCount: 0 };
      const before = this.messages.length;
      this.messages = this.messages.filter((message) => message.config_id !== configId);
      return { rows: [], rowCount: before - this.messages.length };
    }

    if (s.startsWith('DELETE FROM tg_bot_configs c')) {
      this.requirePieces(s, [
        'c.id=$1',
        'c.owner_user_id=$2',
        'u.internal_id=$2',
        "u.state='deleted'",
        'u.deletion_id=$3',
      ]);
      const [configId, ownerId, currentDeletionId] = params;
      if (!this.isCurrentDeletion(ownerId, currentDeletionId)) return { rows: [], rowCount: 0 };
      const before = this.configs.length;
      this.configs = this.configs.filter((config) => !(config.id === configId && config.owner_user_id === ownerId));
      return { rows: [], rowCount: before - this.configs.length };
    }

    if (s.startsWith('DELETE FROM custom_agents ca')) {
      this.requirePieces(s, [
        'ca.id=$1',
        'ca.owner_user_id=$2',
        'NOT EXISTS',
        'c.custom_agent_id=ca.id',
        'u.internal_id=$2',
        "u.state='deleted'",
        'u.deletion_id=$3',
      ]);
      const [customAgentId, ownerId, currentDeletionId] = params;
      if (!this.isCurrentDeletion(ownerId, currentDeletionId)) return { rows: [], rowCount: 0 };
      if (this.configs.some((config) => config.custom_agent_id === customAgentId)) {
        return { rows: [], rowCount: 0 };
      }
      const before = this.customAgents.length;
      this.customAgents = this.customAgents.filter((agent) => !(
        agent.id === customAgentId && agent.owner_user_id === ownerId
      ));
      return { rows: [], rowCount: before - this.customAgents.length };
    }

    throw new Error(`unexpected query: ${s}`);
  }

  async getClient(): Promise<any> {
    return {
      query: (sql: string, params: any[] = []) => this.query(sql, params),
      release: jest.fn(),
    };
  }

  isCurrentDeletion(userId: string, currentDeletionId: string): boolean {
    const user = this.users.get(userId);
    return user?.state === 'deleted' && user.deletionId === currentDeletionId;
  }

  private requirePieces(sql: string, pieces: string[]): void {
    for (const piece of pieces) {
      if (!sql.includes(piece)) throw new Error(`missing deletion predicate: ${piece}`);
    }
  }
}

function job(
  resourceType: DeletionResourceType,
  resourceKey: string,
  payload: Record<string, unknown> = {},
): DeletionJobRow {
  return {
    id: `job-${resourceType}-${resourceKey}`,
    deletionId,
    userId: account.userId,
    resourceType,
    resourceKey,
    phase: resourceType === 'telegram.stop' ? 'immediate' : 'purge',
    payload,
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-11-11T00:00:00Z'),
    leaseUntil: new Date('2026-11-11T01:00:00Z'),
    lastErrorKind: null,
  };
}

function execution(db: FakeDeletionDb): DeletionExecution & { assertCurrent: jest.Mock } {
  return { db: db as any, assertCurrent: jest.fn(async () => {}) };
}

function makeAdapter(db: FakeDeletionDb, grammy: any) {
  const configs = new TgConfigService(db as any, grammy);
  const { TgAccountDeletionAdapter } = adapterModule();
  const registry = new AccountDeletionRegistry();
  const adapter = new TgAccountDeletionAdapter(db as any, configs, registry);
  return { adapter, configs, registry };
}

function makeClaimService(db: FakeDeletionDb): TgClaimService {
  const identity = {
    getIdentityByLinkeonId: jest.fn(async (ownerId: string) => ({
      tgUserId: ownerId === 'u-neighbor' ? 20002 : 10001,
      tgUsername: null,
      tgFirstName: null,
    })),
  };
  return new TgClaimService(db as any, identity as any);
}

function claimToken(configId: string, ownerId: string, token: string): Record<string, any> {
  return {
    token,
    kind: 'claim',
    owner_user_id: ownerId,
    config_id: configId,
    consumed_at: null,
    expires_at: '2026-11-12T00:00:00.000Z',
  };
}

function makeControllerLifecycleBot(db: FakeDeletionDb) {
  const tgIds: Record<string, number> = { 'u-neighbor': 20002, 'u-other': 10001, 'u-live': 30003 };
  const identity = {
    getIdentityByLinkeonId: jest.fn(async (ownerId: string) => ({
      tgUserId: tgIds[ownerId],
      tgUsername: null,
      tgFirstName: null,
    })),
    getLinkeonIdByTgUserId: jest.fn(async (tgUserId: number) =>
      Object.keys(tgIds).find((ownerId) => tgIds[ownerId] === tgUserId) ?? null),
  };
  const grammy = {
    sendMessage: jest.fn(async () => ({})),
    leaveChat: jest.fn(async () => true),
  };
  const configs = new TgConfigService(db as any, grammy as any);
  const claim = new TgClaimService(db as any, identity as any);
  const bot = new TgBotService(
    db as any, identity as any, claim, configs,
    null as any, null as any, null as any, null as any, null as any,
    grammy as any, null as any, null as any, null as any,
  );
  (bot as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const controller = new TgBotController(bot);
  const callController = async (token: string, tgUserId: number) => {
    const req = {
      headers: { 'x-telegram-bot-api-secret-token': 'header-secret' },
      body: {
        message: {
          chat: { id: -100200, type: 'supergroup', title: 'Shared group' },
          from: { id: tgUserId },
          text: `/start@LinkeonAgentBot ${token}`,
        },
      },
    } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;
    await controller.handle('url-secret', req, res);
    return res;
  };
  return { bot, controller, callController, configs, claim, grammy, identity };
}

function ownConfig(overrides: Partial<FakeConfig> = {}): FakeConfig {
  return {
    id: 'cfg-1',
    owner_user_id: account.userId,
    tg_chat_id: '-100200',
    custom_agent_id: 'ca-1',
    status: 'active',
    archived_at: null,
    display_name: 'ЛИЧНЫЙ-ТЕКСТ',
    ...overrides,
  };
}

describe('Telegram/custom-agent deletion discovery', () => {
  it('создаёт stop/purge по configs и custom agents только с техническими payload', async () => {
    const { discoverTelegramDeletion } = adapterModule();
    const db = new FakeDeletionDb();
    db.configs = [
      ownConfig({ id: 'cfg-2', tg_chat_id: null, custom_agent_id: 'ca-2' }),
      ownConfig(),
      ownConfig({ id: 'cfg-neighbor', owner_user_id: 'u-neighbor', custom_agent_id: 'ca-neighbor' }),
    ];
    db.customAgents = [
      { id: 'ca-2', owner_user_id: account.userId, system_prompt: 'СЕКРЕТ-НЕ-ЛОГИРОВАТЬ' },
      { id: 'ca-1', owner_user_id: account.userId, system_prompt: 'ЛИЧНЫЙ-ТЕКСТ' },
      { id: 'ca-neighbor', owner_user_id: 'u-neighbor', system_prompt: 'neighbor' },
    ];

    const plan = await discoverTelegramDeletion({ db: db as any, account, origin: 'explicit' });

    expect(plan.jobs.map((item: any) => [item.resourceType, item.resourceKey, item.phase, item.payload])).toEqual([
      ['telegram.stop', 'cfg-1', 'immediate', { chatId: '-100200' }],
      ['telegram.purge', 'cfg-1', 'purge', {}],
      ['telegram.stop', 'cfg-2', 'immediate', { chatId: null }],
      ['telegram.purge', 'cfg-2', 'purge', {}],
      ['custom-agent.purge', 'ca-1', 'purge', {}],
      ['custom-agent.purge', 'ca-2', 'purge', {}],
    ]);
    for (const item of plan.jobs) assertSafeJobSpec(item, account.userId);
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('ЛИЧНЫЙ-ТЕКСТ');
    expect(serialized).not.toContain('СЕКРЕТ-НЕ-ЛОГИРОВАТЬ');
    expect(serialized).not.toContain(account.userId);
    expect(serialized).not.toContain('token');
    expect(await discoverTelegramDeletion({ db: db as any, account, origin: 'explicit' })).toEqual(plan);
  });
});

describe('TgAccountDeletionAdapter stop', () => {
  it('timeout leaveChat сохраняет chatId/config для retry и не завершает running job', async () => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.users.set('u-neighbor', { state: 'active', deletionId: null });
    db.configs = [ownConfig(), ownConfig({ id: 'cfg-neighbor', owner_user_id: 'u-neighbor', tg_chat_id: '-100201', custom_agent_id: null })];
    db.claimTokens = [
      { token: 'own-auth', owner_user_id: account.userId, consumed_at: null },
      { token: 'neighbor-auth', owner_user_id: 'u-neighbor', consumed_at: null },
    ];
    db.videoDeliveries = [
      { job_id: 'video-own', config_id: 'cfg-1', delivery_status: 'pending', delivery_error: null },
      { job_id: 'video-neighbor', config_id: 'cfg-neighbor', delivery_status: 'pending', delivery_error: null },
    ];
    const grammy = { leaveChat: jest.fn() };
    grammy.leaveChat.mockRejectedValue({ code: 'ETIMEDOUT' });
    const { adapter } = makeAdapter(db, grammy);
    const stop = job('telegram.stop', 'cfg-1', { chatId: '-100200' });

    await expect(adapter.execute(stop, execution(db))).rejects.toMatchObject({ kind: 'timeout' });

    expect(stop.payload).toEqual({ chatId: '-100200' });
    expect(stop.status).toBe('running');
    expect(db.configs.find((config) => config.id === 'cfg-1')).toMatchObject({
      id: 'cfg-1', status: 'archived',
    });
    expect(grammy.leaveChat).toHaveBeenCalledWith(-100200);
    expect(db.claimTokens.find((token) => token.token === 'own-auth')?.consumed_at).not.toBeNull();
    expect(db.claimTokens.find((token) => token.token === 'neighbor-auth')?.consumed_at).toBeNull();
    expect(db.videoDeliveries).toEqual([
      { job_id: 'video-own', config_id: 'cfg-1', delivery_status: 'failed', delivery_error: 'account_deleted' },
      { job_id: 'video-neighbor', config_id: 'cfg-neighbor', delivery_status: 'pending', delivery_error: null },
    ]);

    grammy.leaveChat.mockResolvedValue(true);
    await adapter.execute(stop, execution(db));
    await adapter.execute(stop, execution(db));
    expect(stop.payload).toEqual({ chatId: '-100200' });
  });

  it.each([
    [{ response: { status: 400 }, description: 'Bad Request: chat not found' }],
    [{ response: { status: 403 }, description: 'Forbidden: bot was kicked from the group chat' }],
    [{ error_code: 404, description: 'Not Found: chat not found' }],
  ])('подтверждённое отсутствие в Telegram = успешный идемпотентный stop', async (failure) => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.configs = [ownConfig({ archived_at: '2026-11-01T00:00:00.000Z' })];
    const grammy = { leaveChat: jest.fn(async () => { throw failure; }) };
    const { adapter } = makeAdapter(db, grammy);
    const stop = job('telegram.stop', 'cfg-1', { chatId: '-100200' });

    await adapter.execute(stop, execution(db));
    await adapter.execute(stop, execution(db));

    expect(db.configs[0].archived_at).toBe('2026-11-01T00:00:00.000Z');
    expect(stop.payload).toEqual({ chatId: '-100200' });
  });

  it('unknown Telegram 400 не считается отсутствием и остаётся retry', async () => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.configs = [ownConfig()];
    const grammy = { leaveChat: jest.fn(async () => {
      throw { response: { status: 400 }, description: 'Bad Request: unknown outcome' };
    }) };
    const { adapter } = makeAdapter(db, grammy);

    await expect(adapter.execute(job('telegram.stop', 'cfg-1', { chatId: '-100200' }), execution(db)))
      .rejects.toMatchObject({ kind: 'external_4xx' });
    expect(db.configs[0].status).toBe('archived');
  });

  it('уже archived A + active B в том же chat: leaveChat не вызывается, B/history целы', async () => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.users.set('u-neighbor', { state: 'active', deletionId: null });
    db.configs = [
      ownConfig({ status: 'archived', archived_at: '2026-10-01T00:00:00.000Z' }),
      ownConfig({ id: 'cfg-neighbor', owner_user_id: 'u-neighbor', custom_agent_id: 'ca-neighbor' }),
    ];
    db.messages = [{ id: 2, config_id: 'cfg-neighbor', content: 'neighbor history' }];
    const grammy = { leaveChat: jest.fn(async () => true) };
    const { adapter } = makeAdapter(db, grammy);

    await adapter.execute(job('telegram.stop', 'cfg-1', { chatId: '-100200' }), execution(db));

    expect(grammy.leaveChat).not.toHaveBeenCalled();
    expect(db.configs.find((config) => config.id === 'cfg-neighbor')?.status).toBe('active');
    expect(db.messages).toEqual([{ id: 2, config_id: 'cfg-neighbor', content: 'neighbor history' }]);
  });

  it('A active + B active shared bot/chat: A архивируется локально, но живого B не выгоняет', async () => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.users.set('u-neighbor', { state: 'active', deletionId: null });
    db.configs = [
      ownConfig(),
      ownConfig({ id: 'cfg-neighbor', owner_user_id: 'u-neighbor', custom_agent_id: 'ca-neighbor' }),
    ];
    db.messages = [{ id: 2, config_id: 'cfg-neighbor', content: 'neighbor history' }];
    const grammy = { leaveChat: jest.fn(async () => true) };
    const { adapter } = makeAdapter(db, grammy);

    await adapter.execute(job('telegram.stop', 'cfg-1', { chatId: '-100200' }), execution(db));

    expect(db.configs.find((config) => config.id === 'cfg-1')?.status).toBe('archived');
    expect(db.configs.find((config) => config.id === 'cfg-neighbor')?.status).toBe('active');
    expect(grammy.leaveChat).not.toHaveBeenCalled();
    expect(db.messages).toEqual([{ id: 2, config_id: 'cfg-neighbor', content: 'neighbor history' }]);
  });

  it('reactivation old generation не архивирует, не гасит tokens/video и не вызывает leaveChat', async () => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'active', deletionId: 'deletion-new' });
    db.configs = [ownConfig()];
    db.claimTokens = [{ token: 'new-auth', owner_user_id: account.userId, consumed_at: null }];
    db.videoDeliveries = [{ job_id: 'video-new', config_id: 'cfg-1', delivery_status: 'pending', delivery_error: null }];
    const grammy = { leaveChat: jest.fn(async () => true) };
    const { adapter } = makeAdapter(db, grammy);

    await adapter.execute(job('telegram.stop', 'cfg-1', { chatId: '-100200' }), execution(db));

    expect(db.configs[0].status).toBe('active');
    expect(db.claimTokens[0].consumed_at).toBeNull();
    expect(db.videoDeliveries[0].delivery_status).toBe('pending');
    expect(grammy.leaveChat).not.toHaveBeenCalled();
  });
});

describe('TG archive/claim lifecycle locking', () => {
  it('timeout → archived current deletion обязан повторить leave; давно archived не вызывает external', async () => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'deleted', deletionId, deletedAt: account.deletedAt.toISOString() });
    db.configs = [ownConfig()];
    const grammy = { leaveChat: jest.fn() };
    grammy.leaveChat
      .mockImplementationOnce(async () => {
        db.events.push('leave:1');
        throw { code: 'ETIMEDOUT' };
      })
      .mockImplementationOnce(async () => {
        db.events.push('leave:2');
        return true;
      });
    const { adapter } = makeAdapter(db, grammy);
    const stop = job('telegram.stop', 'cfg-1', { chatId: '-100200' });

    await expect(adapter.execute(stop, execution(db))).rejects.toMatchObject({ kind: 'timeout' });
    expect(db.configs[0].status).toBe('archived');
    await adapter.execute(stop, execution(db));

    expect(grammy.leaveChat).toHaveBeenCalledTimes(2);
    const key = db.tryAdvisoryLock.mock.calls[0]?.[0];
    expect(key).toEqual(expect.any(Number));
    expect(db.events).toEqual([
      `lock:${key}`, 'leave:1', `release:${key}`,
      `lock:${key}`, 'leave:2', `release:${key}`,
    ]);

    const old = new FakeDeletionDb();
    old.users.set(account.userId, { state: 'deleted', deletionId, deletedAt: account.deletedAt.toISOString() });
    old.configs = [ownConfig({ status: 'archived', archived_at: '2026-10-01T00:00:00.000Z' })];
    const oldGrammy = { leaveChat: jest.fn(async () => true) };
    const { adapter: oldAdapter } = makeAdapter(old, oldGrammy);
    await oldAdapter.execute(stop, execution(old));
    expect(oldGrammy.leaveChat).not.toHaveBeenCalled();
  });

  it('B pending до archive lock блокирует leave; B активируется после без выгнанного бота', async () => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'deleted', deletionId, deletedAt: account.deletedAt.toISOString() });
    db.users.set('u-neighbor', { state: 'active', deletionId: null });
    db.configs = [
      ownConfig(),
      ownConfig({ id: 'cfg-b', owner_user_id: 'u-neighbor', status: 'pending', custom_agent_id: 'ca-b' }),
    ];
    db.claimTokens = [claimToken('cfg-b', 'u-neighbor', 'claim-b')];
    const grammy = { leaveChat: jest.fn(async () => true) };
    const { adapter } = makeAdapter(db, grammy);
    const claim = makeClaimService(db);

    await adapter.execute(job('telegram.stop', 'cfg-1', { chatId: '-100200' }), execution(db));
    await claim.claim('claim-b', 20002, -100200, 'B');

    expect(grammy.leaveChat).not.toHaveBeenCalled();
    expect(db.configs.find((config) => config.id === 'cfg-b')?.status).toBe('active');
    expect(db.tryAdvisoryLock.mock.calls.length).toBe(2);
    expect(db.tryAdvisoryLock.mock.calls[0][0]).toBe(db.tryAdvisoryLock.mock.calls[1][0]);
    expect(db.events.filter((event) => event.startsWith('release:'))).toHaveLength(2);
  });

  it('B activation держит lock: A stop получает retry, не leave; после B active stop завершается локально', async () => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'deleted', deletionId, deletedAt: account.deletedAt.toISOString() });
    db.users.set('u-neighbor', { state: 'active', deletionId: null });
    db.configs = [
      ownConfig({ status: 'archived', archived_at: account.deletedAt.toISOString() }),
      ownConfig({ id: 'cfg-b', owner_user_id: 'u-neighbor', status: 'pending', tg_chat_id: null, custom_agent_id: 'ca-b' }),
    ];
    db.claimTokens = [claimToken('cfg-b', 'u-neighbor', 'claim-b')];
    let entered!: () => void;
    const activationEntered = new Promise<void>((resolve) => { entered = resolve; });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    db.beforeActivation = async () => { entered(); await gate; };
    const claim = makeClaimService(db);
    const grammy = { leaveChat: jest.fn(async () => true) };
    const { adapter } = makeAdapter(db, grammy);
    const stop = job('telegram.stop', 'cfg-1', { chatId: '-100200' });

    const claiming = claim.claim('claim-b', 20002, -100200, 'B');
    await activationEntered;
    const first = await adapter.execute(stop, execution(db)).then(() => null).catch((error) => error);
    openGate();
    await claiming;
    const second = await adapter.execute(stop, execution(db)).then(() => null).catch((error) => error);

    expect(first).toMatchObject({ kind: 'external_unknown' });
    expect(second).toBeNull();
    expect(grammy.leaveChat).not.toHaveBeenCalled();
    expect(db.configs.find((config) => config.id === 'cfg-b')?.status).toBe('active');
    expect(db.tryAdvisoryLock.mock.calls.length).toBe(3);
    const keys = db.tryAdvisoryLock.mock.calls.map(([key]) => key);
    expect(new Set(keys).size).toBe(1);
    expect(db.events.filter((event) => event.startsWith('release:'))).toHaveLength(2);
  });

  it('A leave держит lock: пришедший B не активируется до release, повтор после leave успешен', async () => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'deleted', deletionId, deletedAt: account.deletedAt.toISOString() });
    db.users.set('u-neighbor', { state: 'active', deletionId: null });
    db.configs = [ownConfig()];
    const claim = makeClaimService(db);
    let during: any;
    const grammy = {
      leaveChat: jest.fn(async () => {
        db.events.push('leave:start');
        db.configs.push(ownConfig({
          id: 'cfg-b', owner_user_id: 'u-neighbor', status: 'pending', tg_chat_id: null, custom_agent_id: 'ca-b',
        }));
        db.claimTokens.push(claimToken('cfg-b', 'u-neighbor', 'claim-b'));
        during = await claim.claim('claim-b', 20002, -100200, 'B').then(() => null).catch((error) => error);
        db.events.push('leave:end');
        return true;
      }),
    };
    const { adapter } = makeAdapter(db, grammy);

    await adapter.execute(job('telegram.stop', 'cfg-1', { chatId: '-100200' }), execution(db));
    const retry = await claim.claim('claim-b', 20002, -100200, 'B').then(() => null).catch((error) => error);

    expect(during).toMatchObject({ claimFailure: 'group_taken' });
    expect(retry).toBeNull();
    expect(db.events.indexOf('leave:end')).toBeLessThan(db.events.indexOf('activate:cfg-b'));
    expect(db.configs.find((config) => config.id === 'cfg-b')?.status).toBe('active');
    expect(db.tryAdvisoryLock.mock.calls.length).toBe(3);
    expect(new Set(db.tryAdvisoryLock.mock.calls.map(([key]) => key)).size).toBe(1);
    expect(db.events.filter((event) => event.startsWith('release:'))).toHaveLength(2);
  });

  it('pending stop архивирует config, late claim не активирует, deleted active config не находится group flow', async () => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'deleted', deletionId, deletedAt: account.deletedAt.toISOString() });
    db.configs = [ownConfig({ status: 'pending', tg_chat_id: null })];
    const grammy = { leaveChat: jest.fn(async () => true) };
    const { adapter, configs } = makeAdapter(db, grammy);
    const claim = makeClaimService(db);

    await adapter.execute(job('telegram.stop', 'cfg-1', { chatId: null }), execution(db));
    db.claimTokens.push(claimToken('cfg-1', account.userId, 'late-claim'));
    const late = await claim.claim('late-claim', 10001, -100200, 'Late').then(() => null).catch((error) => error);
    db.configs.push(ownConfig({ id: 'cfg-deleted-active', tg_chat_id: '-100999', status: 'active' }));

    expect(late).toMatchObject({ claimFailure: 'expired' });
    expect(db.configs.find((config) => config.id === 'cfg-1')?.status).toBe('archived');
    expect(await configs.getActiveByTgChatId(-100200)).toBeNull();
    expect(await configs.getActiveByTgChatId(-100999)).toBeNull();
    expect(grammy.leaveChat).not.toHaveBeenCalled();
  });
});

describe('TG controller claim busy loser', () => {
  let previousEnv: Record<string, string | undefined>;

  beforeEach(() => {
    previousEnv = {
      TG_BOT_USERNAME: process.env.TG_BOT_USERNAME,
      TG_WEBHOOK_URL_SECRET: process.env.TG_WEBHOOK_URL_SECRET,
      TG_WEBHOOK_HEADER_SECRET: process.env.TG_WEBHOOK_HEADER_SECRET,
    };
    process.env.TG_BOT_USERNAME = 'LinkeonAgentBot';
    process.env.TG_WEBHOOK_URL_SECRET = 'url-secret';
    process.env.TG_WEBHOOK_HEADER_SECRET = 'header-secret';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('B1 busy не вызывает leave; B2 active после commit и my_chat_member не отменяет claim', async () => {
    const db = new FakeDeletionDb();
    db.users.set('u-neighbor', { state: 'active', deletionId: null });
    db.users.set('u-other', { state: 'active', deletionId: null });
    db.configs = [
      ownConfig({ id: 'cfg-b2', owner_user_id: 'u-neighbor', status: 'pending', tg_chat_id: null, custom_agent_id: 'ca-b2' }),
      ownConfig({ id: 'cfg-b1', owner_user_id: 'u-other', status: 'pending', tg_chat_id: null, custom_agent_id: 'ca-b1' }),
    ];
    db.claimTokens = [
      claimToken('cfg-b2', 'u-neighbor', 'claim-b2'),
      claimToken('cfg-b1', 'u-other', 'claim-b1'),
    ];
    const { bot, callController, grammy } = makeControllerLifecycleBot(db);
    let activationEntered!: () => void;
    const entered = new Promise<void>((resolve) => { activationEntered = resolve; });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    db.beforeActivation = async () => { activationEntered(); await gate; };
    let b1Finished!: () => void;
    let b2Finished!: () => void;
    const b1Done = new Promise<void>((resolve) => { b1Finished = resolve; });
    const b2Done = new Promise<void>((resolve) => { b2Finished = resolve; });
    const originalUpdate = bot.handleUpdate.bind(bot);
    jest.spyOn(bot, 'handleUpdate').mockImplementation(async (update: any) => {
      const token = update.message?.text?.split(' ').pop();
      await originalUpdate(update);
      if (token === 'claim-b1') b1Finished();
      if (token === 'claim-b2') b2Finished();
    });

    await callController('claim-b2', 20002);
    await callController('claim-b1', 10001);
    await entered;
    await b1Done;
    const loserLeaves = grammy.leaveChat.mock.calls.length;
    openGate();
    await b2Done;
    if (loserLeaves > 0) {
      await bot.handleUpdate({
        my_chat_member: {
          chat: { id: -100200, type: 'supergroup', title: 'Shared group' },
          new_chat_member: { status: 'left' },
        },
      });
    }

    expect(loserLeaves).toBe(0);
    expect(db.configs.find((config) => config.id === 'cfg-b2')?.status).toBe('active');
    expect(db.configs.find((config) => config.id === 'cfg-b1')?.status).toBe('pending');
    expect(db.events).not.toContain('member-archive:cfg-b2');
  });

  it('настоящий preexisting active conflict по-прежнему не вызывает leave', async () => {
    const db = new FakeDeletionDb();
    db.users.set('u-live', { state: 'active', deletionId: null });
    db.users.set('u-neighbor', { state: 'active', deletionId: null });
    db.configs = [
      ownConfig({ id: 'cfg-live', owner_user_id: 'u-live', status: 'active', custom_agent_id: 'ca-live' }),
      ownConfig({ id: 'cfg-b', owner_user_id: 'u-neighbor', status: 'pending', tg_chat_id: null, custom_agent_id: 'ca-b' }),
    ];
    db.claimTokens = [claimToken('cfg-b', 'u-neighbor', 'claim-b')];
    const { bot, callController, grammy } = makeControllerLifecycleBot(db);
    let finished!: () => void;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    const originalUpdate = bot.handleUpdate.bind(bot);
    jest.spyOn(bot, 'handleUpdate').mockImplementation(async (update: any) => {
      await originalUpdate(update);
      finished();
    });

    await callController('claim-b', 20002);
    await done;

    expect(grammy.leaveChat).not.toHaveBeenCalled();
    expect(db.configs.find((config) => config.id === 'cfg-live')?.status).toBe('active');
    expect(db.configs.find((config) => config.id === 'cfg-b')?.status).toBe('pending');
  });
});

describe('TgAccountDeletionAdapter purge', () => {
  function purgeFixture() {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.configs = [ownConfig({ status: 'archived' })];
    db.customAgents = [{ id: 'ca-1', owner_user_id: account.userId, system_prompt: 'ЛИЧНЫЙ-ТЕКСТ' }];
    db.claimTokens = [{ token: 'own-claim', owner_user_id: account.userId, consumed_at: null }];
    db.messages = [{ id: 1, config_id: 'cfg-1', content: 'ЛИЧНЫЙ-ТЕКСТ' }];
    db.adminAgents = [{ id: 'admin-agent' }];
    db.agentVersions = [{ id: 'admin-version', agent_id: 'admin-agent' }];
    const grammy = { leaveChat: jest.fn(async () => true) };
    return { db, ...makeAdapter(db, grammy) };
  }

  it('custom purge до config purge сохраняет FK, после него удаляет; admin agents/versions остаются', async () => {
    const { db, adapter } = purgeFixture();
    const configPurge = job('telegram.purge', 'cfg-1');
    const customPurge = job('custom-agent.purge', 'ca-1');

    await adapter.execute(customPurge, execution(db));
    expect(db.customAgents).toHaveLength(1);
    await adapter.execute(configPurge, execution(db));
    await adapter.execute(customPurge, execution(db));
    await adapter.execute(configPurge, execution(db));
    await adapter.execute(customPurge, execution(db));

    expect(db.claimTokens).toHaveLength(0);
    expect(db.messages).toHaveLength(0);
    expect(db.configs).toHaveLength(0);
    expect(db.customAgents).toHaveLength(0);
    expect(db.adminAgents).toHaveLength(1);
    expect(db.agentVersions).toHaveLength(1);

    const statements = db.queries.map(({ sql }) => sql);
    const begin = statements.indexOf('BEGIN');
    const commit = statements.indexOf('COMMIT');
    const tokens = statements.findIndex((sql) => sql.startsWith('DELETE FROM tg_claim_tokens'));
    const messages = statements.findIndex((sql) => sql.startsWith('DELETE FROM tg_bot_messages'));
    const configs = statements.findIndex((sql) => sql.startsWith('DELETE FROM tg_bot_configs'));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    expect(tokens).toBeGreaterThan(begin);
    expect(messages).toBeGreaterThan(tokens);
    expect(configs).toBeGreaterThan(messages);
    expect(configs).toBeLessThan(commit);
    expect(statements.some((sql) => /^(DELETE FROM|UPDATE) (agents|agent_versions)\b/.test(sql))).toBe(false);
  });

  it('каждый destructive statement сам содержит owner/state/deletion predicate', async () => {
    const { db, adapter } = purgeFixture();
    db.videoDeliveries = [{ job_id: 'video-own', config_id: 'cfg-1', delivery_status: 'pending', delivery_error: null }];
    await adapter.execute(job('telegram.stop', 'cfg-1', { chatId: '-100200' }), execution(db));
    await adapter.execute(job('telegram.purge', 'cfg-1'), execution(db));
    await adapter.execute(job('custom-agent.purge', 'ca-1'), execution(db));

    const sql = db.queries.map(({ sql }) => sql);
    const archive = sql.find((query) => query.startsWith("UPDATE tg_bot_configs c SET status='archived'"))!;
    const stopTokens = sql.find((query) => query.startsWith('UPDATE tg_claim_tokens'))!;
    const stopVideo = sql.find((query) => query.startsWith('UPDATE tg_bot_video_jobs'))!;
    const purgeTokens = sql.find((query) => query.startsWith('DELETE FROM tg_claim_tokens'))!;
    const purgeMessages = sql.find((query) => query.startsWith('DELETE FROM tg_bot_messages'))!;
    const purgeConfig = sql.find((query) => query.startsWith('DELETE FROM tg_bot_configs'))!;
    const purgeCustom = sql.find((query) => query.startsWith('DELETE FROM custom_agents'))!;
    for (const query of [archive, stopTokens, stopVideo, purgeTokens, purgeMessages, purgeConfig, purgeCustom]) {
      expect(query).toContain("u.state='deleted'");
      expect(query).toMatch(/u\.deletion_id=\$[23]/);
    }
    expect(archive).toContain('c.owner_user_id=$2');
    expect(stopTokens).toContain('t.owner_user_id=$1');
    expect(stopVideo).toContain('c.owner_user_id=$2');
    expect(purgeTokens).toContain('t.owner_user_id=$1');
    expect(purgeMessages).toContain('c.owner_user_id=$2');
    expect(purgeConfig).toContain('c.owner_user_id=$2');
    expect(purgeCustom).toContain('ca.owner_user_id=$2');
    expect(purgeCustom).toContain('NOT EXISTS');
  });

  it('repeat/reactivation/neighbor: чужая group config и history сохраняются, старое удаление ничего не удаляет', async () => {
    const { db, adapter } = purgeFixture();
    db.users.set('u-neighbor', { state: 'active', deletionId: null });
    db.configs.push(ownConfig({ id: 'cfg-neighbor', owner_user_id: 'u-neighbor', custom_agent_id: 'ca-neighbor' }));
    db.customAgents.push({ id: 'ca-neighbor', owner_user_id: 'u-neighbor' });
    db.claimTokens.push({ token: 'neighbor-claim', owner_user_id: 'u-neighbor', consumed_at: null });
    db.messages.push({ id: 2, config_id: 'cfg-neighbor', content: 'neighbor history' });

    await adapter.execute(job('telegram.purge', 'cfg-1'), execution(db));
    await adapter.execute(job('telegram.purge', 'cfg-1'), execution(db));
    await adapter.execute(job('custom-agent.purge', 'ca-1'), execution(db));
    await adapter.execute(job('custom-agent.purge', 'ca-1'), execution(db));

    expect(db.configs).toEqual([expect.objectContaining({ id: 'cfg-neighbor', status: 'active' })]);
    expect(db.messages).toEqual([expect.objectContaining({ id: 2, config_id: 'cfg-neighbor' })]);
    expect(db.claimTokens).toEqual([expect.objectContaining({ token: 'neighbor-claim' })]);
    expect(db.customAgents).toEqual([expect.objectContaining({ id: 'ca-neighbor' })]);

    db.configs.unshift(ownConfig({ status: 'archived' }));
    db.customAgents.unshift({ id: 'ca-1', owner_user_id: account.userId });
    db.users.set(account.userId, { state: 'active', deletionId: 'deletion-new' });
    await adapter.execute(job('telegram.purge', 'cfg-1'), execution(db));
    await adapter.execute(job('custom-agent.purge', 'ca-1'), execution(db));
    expect(db.configs.some((config) => config.id === 'cfg-1')).toBe(true);
    expect(db.customAgents.some((agent) => agent.id === 'ca-1')).toBe(true);
  });

  it('регистрирует все три resource types без assertReady; module/catalog wiring однократный', () => {
    const db = new FakeDeletionDb();
    const grammy = { leaveChat: jest.fn(async () => true) };
    const { adapter, registry } = makeAdapter(db, grammy);
    const { discoverTelegramDeletion, TgAccountDeletionAdapter } = adapterModule();
    const ready = jest.spyOn(registry, 'assertReady');

    adapter.onModuleInit();

    for (const resourceType of ['telegram.stop', 'telegram.purge', 'custom-agent.purge'] as const) {
      expect(registry.getExecutor(resourceType)).toBe(adapter);
    }
    expect(ready).not.toHaveBeenCalled();
    expect(DELETION_DISCOVERERS.filter((item) => item === discoverTelegramDeletion)).toHaveLength(1);
    expect(Reflect.getMetadata('providers', TgBotModule)).toContain(TgAccountDeletionAdapter);
    expect(Reflect.getMetadata('imports', TgBotModule)).toContain(AccountDeletionModule);
  });
});

describe('deleted account не восстанавливает Telegram identity/config', () => {
  it('consumeAuthToken для deleted отклоняет token, не гасит его и не меняет identity', async () => {
    const calls: string[] = [];
    let tokenConsumed = false;
    let identityInserted = false;
    const client = {
      query: jest.fn(async (sql: string) => {
        const s = normalize(sql);
        calls.push(s);
        if (s.startsWith('SELECT owner_user_id FROM tg_claim_tokens')) {
          const fenced = s.includes('EXISTS') && s.includes("u.state='active'")
            && s.includes('u.internal_id=tg_claim_tokens.owner_user_id');
          return { rows: fenced ? [] : [{ owner_user_id: account.userId }] };
        }
        if (s.startsWith('UPDATE tg_claim_tokens SET consumed_at=now()')) tokenConsumed = true;
        if (s.startsWith('INSERT INTO tg_user_identities')) identityInserted = true;
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    };
    const svc = new TgIdentityService({ getClient: jest.fn(async () => client) } as any);

    await expect(svc.consumeAuthToken('00000000-0000-4000-8000-000000000001', 10001, null, null))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(tokenConsumed).toBe(false);
    expect(identityInserted).toBe(false);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  function deletedConfigDb(initial: FakeConfig, initialState: 'active' | 'deleted' = 'deleted') {
    const configs = [initial];
    const tokens: any[] = [];
    let ownerState = initialState;
    let deleteAfterPrecheck = false;
    const pg = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        const s = normalize(sql);
        const activeGuard = s.includes('user_id') && s.includes("state='active'");
        if (s.startsWith("SELECT 1 FROM user_id WHERE internal_id=$1 AND state='active'")) {
          const rows = ownerState === 'active' ? [{ '?column?': 1 }] : [];
          if (deleteAfterPrecheck) {
            ownerState = 'deleted';
            deleteAfterPrecheck = false;
          }
          return { rows, rowCount: rows.length };
        }
        if (s.startsWith('SELECT * FROM tg_bot_configs WHERE id = $1')) {
          return { rows: configs.filter((config) => config.id === params[0] && config.owner_user_id === params[1]) };
        }
        if (s.startsWith('SELECT * FROM tg_bot_configs WHERE tg_chat_id = $1')) {
          const visible = activeGuard && ownerState === 'deleted'
            ? []
            : configs.filter((config) => ['active', 'silent'].includes(config.status));
          return { rows: visible };
        }
        if (s.includes("SET status = 'pending'")) {
          if (activeGuard && ownerState === 'deleted') return { rows: [], rowCount: 0 };
          configs[0].status = 'pending';
          configs[0].archived_at = null;
          return { rows: [{ ...configs[0] }], rowCount: 1 };
        }
        if (s.includes("SET status = 'active'")) {
          if (activeGuard && ownerState === 'deleted') return { rows: [], rowCount: 0 };
          configs[0].status = 'active';
          return { rows: [{ ...configs[0] }], rowCount: 1 };
        }
        if (s.startsWith('INSERT INTO tg_claim_tokens')) {
          if (activeGuard && ownerState === 'deleted') return { rows: [], rowCount: 0 };
          tokens.push({ owner_user_id: params[0], config_id: params[1], consumed_at: null });
          return { rows: [{ token: '00000000-0000-4000-8000-000000000002' }], rowCount: 1 };
        }
        if (s.startsWith('SELECT preferred_agent FROM ai_profiles_consolidated')) return { rows: [] };
        if (s.startsWith('INSERT INTO tg_bot_configs')) {
          if (activeGuard && ownerState === 'deleted') return { rows: [], rowCount: 0 };
          const created = ownConfig({ id: 'cfg-new', tg_chat_id: String(params[1]), custom_agent_id: null });
          configs.push(created);
          return { rows: [created], rowCount: 1 };
        }
        throw new Error(`unexpected config query: ${s}`);
      }),
    };
    return {
      pg,
      configs,
      tokens,
      deleteAfterPrecheck: () => { deleteAfterPrecheck = true; },
    };
  }

  it('reissueClaim не воскрешает archived config и не выпускает token для deleted', async () => {
    const { pg, configs, tokens } = deletedConfigDb(ownConfig({ status: 'archived' }));
    const svc = new TgConfigService(pg as any, {} as any);

    await expect(svc.reissueClaim('cfg-1', account.userId)).rejects.toBeInstanceOf(BadRequestException);
    expect(configs).toHaveLength(1);
    expect(configs[0].status).toBe('archived');
    expect(tokens).toHaveLength(0);
  });

  it('ensurePrivateConfig не будит silent config удалённого владельца', async () => {
    const { pg, configs } = deletedConfigDb(ownConfig({ status: 'silent' }));
    const svc = new TgConfigService(pg as any, {} as any);

    await expect(svc.ensurePrivateConfig(account.userId, -100200)).rejects.toBeInstanceOf(BadRequestException);
    expect(configs).toHaveLength(1);
    expect(configs[0].status).toBe('silent');
  });

  it('ensurePrivateConfig не создаёт новый config для deleted', async () => {
    const { pg, configs } = deletedConfigDb(ownConfig({ status: 'archived' }));
    const svc = new TgConfigService(pg as any, {} as any);

    await expect(svc.ensurePrivateConfig(account.userId, -100200)).rejects.toBeInstanceOf(BadRequestException);
    expect(configs.map((config) => config.id)).toEqual(['cfg-1']);
    expect(configs[0].status).toBe('archived');
  });
  it('active→deleted после precheck: reissue не переводит archived в pending и не выдаёт unconsumed claim', async () => {
    const harness = deletedConfigDb(ownConfig({ status: 'archived' }), 'active');
    harness.deleteAfterPrecheck();
    const grammy = { leaveChat: jest.fn() };
    const svc = new TgConfigService(harness.pg as any, grammy as any);

    await expect(svc.reissueClaim('cfg-1', account.userId)).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.configs[0].status).toBe('archived');
    expect(harness.tokens.filter((token) => token.consumed_at == null)).toHaveLength(0);
    expect(grammy.leaveChat).not.toHaveBeenCalled();
  });

  it('active→deleted после precheck: ensure не будит silent и не создаёт active config', async () => {
    const silent = deletedConfigDb(ownConfig({ status: 'silent' }), 'active');
    silent.deleteAfterPrecheck();
    const silentSvc = new TgConfigService(silent.pg as any, {} as any);
    await expect(silentSvc.ensurePrivateConfig(account.userId, -100200)).rejects.toThrow();
    expect(silent.configs.map((config) => [config.id, config.status])).toEqual([['cfg-1', 'silent']]);

    const archived = deletedConfigDb(ownConfig({ status: 'archived' }), 'active');
    archived.deleteAfterPrecheck();
    const archivedSvc = new TgConfigService(archived.pg as any, {} as any);
    await expect(archivedSvc.ensurePrivateConfig(account.userId, -100200)).rejects.toThrow();
    expect(archived.configs.map((config) => config.id)).toEqual(['cfg-1']);
    expect(archived.configs[0].status).toBe('archived');
    expect(archived.tokens.filter((token) => token.consumed_at == null)).toHaveLength(0);
  });

  it('silent UPDATE rowCount=0 после concurrent archive не возвращает synthetic active', async () => {
    const harness = deletedConfigDb(ownConfig({ status: 'silent' }), 'active');
    const originalQuery = harness.pg.query.getMockImplementation()!;
    harness.pg.query.mockImplementation(async (sql: string, params: any[] = []) => {
      if (normalize(sql).includes("SET status = 'active'")) {
        harness.configs[0].status = 'archived';
        return { rows: [], rowCount: 0 };
      }
      return originalQuery(sql, params);
    });
    const svc = new TgConfigService(harness.pg as any, {} as any);

    await expect(svc.ensurePrivateConfig(account.userId, -100200)).rejects.toThrow();
    expect(harness.configs[0].status).toBe('archived');
  });
});

class FakeVideoDb {
  userState: 'active' | 'deleted' = 'active';
  configStatus: 'active' | 'silent' | 'archived' = 'active';
  deliveryStatus = 'pending';
  deliveryError: string | null = null;
  fenceErrorOnce = false;
  readonly queries: string[] = [];
  readonly row = {
    job_id: 'video-1',
    tg_chat_id: '-100200',
    tg_reply_to_message_id: 7,
    status: 'ready',
    video_url: 'https://media.example/video.mp4',
    owner_user_id: account.userId,
    config_id: 'cfg-1',
  };

  async query(sql: string, params: any[] = []): Promise<any> {
    const s = normalize(sql);
    this.queries.push(s);
    if (s.includes("profile_data->>'language'")) return { rows: [{ language: 'ru' }] };
    if (s.startsWith('SELECT tg.job_id')) {
      const visible = this.visible(s, false);
      return { rows: visible ? [this.row] : [], rowCount: visible ? 1 : 0 };
    }
    if (s.startsWith('SELECT 1 FROM tg_bot_video_jobs tg')) {
      if (this.fenceErrorOnce) {
        this.fenceErrorOnce = false;
        throw new Error('transient fence DB error');
      }
      const visible = this.visible(s, true);
      return { rows: visible ? [{ '?column?': 1 }] : [], rowCount: visible ? 1 : 0 };
    }
    if (s.startsWith('UPDATE tg_bot_video_jobs SET delivery_status=')
      || s.startsWith('UPDATE tg_bot_video_jobs tg SET delivery_status=')) {
      const guarded = s.includes("tg.delivery_status IN ('pending','sending')")
        && s.includes("tg.delivery_error IS DISTINCT FROM 'account_deleted'")
        && s.includes("JOIN tg_bot_configs c ON c.id=tg.config_id AND c.status IN ('active','silent')")
        && s.includes("JOIN user_id u ON u.internal_id=vj.user_id AND u.state='active'");
      if (guarded && !this.canComplete()) return { rows: [], rowCount: 0 };
      const sent = s.includes("delivery_status='sent'");
      this.deliveryStatus = sent ? 'sent' : 'failed';
      if (!sent) this.deliveryError = String(params[0] ?? 'unknown');
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected video query: ${s}`);
  }

  stopForAccountDeletion(reactivated = false): void {
    this.deliveryStatus = 'failed';
    this.deliveryError = 'account_deleted';
    this.userState = reactivated ? 'active' : 'deleted';
    this.configStatus = reactivated ? 'active' : 'archived';
  }

  private canComplete(): boolean {
    return this.userState === 'active'
      && ['active', 'silent'].includes(this.configStatus)
      && ['pending', 'sending'].includes(this.deliveryStatus)
      && this.deliveryError !== 'account_deleted';
  }

  private visible(sql: string, recheck: boolean): boolean {
    const configFence = "JOIN tg_bot_configs c ON c.id=tg.config_id AND c.status IN ('active','silent')";
    const userFence = "JOIN user_id u ON u.internal_id=vj.user_id AND u.state='active'";
    const fenced = sql.includes(configFence) && sql.includes(userFence)
      && (!recheck || sql.includes("tg.delivery_status='pending'"));
    if (!fenced) return true;
    return this.userState === 'active'
      && ['active', 'silent'].includes(this.configStatus)
      && this.deliveryStatus === 'pending';
  }
}

function makeVideoService(db: FakeVideoDb) {
  const grammy = {
    sendMessage: jest.fn(async () => ({})),
    sendChatAction: jest.fn(async () => {}),
    sendVideo: jest.fn(async () => ({})),
  };
  const svc = new TgVideoDispatchService(db as any, grammy as any);
  (svc as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { svc, grammy };
}

describe('TG video active fences', () => {
  beforeEach(() => {
    axiosGet.mockReset();
    axiosGet.mockResolvedValue({ data: Buffer.from('video') });
  });

  it.each([
    ['archived', 'active'],
    ['active', 'deleted'],
  ])('selection исключает config=%s и user=%s', async (configStatus, userState) => {
    const db = new FakeVideoDb();
    db.configStatus = configStatus as any;
    db.userState = userState as any;
    const { svc, grammy } = makeVideoService(db);

    await (svc as any).tick();

    expect(grammy.sendChatAction).not.toHaveBeenCalled();
    expect(grammy.sendMessage).not.toHaveBeenCalled();
    expect(grammy.sendVideo).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
    expect(db.queries[0]).toContain("JOIN tg_bot_configs c ON c.id=tg.config_id AND c.status IN ('active','silent')");
    expect(db.queries[0]).toContain("JOIN user_id u ON u.internal_id=vj.user_id AND u.state='active'");
  });

  it('selection→deleted до deliver: ни sendChatAction, ни download/sendVideo', async () => {
    const db = new FakeVideoDb();
    const { svc, grammy } = makeVideoService(db);
    db.userState = 'deleted';

    await (svc as any).deliver(db.row);

    expect(grammy.sendChatAction).not.toHaveBeenCalled();
    expect(grammy.sendMessage).not.toHaveBeenCalled();
    expect(grammy.sendVideo).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('deleted после sendChatAction ловится вторым fence ДО axios.get', async () => {
    const db = new FakeVideoDb();
    const { svc, grammy } = makeVideoService(db);
    grammy.sendChatAction.mockImplementation(async () => {
      db.userState = 'deleted';
    });

    await (svc as any).tick();

    expect(grammy.sendChatAction).toHaveBeenCalledTimes(1);
    expect(axiosGet).not.toHaveBeenCalled();
    expect(grammy.sendVideo).not.toHaveBeenCalled();
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('archived во время download ловится отдельным fence ДО sendVideo', async () => {
    const db = new FakeVideoDb();
    const { svc, grammy } = makeVideoService(db);
    axiosGet.mockImplementation(async () => {
      db.configStatus = 'archived';
      return { data: Buffer.from('video') };
    });

    await (svc as any).tick();

    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(grammy.sendVideo).not.toHaveBeenCalled();
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('deletion во время rejected axios.get: ни video_expired, ни перезаписи account_deleted', async () => {
    const db = new FakeVideoDb();
    const { svc, grammy } = makeVideoService(db);
    axiosGet.mockImplementation(async () => {
      db.stopForAccountDeletion();
      throw new Error('download failed after deletion');
    });

    await (svc as any).tick();

    expect(grammy.sendMessage).not.toHaveBeenCalled();
    expect(grammy.sendVideo).not.toHaveBeenCalled();
    expect(db.deliveryStatus).toBe('failed');
    expect(db.deliveryError).toBe('account_deleted');
  });

  it('deletion во время rejected sendVideo: operational fallback не шлёт video_expired', async () => {
    const db = new FakeVideoDb();
    const { svc, grammy } = makeVideoService(db);
    grammy.sendVideo.mockImplementation(async () => {
      db.stopForAccountDeletion();
      throw new Error('sendVideo failed after deletion');
    });

    await (svc as any).tick();

    expect(grammy.sendVideo).toHaveBeenCalledTimes(1);
    expect(grammy.sendMessage).not.toHaveBeenCalled();
    expect(db.deliveryStatus).toBe('failed');
    expect(db.deliveryError).toBe('account_deleted');
  });

  it('deletion во время failed-video sendMessage: нет второго outbound video_expired', async () => {
    const db = new FakeVideoDb();
    (db.row as any).status = 'failed';
    (db.row as any).video_url = null;
    const { svc, grammy } = makeVideoService(db);
    grammy.sendMessage.mockImplementationOnce(async () => {
      db.stopForAccountDeletion();
      throw new Error('sendMessage failed after deletion');
    });

    await (svc as any).tick();

    expect(grammy.sendMessage).toHaveBeenCalledTimes(1);
    expect(axiosGet).not.toHaveBeenCalled();
    expect(db.deliveryStatus).toBe('failed');
    expect(db.deliveryError).toBe('account_deleted');
  });

  it('transient fence DB error fail-closed: ноль outbound и нет operational failed update', async () => {
    const db = new FakeVideoDb();
    db.fenceErrorOnce = true;
    const { svc, grammy } = makeVideoService(db);

    await (svc as any).tick();

    expect(grammy.sendChatAction).not.toHaveBeenCalled();
    expect(grammy.sendMessage).not.toHaveBeenCalled();
    expect(grammy.sendVideo).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
    expect(db.deliveryStatus).toBe('pending');
    expect(db.deliveryError).toBeNull();
  });

  it('stop во время успешного sendVideo: late sent не затирает account_deleted', async () => {
    const db = new FakeVideoDb();
    const { svc, grammy } = makeVideoService(db);
    grammy.sendVideo.mockImplementation(async () => {
      db.stopForAccountDeletion();
      return {};
    });

    await (svc as any).tick();

    expect(grammy.sendVideo).toHaveBeenCalledTimes(1);
    expect(db.deliveryStatus).toBe('failed');
    expect(db.deliveryError).toBe('account_deleted');
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('reactivation перед late completion: старый attempt сохраняет stop marker', async () => {
    const db = new FakeVideoDb();
    const { svc, grammy } = makeVideoService(db);
    grammy.sendVideo.mockImplementation(async () => {
      db.stopForAccountDeletion(true);
      return {};
    });

    await (svc as any).tick();

    expect(db.deliveryStatus).toBe('failed');
    expect(db.deliveryError).toBe('account_deleted');
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('operational axios error при подтверждённом active сохраняет video_expired fallback', async () => {
    const db = new FakeVideoDb();
    const { svc, grammy } = makeVideoService(db);
    axiosGet.mockRejectedValue(new Error('ordinary download failure'));

    await (svc as any).tick();

    expect(grammy.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.deliveryStatus).toBe('failed');
    expect(db.deliveryError).toContain('ordinary download failure');
  });

  it('active delivery сохраняет прежний download/SSRF limits и sendVideo', async () => {
    const db = new FakeVideoDb();
    const { svc, grammy } = makeVideoService(db);

    await (svc as any).tick();

    expect(axiosGet).toHaveBeenCalledWith(db.row.video_url, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      maxContentLength: 49 * 1024 * 1024,
    });
    expect(grammy.sendVideo).toHaveBeenCalledWith(-100200, expect.any(Buffer), {
      reply_parameters: { message_id: 7, allow_sending_without_reply: true },
    });
    expect(db.deliveryStatus).toBe('sent');
  });
});
