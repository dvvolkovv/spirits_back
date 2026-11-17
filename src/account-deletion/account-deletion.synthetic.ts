import { createHash, randomBytes, randomUUID } from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { AvatarService } from '../avatar/avatar.service';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { hashClaimer } from '../guest-trial/guest-token';
import { IdentityService } from '../identity/identity.service';
import { HostsService } from '../products/hosts.service';
import { LimitsService } from '../products/limits.service';
import { ProductAccountDeletionService } from '../products/product-account-deletion.service';
import { ProductActionsService } from '../products/product-actions.service';
import { ProductLifecycleService } from '../products/product-lifecycle.service';
import { ProductPurgeService } from '../products/product-purge.service';
import { ProvisioningService } from '../products/provisioning.service';
import { RentService } from '../products/rent.service';
import { SecretsService } from '../products/secrets.service';
import { TurnsService } from '../products/turns.service';
import { TgConfigService } from '../tg-bot/tg-config.service';
import { VoiceCallService } from '../voice-call/voice-call.service';
import { DELETION_DISCOVERERS } from './account-deletion.catalog';
import { AccountDeletionCoordinator } from './account-deletion.coordinator';
import { AccountDeletionJobs } from './account-deletion.jobs';
import { AccountDeletionLifecycle } from './account-deletion.lifecycle';
import { AccountDeletionPlanner } from './account-deletion.planner';
import { AccountDeletionRegistry } from './account-deletion.registry';
import { AccountDeletionRunner } from './account-deletion.runner';
import { AccountDeletionSchemaService } from './account-deletion.schema';
import type { DeletionDiscovery } from './account-deletion.types';
import { ProfileAccountDeletionAdapter } from '../profile/profile-account-deletion.adapter';
import { ProfileAccountDeletionRecapture } from '../profile/profile-account-deletion.discovery';
import { RoutineAccountDeletionAdapter } from '../routine-push/routine-account-deletion.adapter';
import { TgAccountDeletionAdapter } from '../tg-bot/tg-account-deletion.adapter';
import { ProductAccountDeletionAdapter } from '../products/product-account-deletion.adapter';
import { CalendarAccountDeletionAdapter } from '../calendar/calendar-account-deletion.adapter';
import { IntegrationAccountDeletionAdapter } from '../integrations/integration-account-deletion.adapter';
import { VoiceAccountDeletionAdapter } from '../voice-call/voice-account-deletion.adapter';
import { VoiceDocumentAccountDeletionAdapter } from '../voice-call/voice-document-account-deletion';
import { ChatFileAccountDeletionAdapter } from '../chat/chat-files/chat-file-account-deletion.adapter';
import { ChatUploadAccountDeletionAdapter } from '../chat/chat-uploads/chat-upload-account-deletion.adapter';
import { ImageAccountDeletionAdapter } from '../misc/image-account-deletion.adapter';
import { VideoAccountDeletionAdapter } from '../video/video-account-deletion.adapter';
import { SpeechAccountDeletionAdapter } from '../speech/speech-account-deletion.adapter';
import { AvatarAccountDeletionAdapter } from '../avatar/avatar-account-deletion.adapter';
import { VoiceAvatarAccountDeletionAdapter } from '../voice-avatar/voice-account-deletion.adapter';
import { EventsAccountDeletionAdapter } from '../events/events-account-deletion.adapter';
import { TasksAccountDeletionAdapter } from '../tasks/tasks-account-deletion.adapter';
import { SupportAccountDeletionAdapter } from '../support/support-account-deletion.adapter';
import { PeerAccountDeletionAdapter } from '../peer/peer-account-deletion.adapter';
import { ContactsAccountDeletionAdapter } from '../contacts/contacts-account-deletion.adapter';
import { ReferralAccountDeletionAdapter } from '../referral/referral-account-deletion.adapter';
import { RetentionAccountDeletionAdapter } from '../retention/retention-account-deletion.adapter';
import { BackupAccountDeletionAdapter } from '../backup/backup-account-deletion.adapter';
import { DevicesAccountDeletionAdapter } from '../devices/devices-account-deletion.adapter';
import { GuestAccountDeletionAdapter } from '../guest-trial/guest-account-deletion.adapter';
import { LegacyAuthAccountDeletionAdapter } from '../identity/legacy-auth-account-deletion.adapter';
import { LegacySmmAccountDeletionAdapter } from '../misc/legacy-smm-account-deletion.adapter';

/**
 * Task 22 — composition root синтетической проверки ПОЛНОГО lifecycle
 * удаления аккаунта. Один и тот же код используют:
 *  - jest-спек account-deletion.synthetic.pg.spec.ts (свежая одноразовая БД,
 *    DDL накатывает спек);
 *  - CLI scripts/account-deletion-synthetic.ts (Gate B владельца: полный
 *    набор --apply --confirm-account-deletion-cleanup + env
 *    ACCOUNT_DELETION_SYNTHETIC_ENV=test.linkeon.io + hostname из точного
 *    allow-list SYNTHETIC_GATE_HOSTNAMES — ugliest-salmon или его FQDN
 *    ugliest-salmon.ptr.network; без тройки гейтов — exit 2 до любого
 *    подключения).
 *
 * Честность границ: НАСТОЯЩИЕ SchemaService/Planner(DELETION_DISCOVERERS)/
 * Jobs/Runner/Coordinator/Lifecycle/Registry, настоящие IdentityService,
 * ProfileAccountDeletionAdapter+Recapture, AvatarService, TgConfigService,
 * VoiceCallService и вся product-цепочка (host-агент подтверждает задания
 * через ProvisioningService.completeJob — pull-модель как в проде).
 * Doubles — ТОЛЬКО внешние границы (MinIO-транспорт, LiveKit, Attendee,
 * ElevenLabs, CalDAV, OAuth-провайдеры, Telegram leaveChat, Redis, Neo4j,
 * генерация изображений/видео/речи); каждая — strict tri-state: успех /
 * инжектированный kind / неизвестная ошибка. Никаких порождений процессов,
 * удалённых подключений и платных внешних вызовов. retentionMs передаётся
 * только аргументом tick() — production env укороченного cutoff не имеет.
 *
 * Прод-wiring (с Task 22.6): calendar.external и video.provider — skip-only
 * типы; задачи таких типов не создаются (санитайзер отклоняет JOB'ы с
 * 'unsafe_resource_type', discoverer'ы эмитируют только skips), и
 * registry.assertReady() их исключает — как и в проде, адаптеры для них не
 * регистрируются. Pre-22.6 noop-стабы здесь больше не нужны: состав
 * реестра совпадает с прод-композицией один в один.
 */

// ------------------------------------------------------------------ гейты

export const SYNTHETIC_DELETION_PREFIX = 'synthetic-deletion-';
export const SYNTHETIC_GATE_ENV = 'ACCOUNT_DELETION_SYNTHETIC_ENV';
export const SYNTHETIC_GATE_ENV_VALUE = 'test.linkeon.io';
export const SYNTHETIC_GATE_HOSTNAMES = ['ugliest-salmon', 'ugliest-salmon.ptr.network'] as const;
export const SYNTHETIC_APPLY_FLAG = '--apply';
export const SYNTHETIC_CONFIRM_FLAG = '--confirm-account-deletion-cleanup';

/**
 * Синтетические аккаунты. Телефоны — продолжение фикстурной
 * последовательности 7999000010x (101–104 заняты dry-run/reactivation
 * спеками Task 21/прецедентов). internal_id у phone-аккаунта в проде и есть
 * номер, поэтому main/hist/restart — телефоны, а не 'u-synthetic-*';
 * префикс synthetic-deletion- несут все ресурсные ключи (slug, комнаты,
 * имена ботов, хеши) и все тексты фикстур.
 */
export const SYNTHETIC_MAIN_PHONE = '79990000105';
export const SYNTHETIC_OTHER_ID = 'u-synthetic-other';
export const SYNTHETIC_HIST_PHONE = '79990000107';
export const SYNTHETIC_RESTART_PHONE = '79990000108';

/**
 * Свой хост продуктов synthetic. Не общий 'host-shared' из product pg spec:
 * synthetic идёт против живой базы стенда, и общий хост с audience
 * 'clients' и accepts_new по умолчанию true после прогона оставался бы в
 * реестре — его выбирал бы pickForNewProduct для клиентских продуктов.
 * Заводится закрытым для новых (accepts_new = false) и убирается в
 * cleanupSyntheticFixture вместе со всеми продуктами на нём.
 */
export const SYNTHETIC_HOST_ID = `${SYNTHETIC_DELETION_PREFIX}host`;

export class SyntheticGateError extends Error {
  constructor() {
    super('synthetic_gates_not_met');
  }
}

export interface SyntheticGatesInput {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly hostname: string;
}

/** Точное вхождение в SYNTHETIC_GATE_HOSTNAMES — строгое равенство, без нормализации. */
export function isSyntheticGateHostname(name: string): boolean {
  return SYNTHETIC_GATE_HOSTNAMES.some((allowed) => allowed === name);
}

/**
 * Тройной гейт — проверяется ДО любого подключения/записи. Пропускает
 * только полную комбинацию: оба флага (и ничего лишнего) + env-значение
 * test.linkeon.io + hostname из SYNTHETIC_GATE_HOSTNAMES. Имён два, потому
 * что os.hostname() на тест-ноде отдаёт FQDN ugliest-salmon.ptr.network.
 * Сравнение — только точное: префиксы, регистр и нормализация запрещены,
 * иначе гейт пропустил бы двойников вроде ugliest-salmon.evil.example.
 */
export function checkSyntheticGates(input: SyntheticGatesInput): void {
  const args = [...input.argv];
  for (const arg of args) {
    if (arg !== SYNTHETIC_APPLY_FLAG && arg !== SYNTHETIC_CONFIRM_FLAG) {
      throw new SyntheticGateError();
    }
  }
  if (!args.includes(SYNTHETIC_APPLY_FLAG)) throw new SyntheticGateError();
  if (!args.includes(SYNTHETIC_CONFIRM_FLAG)) throw new SyntheticGateError();
  if (input.env[SYNTHETIC_GATE_ENV] !== SYNTHETIC_GATE_ENV_VALUE) {
    throw new SyntheticGateError();
  }
  if (!isSyntheticGateHostname(input.hostname)) throw new SyntheticGateError();
}

export class SyntheticPreflightError extends Error {
  constructor(accounts: number) {
    super(`synthetic_preflight_accounts_not_zero: ${accounts}`);
  }
}

/**
 * T22-Q5: preflight CLI перед посевом. Если dry-run видит ХОТЯ БЫ ОДНО
 * due-поколение, abort (код 2): tick-обёртки на живой БД обрабатывают ВСЕ
 * due-аккаунты, а не только синтетические фикстуры, и чужие поколения стенда
 * сценарий трогать не должен. Сообщение несёт только счётчик — никаких
 * userId/телефонов/deletionId (печать через scriptErrorText).
 */
export function assertSyntheticPreflight(summary: { accounts: number }): void {
  if (summary.accounts !== 0) {
    throw new SyntheticPreflightError(summary.accounts);
  }
}

// ------------------------------------------------- fault-инъекция границ

export type SyntheticFaultKind =
  | 'timeout'
  | 'external_5xx'
  | 'external_4xx'
  | 'not_found'
  | 'permission'
  | 'rate_limited'
  | 'db'
  | 'external_unknown';

/**
 * Ошибка, которую deletionErrorKind() гарантированно отображает обратно
 * в запрошенный kind (roundtrip проверяет account-deletion.synthetic.spec.ts).
 */
export function faultErrorFor(kind: SyntheticFaultKind): Error {
  const error: any = new Error(`synthetic_fault:${kind}`);
  switch (kind) {
    case 'timeout':
      error.code = 'ETIMEDOUT';
      return error;
    case 'external_5xx':
      error.response = { status: 503 };
      return error;
    case 'external_4xx':
      error.response = { status: 400 };
      return error;
    case 'not_found':
      error.response = { status: 404 };
      return error;
    case 'rate_limited':
      error.response = { status: 429 };
      return error;
    case 'permission':
      error.response = { status: 403 };
      return error;
    case 'db':
      error.code = '57014';
      return error;
    case 'external_unknown':
    default:
      return error;
  }
}

/**
 * Реестр отказов внешних границ + счётчики вызовов. inject() цепочкой,
 * guard() бросает инжектированную ошибку (границы «сквозьthrow»),
 * failValue() возвращает заданный исход (tri-state границы: host/attendee/
 * livekit, где контракт — boolean/null, а не исключение). note() считает
 * КАЖДЫЙ вызов границы — аудит «dry-run ничего не вызвал» и «внешние
 * идентификаторы стирались реально».
 */
export class SyntheticFailures {
  private readonly injected = new Map<string, SyntheticFaultKind>();
  private readonly callCounts = new Map<string, number>();

  inject(target: string, kind: SyntheticFaultKind): this {
    this.injected.set(target, kind);
    return this;
  }

  clear(): void {
    this.injected.clear();
  }

  isActive(target: string): boolean {
    return this.injected.has(target);
  }

  note(target: string): void {
    this.callCounts.set(target, (this.callCounts.get(target) ?? 0) + 1);
  }

  calls(target: string): number {
    return this.callCounts.get(target) ?? 0;
  }

  totalCalls(): number {
    let total = 0;
    for (const count of this.callCounts.values()) total += count;
    return total;
  }

  /** Граница «сквозь throw»: активный отказ → ошибка инжектированного kind. */
  guard(target: string): void {
    const kind = this.injected.get(target);
    if (kind) throw faultErrorFor(kind);
  }

  /** Tri-state граница: активный отказ → указанное значение, иначе undefined. */
  failValue<T>(target: string, value: T): T | undefined {
    return this.injected.has(target) ? value : undefined;
  }
}

// ------------------------------------------------------------ stack

export interface SyntheticStack {
  readonly pg: PgService;
  /** Db-интерфейс движка (dryRunAccountDeletion, planner) — тот же PgService. */
  readonly db: DeletionDiscovery['db'];
  readonly failures: SyntheticFailures;
  readonly registry: AccountDeletionRegistry;
  readonly jobs: AccountDeletionJobs;
  readonly planner: AccountDeletionPlanner;
  readonly runner: AccountDeletionRunner;
  readonly lifecycle: AccountDeletionLifecycle;
  readonly coordinator: AccountDeletionCoordinator;
  readonly identity: IdentityService;
  readonly provisioning: ProvisioningService;
  readonly schema: AccountDeletionSchemaService;
  /** Новый instance координатора — моделирование restart-а воркера. */
  makeCoordinator(): AccountDeletionCoordinator;
  /**
   * Scope синтетических аккаунтов (T22-Q5): посевные функции добавляют сюда
   * userId, simulateHostAgent подтверждает задания продуктов ТОЛЬКО из
   * этого множества — queued-задания реальных продуктов стенда он трогать
   * не должен.
   */
  readonly hostAgentScope: Set<string>;
  /**
   * Симулятор host-агента (pull-модель продуктов): забирает queued
   * sleep/purge задания продуктов из hostAgentScope и подтверждает их через
   * ProvisioningService.completeJob — как настоящий агент машины. При
   * активном отказе 'host' не делает ничего: задание остаётся в очереди,
   * адаптер продукта честно уходит в retry.
   */
  simulateHostAgent(): Promise<number>;
  /** Строка переписки с файлом в chat-files-бакете — вход recapture. */
  seedHistoryRow(userId: string, tag: string): Promise<void>;
  /** Минимальный аккаунт прод-путём resolveOrCreate (для restart-теста). */
  seedMinimalAccount(phone: string): Promise<{ userId: string }>;
}

const PRODUCT_SECRETS_KEY =
  '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export function createSyntheticStack(pg: PgService): SyntheticStack {
  const failures = new SyntheticFailures();

  // ---- Внешние границы: doubles со strict tri-state и счётчиком вызовов.
  const storage = new StorageService();
  storage.onModuleInit();
  // Транспорт MinIO подменён целиком: ни одного сетевого пакета. Успех —
  // 2xx-ответ (deleteConfirmed трактует как 'deleted'); отказ — guard().
  (storage as any).s3 = {
    send: async (_command: unknown) => {
      failures.note('minio');
      failures.guard('minio');
      return {};
    },
  };

  const livekit = {
    removeAgentsStrict: async (_room: string) => {
      failures.note('livekit');
      return failures.failValue('livekit', false) ?? true;
    },
    closeRoomStrict: async (_room: string) => {
      failures.note('livekit');
      return failures.failValue('livekit', false) ?? true;
    },
  };

  const attendee = {
    removeBot: async (_botId: string): Promise<boolean | null> => {
      failures.note('attendee');
      return failures.failValue('attendee', null) ?? true;
    },
  };

  const voiceAvatar = {
    deleteCloneConfirmed: async (_voiceId: string) => {
      failures.note('elevenlabs');
      failures.guard('elevenlabs');
    },
  };

  const calendar = {
    disconnect: async (_userId: string) => {
      failures.note('calendar');
      failures.guard('calendar');
    },
    disconnectExchange: async (_userId: string) => {
      failures.note('calendar');
      failures.guard('calendar');
    },
  };

  const apple = {
    canCallApple: () => true,
    primaryClientId: () => 'com.linkeon.app',
    revokeToken: async (_token: string, _clientId?: string) => {
      failures.note('apple');
      failures.guard('apple');
      return true;
    },
  };

  const zoom = {
    disconnect: async (_userId: string) => {
      failures.note('zoom');
      failures.guard('zoom');
    },
  };

  const talerid = {
    disconnect: async (_userId: string) => {
      failures.note('talerid');
      failures.guard('talerid');
    },
  };

  const grammy = {
    leaveChat: async (_chatId: number) => {
      failures.note('telegram');
      failures.guard('telegram');
    },
  };

  const redis = {
    deleteByPrefix: async (_prefix: string) => {
      failures.note('redis');
      failures.guard('redis');
      return 0;
    },
  };

  const neo4j = {
    deleteUserGraphStrict: async (_userId: string) => {
      failures.note('neo4j');
      failures.guard('neo4j');
    },
  };

  const misc = {
    deleteGeneratedImageForDeletion: async (
      _userId: string,
      _imageId: string | number,
      _deletionId: string,
    ) => {
      failures.note('image');
      failures.guard('image');
    },
  };

  const video = {
    deleteVideoForDeletion: async (
      _userId: string,
      _videoJobId: string,
      _deletionId: string,
    ) => {
      failures.note('video');
      failures.guard('video');
    },
    // K4: обход video-uploads/<userId>/ (video-upload.purge) — та же граница.
    deleteVideoUploadsForDeletion: async (
      _userId: string,
      _deletionId: string,
      _beforeDelete?: () => Promise<void>,
    ) => {
      failures.note('video');
      failures.guard('video');
    },
  };

  const speech = {
    deleteSpeechClipForDeletion: async (
      _userId: string,
      _clipId: string,
      _deletionId: string,
    ) => {
      failures.note('speech');
      failures.guard('speech');
    },
    deleteListenForDeletion: async (
      _userId: string,
      _listenId: string,
      _deletionId: string,
    ) => {
      failures.note('speech');
      failures.guard('speech');
    },
  };

  const routines = {
    clearRetryTimersForUser: (_userId: string) => {},
  };

  // ---- Настоящие сервисы с двойниками только на границах.
  const avatar = new AvatarService(pg, storage);
  const tgConfigs = new TgConfigService(pg, grammy as any);
  const voice = new VoiceCallService(
    pg,
    {} as any, // ChatService — в deletion-пути не используется
    livekit as any,
    undefined,
    undefined,
    attendee as any,
  );

  // ---- Product-цепочка целиком настоящая (прецедент —
  // product-account-deletion.pg.spec.ts): host-агент подтверждает задания
  // через ProvisioningService.completeJob, а не UPDATE purged_at напрямую.
  const secrets = new SecretsService({
    get: (key: string) => (key === 'PRODUCT_SECRETS_KEY' ? PRODUCT_SECRETS_KEY : undefined),
  } as any);
  const provisioning = new ProvisioningService(
    pg,
    secrets,
    new HostsService(pg),
    new LimitsService(pg),
    new RentService(pg),
  );
  const turnsMisc = {
    checkTokenBalance: async () => ({ ok: true }),
    deductTokens: async () => 0,
  };
  const turns = new TurnsService(pg, turnsMisc as any);
  const productLifecycle = new ProductLifecycleService(
    pg,
    provisioning,
    new LimitsService(pg),
    turns,
    new ProductActionsService(pg),
    secrets,
  );
  // Без onModuleInit: почасовые таймеры обхода в синтетике не нужны,
  // purge-шаг адаптера зовёт только scoped-методы.
  const productDeletion = new ProductAccountDeletionService(
    pg,
    productLifecycle,
    new ProductPurgeService(pg),
  );

  // ---- Движок удаления: всё настоящее.
  const registry = new AccountDeletionRegistry();
  const jobs = new AccountDeletionJobs(pg as any);
  const planner = new AccountDeletionPlanner(DELETION_DISCOVERERS);
  const runner = new AccountDeletionRunner(pg, jobs, registry);
  const schema = new AccountDeletionSchemaService(pg);
  // lifecycle объявляется до identity (moduleRef-ссылка ленивая).
  let lifecycle!: AccountDeletionLifecycle;
  const identity = new IdentityService(pg, undefined, undefined, {
    get: () => lifecycle,
  } as any);

  const adapters: Array<{ onModuleInit(): void }> = [
    new ProfileAccountDeletionAdapter(
      pg,
      jobs,
      // Форма — как в prod-wiring (profile.module.ts): настоящий planner,
      // env не передаётся (discoverChatFiles берёт extractEnv из process.env).
      new ProfileAccountDeletionRecapture(pg as any, planner),
      neo4j as any,
      registry,
    ),
    new RoutineAccountDeletionAdapter(pg, routines as any, registry),
    new TgAccountDeletionAdapter(pg, tgConfigs, registry),
    new ProductAccountDeletionAdapter(productDeletion, registry),
    new CalendarAccountDeletionAdapter(pg, calendar as any, registry),
    new IntegrationAccountDeletionAdapter(
      identity,
      apple as any,
      zoom as any,
      talerid as any,
      registry,
    ),
    new VoiceAccountDeletionAdapter(voice, attendee as any, registry),
    new VoiceDocumentAccountDeletionAdapter(storage, registry),
    new ChatFileAccountDeletionAdapter(storage, registry),
    new ChatUploadAccountDeletionAdapter(storage, registry),
    new ImageAccountDeletionAdapter(misc as any, registry),
    new VideoAccountDeletionAdapter(video as any, registry),
    new SpeechAccountDeletionAdapter(speech as any, registry),
    new AvatarAccountDeletionAdapter(avatar, registry),
    new VoiceAvatarAccountDeletionAdapter(voiceAvatar as any, registry),
    new EventsAccountDeletionAdapter(registry),
    new TasksAccountDeletionAdapter(registry),
    new SupportAccountDeletionAdapter(registry),
    new PeerAccountDeletionAdapter(registry),
    new ContactsAccountDeletionAdapter(registry),
    new ReferralAccountDeletionAdapter(registry),
    new RetentionAccountDeletionAdapter(registry),
    new BackupAccountDeletionAdapter(registry),
    new DevicesAccountDeletionAdapter(registry),
    new GuestAccountDeletionAdapter(redis as any, registry),
    new LegacyAuthAccountDeletionAdapter(redis as any, registry),
    new LegacySmmAccountDeletionAdapter(pg, registry),
  ];
  for (const adapter of adapters) adapter.onModuleInit();

  // Skip-only типы ('calendar.external', 'video.provider') НЕ регистрируются
  // — как в проде: assertReady (с Task 22.6) их исключает, а санитайзер
  // по-прежнему отклоняет JOB'ы таких типов. См. шапку файла.

  lifecycle = new AccountDeletionLifecycle(pg, planner, jobs, registry, runner);
  const coordinator = new AccountDeletionCoordinator(pg, planner, jobs, runner);

  // T22-Q5: подтверждения строго по scope синтетических аккаунтов; пустой
  // scope — «ничего не подтверждать», иначе simulateHostAgent подтверждал
  // бы queued-задания РЕАЛЬНЫХ продуктов стенда.
  const hostAgentScope = new Set<string>();

  const simulateHostAgent = async (): Promise<number> => {
    if (failures.isActive('host')) return 0;
    if (hostAgentScope.size === 0) return 0;
    const claimed = await pg.query(
      `UPDATE product_provision_jobs
          SET status='running', started_at=now()
        WHERE status='queued' AND kind IN ('sleep','purge')
          AND product_id IN (SELECT id FROM products WHERE user_id = ANY($1))
        RETURNING id`,
      [[...hostAgentScope]],
    );
    let done = 0;
    for (const row of claimed.rows) {
      await provisioning.completeJob(row.id, { ok: true });
      done += 1;
    }
    return done;
  };

  const seedHistoryRow = async (userId: string, tag: string): Promise<void> => {
    const fileId = randomUUID();
    await pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
       VALUES ($1 || '_1', 'human', 12, $2, 'text')`,
      [
        userId,
        `Посмотри файл ![${tag}](https://minio.test/linkeon-chat-files/${fileId}/${tag}-image.png)`,
      ],
    );
  };

  const seedMinimalAccount = async (phone: string): Promise<{ userId: string }> => {
    const result = await identity.resolveOrCreate('phone', { phone });
    if (result.status !== 'ok') {
      throw new Error(`resolveOrCreate(${phone}) вернул ${result.status}`);
    }
    hostAgentScope.add(phone);
    return { userId: phone };
  };

  return {
    pg,
    db: pg,
    failures,
    registry,
    jobs,
    planner,
    runner,
    lifecycle,
    coordinator,
    identity,
    provisioning,
    schema,
    makeCoordinator: () => new AccountDeletionCoordinator(pg, planner, jobs, runner),
    hostAgentScope,
    simulateHostAgent,
    seedHistoryRow,
    seedMinimalAccount,
  };
}

// ------------------------------------------------------------ фикстуры

export interface SyntheticFixture {
  readonly mainUserId: string;
  readonly otherUserId: string;
  readonly histUserId: string;
  readonly productId: string;
  readonly soleCallId: string;
  readonly sharedCallId: string;
  readonly otherCallId: string;
  readonly roomCode: string;
  readonly tgConfigId: string;
  readonly customAgentId: string;
  readonly videoJobId: string;
  readonly voiceId: string;
  /** Слепок ресурсов соседа ДО удалений — обязан пережить весь сценарий. */
  readonly allSharedResources: Record<string, unknown>;
  /** Слепок historical-deleted строки (без deletion_id) — обязана остаться. */
  readonly historicalControl: Record<string, unknown>;
}

async function oneRow(pg: PgService, sql: string, params: unknown[] = []): Promise<any> {
  const result = await pg.query(sql, params as any[]);
  return result.rows[0];
}

/**
 * Слепок ресурсов соседа — SQL и форма результата ОБЯЗАНЫ совпадать
 * с хелпером sharedResources() из pg-спека (сравнивается toEqual-ом).
 */
export async function sharedResourcesSnapshot(
  pg: PgService,
  otherUserId: string,
): Promise<Record<string, unknown>> {
  const calls = (await pg.query(
    `SELECT room_name, status, external_bot_id FROM voice_calls
      WHERE user_id=$1 ORDER BY room_name`,
    [otherUserId],
  )).rows;
  const rooms = (await pg.query(
    `SELECT code, owner_user_id, closed_at::text AS closed_at FROM meeting_rooms
      ORDER BY code`,
  )).rows;
  const msgs = await oneRow(
    pg,
    `SELECT count(*)::int AS n FROM peer_messages WHERE sender_id=$1`,
    [otherUserId],
  );
  const convs = await oneRow(
    pg,
    `SELECT count(*)::int AS n FROM peer_conversations
      WHERE user_a_id=$1 OR user_b_id=$1`,
    [otherUserId],
  );
  const profiles = await oneRow(
    pg,
    `SELECT count(*)::int AS n, COALESCE(max(tokens),0)::bigint AS tokens
       FROM ai_profiles_consolidated WHERE user_id=$1`,
    [otherUserId],
  );
  return {
    calls,
    rooms,
    messagesFromOther: msgs?.n ?? 0,
    conversations: convs?.n ?? 0,
    profileRows: profiles?.n ?? 0,
    tokens: Number(profiles?.tokens ?? 0),
  };
}

/** Слепок historical-строки — форма совпадает с historicalRow() из pg-спека. */
export async function historicalSnapshot(
  pg: PgService,
  histUserId: string,
): Promise<Record<string, unknown>> {
  const user = await oneRow(
    pg,
    `SELECT state, deleted_at::text AS deleted_at, deletion_id::text AS deletion_id,
            welcome_bonus_at::text AS welcome_bonus_at
       FROM user_id WHERE internal_id=$1`,
    [histUserId],
  );
  const profile = await oneRow(
    pg,
    `SELECT count(*)::int AS n, COALESCE(max(profile_data::text),'') AS profile_data
       FROM ai_profiles_consolidated WHERE user_id=$1`,
    [histUserId],
  );
  const history = await oneRow(
    pg,
    `SELECT count(*)::int AS n, COALESCE(max(content),'') AS content
       FROM custom_chat_history
      WHERE session_id LIKE $1 || '\\_%' ESCAPE '\\'`,
    [histUserId],
  );
  return {
    user: user ?? null,
    profileRows: profile?.n ?? 0,
    profileData: profile?.profile_data ?? '',
    historyRows: history?.n ?? 0,
    historyContent: history?.content ?? '',
  };
}

/**
 * Строка хоста продуктов synthetic (SYNTHETIC_HOST_ID). Форма строки — из
 * product pg spec, id и хеш токена — свои. accepts_new = false: продукт
 * посева ставится на хост явным host_id, а pickForNewProduct (единственный
 * читатель accepts_new) на пути synthetic не вызывается — зато живой API
 * стенда, который смотрит в ту же базу, пока идёт прогон, не выберет
 * фиктивную машину для чужого нового продукта.
 *
 * ON CONFLICT … DO UPDATE SET accepts_new = false, а не DO NOTHING: строка
 * могла остаться от прерванного прогона и быть открытой для новых — посев
 * закрывает её в любом случае. Остальные поля существующей строки не
 * трогаются.
 *
 * Хеш токена агента — от случайных байтов на каждый посев: сам токен не
 * сохраняется и никому не известен, поэтому HostGuard (сверяет sha256
 * токена с agent_token_hash) от имени синтетического хоста не пропустит.
 * Хеш от фиксированной строки вычислил бы любой читатель публичного
 * репозитория. У строки, оставшейся от прошлого прогона, DO UPDATE хеш не
 * меняет — это допустимо: такая строка живёт до уборки этого же прогона
 * (cleanupSyntheticFixture удаляет хост).
 */
export async function seedSyntheticHost(pg: PgService): Promise<void> {
  await pg.query(
    `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience, accepts_new)
     VALUES ($1,'root@10.50.0.1','10.50.0.1','c.linkeon.io',$2,20,'clients',false)
     ON CONFLICT (id) DO UPDATE SET accepts_new = false`,
    [SYNTHETIC_HOST_ID, sha256(randomBytes(32).toString('hex'))],
  );
}

/**
 * Полный посев синтетического аккаунта: по ресурсу на каждый домен,
 * чьи purge/stop-задачи должны реально исполниться. Все ключи и тексты —
 * с префиксом synthetic-deletion- (или синтетические UUID/телефоны),
 * включая хост продуктов SYNTHETIC_HOST_ID.
 */
export async function seedSyntheticFixture(stack: SyntheticStack): Promise<SyntheticFixture> {
  const { pg } = stack;
  const main = SYNTHETIC_MAIN_PHONE;
  const other = SYNTHETIC_OTHER_ID;
  const hist = SYNTHETIC_HIST_PHONE;
  // T22-Q5: синтетические аккаунты — scope подтверждений simulateHostAgent.
  for (const userId of [main, other, hist]) stack.hostAgentScope.add(userId);

  // Сосед — обычный активный аккаунт без удаления.
  await pg.query(
    `INSERT INTO user_id (internal_id, primary_phone, state)
     VALUES ($1, NULL, 'active')`,
    [other],
  );
  await pg.query(
    `INSERT INTO ai_profiles_consolidated (user_id, isadmin, tokens)
     VALUES ($1, false, 7000)`,
    [other],
  );

  // Historical deleted БЕЗ deletion_id — контрольная строка старого
  // поколения удалений (ловушка 14): координатор её не видит.
  await pg.query(
    `INSERT INTO user_id (internal_id, primary_phone, state, deleted_at, welcome_bonus_at)
     VALUES ($1, $2, 'deleted', now() - interval '400 days', now() - interval '400 days')`,
    [hist, hist],
  );
  await pg.query(
    `INSERT INTO ai_profiles_consolidated (user_id, isadmin, tokens, profile_data)
     VALUES ($1, false, 0, '{"synthetic":"kept"}'::jsonb)`,
    [hist],
  );
  await pg.query(
    `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
     VALUES ($1 || '_1', 'human', 12, 'synthetic historical message', 'text')`,
    [hist],
  );

  // Основной аккаунт — ПРОД-путь identity.
  const created = await stack.identity.resolveOrCreate('phone', { phone: main });
  if (created.status !== 'ok') {
    throw new Error(`resolveOrCreate(main) вернул ${created.status}`);
  }
  await stack.seedHistoryRow(main, `${SYNTHETIC_DELETION_PREFIX}first`);

  // Звонки: личный (с внешним ботом) и общая встреча с соседом.
  const soleCallId = randomUUID();
  const sharedCallId = randomUUID();
  const otherCallId = randomUUID();
  const roomCode = `${SYNTHETIC_DELETION_PREFIX}shared`;
  await pg.query(
    `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status, started_at, external_bot_id)
     VALUES ($1,$2,12,$3,'active',now(),$4)`,
    [soleCallId, main, `${SYNTHETIC_DELETION_PREFIX}room-sole`, `${SYNTHETIC_DELETION_PREFIX}bot-1`],
  );
  await pg.query(
    `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status, started_at)
     VALUES ($1,$2,12,$3,'active',now())`,
    [sharedCallId, main, `room_${roomCode}`],
  );
  await pg.query(
    `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status, started_at, ended_at)
     VALUES ($1,$2,12,$3,'ended',now(),now())`,
    [otherCallId, other, `room_${roomCode}`],
  );
  await pg.query(
    `INSERT INTO meeting_rooms (code, owner_user_id, title, created_at)
     VALUES ($1,$2,'synthetic meeting',now())`,
    [roomCode, main],
  );

  // Клон ElevenLabs.
  const voiceId = `${SYNTHETIC_DELETION_PREFIX}voice-id`;
  await pg.query(
    `INSERT INTO user_voice (user_id, elevenlabs_voice_id, consent_at, status)
     VALUES ($1,$2,now(),'ready')`,
    [main, voiceId],
  );

  // Telegram-бот + кастомный агент + видео-джоб с доставкой в чат.
  const tgConfigId = randomUUID();
  const customAgentId = randomUUID();
  const videoJobId = randomUUID();
  await pg.query(
    `INSERT INTO tg_bot_configs
       (id, owner_user_id, tg_chat_id, display_name, preset_agent_id,
        addressing_mode, voice_reply_mode, status, created_at)
     VALUES ($1,$2,-100777001,$3,'12','smart','never','active',now())`,
    [tgConfigId, main, `${SYNTHETIC_DELETION_PREFIX}group`],
  );
  await pg.query(
    `INSERT INTO tg_claim_tokens (token, kind, owner_user_id, config_id, expires_at)
     VALUES ($1,'claim',$2,$3,now() + interval '1 hour')`,
    [randomUUID(), main, tgConfigId],
  );
  await pg.query(
    `INSERT INTO tg_bot_messages
       (config_id, tg_chat_id, tg_user_id, tg_user_name, role, content, content_type, created_at)
     VALUES ($1,-100777001,777001,'synthetic_tg','user','synthetic message','text',now())`,
    [tgConfigId],
  );
  await pg.query(
    `INSERT INTO custom_agents (id, owner_user_id, name, system_prompt, created_at, updated_at)
     VALUES ($1,$2,$3,'synthetic prompt',now(),now())`,
    [customAgentId, main, `${SYNTHETIC_DELETION_PREFIX}agent`],
  );
  await pg.query(
    `INSERT INTO video_jobs (id, user_id, mode, model, quality, duration_sec, tokens_spent, status)
     VALUES ($1,$2,'t2v','synthetic-model','std',5,0,'done')`,
    [videoJobId, main],
  );
  await pg.query(
    `INSERT INTO tg_bot_video_jobs (job_id, tg_chat_id, config_id, delivery_status, created_at)
     VALUES ($1,-100777001,$2,'pending',now())`,
    [videoJobId, tgConfigId],
  );
  await pg.query(
    `INSERT INTO tg_user_identities (linkeon_user_id, tg_user_id, tg_username, tg_first_name, bound_at)
     VALUES ($1,777001,'synthetic_tg','Synthetic',now())`,
    [main],
  );

  // OAuth/интеграции.
  await pg.query(
    `INSERT INTO user_identities
       (id, user_id, provider, provider_sub, email_verified, provider_refresh_token, created_at, last_used_at)
     VALUES ($1,$2,'apple',$3,false,$4,now(),now())`,
    [randomUUID(), main, `${SYNTHETIC_DELETION_PREFIX}apple`, `${SYNTHETIC_DELETION_PREFIX}refresh`],
  );
  await pg.query(
    `INSERT INTO zoom_connections (user_id, zoom_user_id) VALUES ($1,$2)`,
    [main, `${SYNTHETIC_DELETION_PREFIX}zoom`],
  );
  await pg.query(
    `INSERT INTO talerid_connections (user_id, talerid_user_id) VALUES ($1,$2)`,
    [main, `${SYNTHETIC_DELETION_PREFIX}taler`],
  );

  // Календари и производные таблицы.
  await pg.query(
    `INSERT INTO calendar_connections (user_id, provider, base_url, username, secret_enc)
     VALUES ($1,'yandex','https://caldav.synthetic.test','synthetic-user','synthetic-secret-enc')`,
    [main],
  );
  await pg.query(
    `INSERT INTO calendar_proposals (id, user_id, event, connected)
     VALUES ($1,$2,'{"uid":"synthetic-deletion-event-1"}'::jsonb,true)`,
    [randomUUID(), main],
  );
  await pg.query(
    `INSERT INTO trip_calendars (user_id, kind, url) VALUES ($1,'url',$2)`,
    [main, `https://trip.synthetic.test/${SYNTHETIC_DELETION_PREFIX}trip`],
  );
  await pg.query(
    `INSERT INTO linkeon_tasks (uid, user_id, title, status)
     VALUES ($1,$2,$3,'pending')`,
    [randomUUID(), main, `${SYNTHETIC_DELETION_PREFIX}linkeon-task`],
  );
  await pg.query(
    `INSERT INTO day_framing (user_id, day, kind, text, facts_hash)
     VALUES ($1,CURRENT_DATE,'morning','synthetic framing',$2)`,
    [main, `${SYNTHETIC_DELETION_PREFIX}hash`],
  );

  // Продукт на СВОЁМ синтетическом хосте — см. seedSyntheticHost.
  await seedSyntheticHost(pg);
  const productId = randomUUID();
  await pg.query(
    `INSERT INTO products
       (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id)
     VALUES ($1,$2,'Synthetic Product',$3,'site','running','/product',$4,$5)`,
    [productId, main, `${SYNTHETIC_DELETION_PREFIX}product`, sha256(`runner-${productId}`), SYNTHETIC_HOST_ID],
  );

  // Задачи, тикеты, пиры.
  const taskId = randomUUID();
  await pg.query(
    `INSERT INTO tasks (id, user_id, title, summary, claudemd, status, last_active_at, created_at, updated_at)
     VALUES ($1,$2,$3,'','','active',now(),now(),now())`,
    [taskId, main, `${SYNTHETIC_DELETION_PREFIX}task`],
  );
  await pg.query(
    `INSERT INTO task_events (task_id, kind, content, created_at)
     VALUES ($1,'note','synthetic note',now())`,
    [taskId],
  );
  const ticketId = randomUUID();
  await pg.query(
    `INSERT INTO support_tickets (id, user_id, status, topic, created_at)
     VALUES ($1,$2,'ai_handling','synthetic topic',now())`,
    [ticketId, main],
  );
  await pg.query(
    `INSERT INTO support_messages (ticket_id, sender_type, content, created_at)
     VALUES ($1,'user','synthetic message',now())`,
    [ticketId],
  );
  const requestId = randomUUID();
  await pg.query(
    `INSERT INTO chat_requests (id, from_user_id, to_user_id, intro_message, status, created_at)
     VALUES ($1,$2,$3,'synthetic intro','pending',now())`,
    [requestId, main, other],
  );
  const conversationId = randomUUID();
  await pg.query(
    `INSERT INTO peer_conversations (id, user_a_id, user_b_id, request_id, created_at)
     VALUES ($1,$2,$3,$4,now())`,
    [conversationId, main, other, requestId],
  );
  await pg.query(
    `INSERT INTO peer_messages (id, conversation_id, sender_id, content, created_at)
     VALUES ($1,$2,$3,'synthetic main message',now())`,
    [randomUUID(), conversationId, main],
  );
  await pg.query(
    `INSERT INTO peer_messages (id, conversation_id, sender_id, content, created_at)
     VALUES ($1,$2,$3,'synthetic other message',now())`,
    [randomUUID(), conversationId, other],
  );
  await pg.query(
    `INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES ($1,$2,now())`,
    [main, other],
  );
  await pg.query(
    `INSERT INTO user_reports (id, reporter_id, target_id, reason, created_at)
     VALUES ($1,$2,$3,'synthetic reason',now())`,
    [randomUUID(), main, other],
  );

  // Контакты (суррогатные id из ai_profiles_consolidated).
  const surMain = await oneRow(
    pg,
    `SELECT id FROM ai_profiles_consolidated WHERE user_id=$1`,
    [main],
  );
  const surOther = await oneRow(
    pg,
    `SELECT id FROM ai_profiles_consolidated WHERE user_id=$1`,
    [other],
  );
  if (surMain && surOther) {
    await pg.query(
      `INSERT INTO contact_requests (requester_id, target_id, message, status, created_at)
       VALUES ($1,$2,'synthetic contact message','pending',now())`,
      [surMain.id, surOther.id],
    );
  }

  // Реферальная подсеть лидера.
  const leaderId = randomUUID();
  await pg.query(
    `INSERT INTO referral_leaders (id, name, slug, user_phone, level, is_active, created_at)
     VALUES ($1,'Synthetic Leader',$2,$3,1,true,now())`,
    [leaderId, `${SYNTHETIC_DELETION_PREFIX}leader`, main],
  );
  await pg.query(
    `INSERT INTO referral_referees (id, referee_phone, leader_id, registered_at)
     VALUES ($1,$2,$3,now())`,
    [randomUUID(), main, leaderId],
  );
  await pg.query(
    `INSERT INTO referral_commissions
       (id, leader_id, referee_phone, commission_level, payment_amount_rub,
        commission_pct, commission_rub, paid_out, created_at)
     VALUES ($1,$2,$3,1,1000,10,100,false,now())`,
    [randomUUID(), leaderId, main],
  );
  // Вывод в settled-статусе ('paid'): pending-заявка по дизайну блокирует
  // referral.purge до решения админа (вечный retry) — этот путь покрыт
  // отдельным referral-account-deletion.pg.spec.ts.
  await pg.query(
    `INSERT INTO referral_withdrawals
       (id, leader_id, user_phone, amount_rub, method, requisites, status, commission_ids, created_at)
     VALUES ($1,$2,$3,100,'card','synthetic card 0000','paid','{}',now())`,
    [randomUUID(), leaderId, main],
  );
  await pg.query(
    `INSERT INTO referral_token_payouts
       (id, leader_id, user_phone, rub, tokens, rate, commission_ids, created_at)
     VALUES ($1,$2,$3,10,100,7200,'{}',now())`,
    [randomUUID(), leaderId, main],
  );

  // Мелочь: устройства, события, бэкап, проба, legacy-auth, картинки, речь.
  await pg.query(
    `INSERT INTO user_devices (user_id, signature, platform, first_seen, last_seen)
     VALUES ($1,$2,'web',now(),now())`,
    [main, `${SYNTHETIC_DELETION_PREFIX}signature`],
  );
  await pg.query(
    `INSERT INTO events (user_id, session_id, name, props, source)
     VALUES ($1,$2,'synthetic_event','{"synthetic":true}'::jsonb,'spec')`,
    [main, `${SYNTHETIC_DELETION_PREFIX}session`],
  );
  await pg.query(
    `INSERT INTO profile_backups (user_id, blob, size_bytes, format, updated_at)
     VALUES ($1,'\\x00'::bytea,1,1,now())`,
    [main],
  );
  await pg.query(
    `INSERT INTO guest_trial_sessions
       (id, token_hash, assistant_id, lang, source, claimed_by_hash, claimed_at)
     VALUES ($1,$2,12,'ru','synthetic',$3,now())`,
    [randomUUID(), `${SYNTHETIC_DELETION_PREFIX}guest-token`, hashClaimer(main)],
  );
  await pg.query(
    `INSERT INTO short_codes (phone, short_code, created_at) VALUES ($1,'987654',now())`,
    [main],
  );
  await pg.query(
    `INSERT INTO generated_images (user_id, prompt, image_url, tokens_spent, created_at)
     VALUES ($1,'synthetic prompt',$2,5000,now())`,
    [main, `https://minio.test/synthetic-assets/${SYNTHETIC_DELETION_PREFIX}image.png`],
  );
  await pg.query(
    `INSERT INTO speech_clips (user_id, cache_key, url, chars, provider, voice, lang)
     VALUES ($1,$2,$3,10,'synthetic','synthetic','ru')`,
    [main, `${SYNTHETIC_DELETION_PREFIX}clip`, `https://minio.test/synthetic-assets/${SYNTHETIC_DELETION_PREFIX}clip.mp3`],
  );
  await pg.query(
    `INSERT INTO speech_listens (user_id, cache_key, parts, chars, provider, voice, lang)
     VALUES ($1,$2,'[]'::jsonb,10,'synthetic','synthetic','ru')`,
    [main, `${SYNTHETIC_DELETION_PREFIX}listen`],
  );

  return {
    mainUserId: main,
    otherUserId: other,
    histUserId: hist,
    productId,
    soleCallId,
    sharedCallId,
    otherCallId,
    roomCode,
    tgConfigId,
    customAgentId,
    videoJobId,
    voiceId,
    allSharedResources: await sharedResourcesSnapshot(pg, other),
    historicalControl: await historicalSnapshot(pg, hist),
  };
}

/**
 * Ресев ресурсов, которые первое поколение удаления ИЗРАСХОДОВАЛО и которые
 * реактивация не восстанавливает (это честная прод-семантика, не баг):
 *  - account.core.immediate удаляет ВСЕ user_identities → discovery
 *    integration.apple.stop второго поколения не нашёл бы строку apple;
 *  - voice.stop прерывает звонки (status уходит из dialing/active,
 *    external_bot_id чистится) → discovery voice.stop пуст.
 * Сценарий моделирует вернувшегося пользователя: новая связка Apple и новый
 * активный звонок. Комнаты/сосед не затрагиваются (снимок allSharedResources
 * остаётся валидным).
 */
export async function reseedConsumedResources(
  stack: SyntheticStack,
  userId: string,
): Promise<void> {
  const { pg } = stack;
  await pg.query(
    `INSERT INTO user_identities
       (id, user_id, provider, provider_sub, email_verified, provider_refresh_token, created_at, last_used_at)
     VALUES ($1,$2,'apple',$3,false,$4,now(),now())`,
    [randomUUID(), userId, `${SYNTHETIC_DELETION_PREFIX}apple-2`, `${SYNTHETIC_DELETION_PREFIX}refresh-2`],
  );
  await pg.query(
    `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status, started_at, external_bot_id)
     VALUES ($1,$2,12,$3,'active',now(),$4)`,
    [randomUUID(), userId, `${SYNTHETIC_DELETION_PREFIX}room-sole-2`, `${SYNTHETIC_DELETION_PREFIX}bot-2`],
  );
}

/**
 * Уборка фикстур по deletionId/userId и по SYNTHETIC_HOST_ID — в CLI
 * вызывается из finally. Порядок: сначала задачи удаления, затем дочерние
 * таблицы (продукты — и по user_id, и все продукты синтетического хоста;
 * следом сам хост), затем аккаунты. Каждая группа независима — свой
 * try/catch, чтобы одна несуществующая таблица не оставляла мусор во всех
 * остальных.
 */
export async function cleanupSyntheticFixture(
  stack: SyntheticStack,
  input: { deletionIds: readonly string[]; userIds: readonly string[] },
): Promise<void> {
  const { pg } = stack;
  const userIds = [...input.userIds];
  const groups: Array<readonly [string, unknown[]]> = [
    [`DELETE FROM account_deletion_jobs WHERE deletion_id = ANY($1::uuid[])`, [input.deletionIds]],
    // T22-Q6: дополнительно стираем задачи поколений по user_id — он известен
    // всегда, а deletionId при броске внутри runSyntheticScenario может не
    // успеть попасть в out-массив; иначе orphan-задачи (например
    // account.core.purge на +30д) оставались бы на стенде.
    [`DELETE FROM account_deletion_jobs WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM tg_bot_video_jobs WHERE tg_chat_id = -100777001`, []],
    [`DELETE FROM tg_bot_messages WHERE config_id IN (SELECT id FROM tg_bot_configs WHERE owner_user_id = ANY($1))`, [userIds]],
    [`DELETE FROM tg_claim_tokens WHERE owner_user_id = ANY($1)`, [userIds]],
    [`DELETE FROM tg_bot_configs WHERE owner_user_id = ANY($1)`, [userIds]],
    [`DELETE FROM tg_user_identities WHERE linkeon_user_id = ANY($1)`, [userIds]],
    [`DELETE FROM custom_agents WHERE owner_user_id = ANY($1)`, [userIds]],
    [`DELETE FROM video_jobs WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM voice_call_jobs WHERE call_id IN (SELECT id FROM voice_calls WHERE user_id = ANY($1))`, [userIds]],
    [`DELETE FROM voice_calls WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM meeting_rooms WHERE owner_user_id = ANY($1)`, [userIds]],
    [`DELETE FROM user_voice WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM user_identities WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM zoom_connections WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM talerid_connections WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM calendar_proposals WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM calendar_connections WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM trip_calendars WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM linkeon_tasks WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM day_framing WHERE user_id = ANY($1)`, [userIds]],
    // Журнал product_actions ссылается на products с ON DELETE SET NULL:
    // после удаления продукта его строки уже не найти по product_id. Поэтому
    // журнал — ДО products: по user_id синтетических аккаунтов и по
    // продуктам синтетического хоста.
    [`DELETE FROM product_actions
       WHERE user_id = ANY($1)
          OR product_id IN (SELECT id FROM products WHERE user_id = ANY($1) OR host_id = $2)`, [userIds, SYNTHETIC_HOST_ID]],
    [`DELETE FROM product_provision_jobs WHERE product_id IN (SELECT id FROM products WHERE user_id = ANY($1))`, [userIds]],
    [`DELETE FROM products WHERE user_id = ANY($1)`, [userIds]],
    // Синтетический хост: сначала ВСЕ продукты на нём, независимо от
    // user_id (products.host_id → product_hosts без ON DELETE — хост с
    // продуктом не удалить). product_turns и product_domains уходят
    // каскадом от products, задания — явно, как и выше. Затем отметка
    // агента (CASCADE от хоста, убираем явно) и сам хост.
    [`DELETE FROM product_provision_jobs WHERE product_id IN (SELECT id FROM products WHERE host_id = $1)`, [SYNTHETIC_HOST_ID]],
    [`DELETE FROM products WHERE host_id = $1`, [SYNTHETIC_HOST_ID]],
    [`DELETE FROM product_host_agent WHERE host_id = $1`, [SYNTHETIC_HOST_ID]],
    [`DELETE FROM product_hosts WHERE id = $1`, [SYNTHETIC_HOST_ID]],
    [`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE user_id = ANY($1))`, [userIds]],
    [`DELETE FROM tasks WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM support_messages WHERE ticket_id IN (SELECT id FROM support_tickets WHERE user_id = ANY($1))`, [userIds]],
    [`DELETE FROM support_events WHERE ticket_id IN (SELECT id FROM support_tickets WHERE user_id = ANY($1))`, [userIds]],
    [`DELETE FROM support_tickets WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM peer_messages WHERE conversation_id IN (SELECT id FROM peer_conversations WHERE user_a_id = ANY($1) OR user_b_id = ANY($1))`, [userIds]],
    [`DELETE FROM peer_conversations WHERE user_a_id = ANY($1) OR user_b_id = ANY($1) OR user_a_id LIKE 'deleted:%' OR user_b_id LIKE 'deleted:%'`, [userIds]],
    [`DELETE FROM chat_requests WHERE from_user_id = ANY($1) OR to_user_id = ANY($1)`, [userIds]],
    [`DELETE FROM user_blocks WHERE blocker_id = ANY($1) OR blocked_id = ANY($1)`, [userIds]],
    [`DELETE FROM user_reports WHERE reporter_id = ANY($1) OR target_id = ANY($1)`, [userIds]],
    [`DELETE FROM contact_requests
       WHERE requester_id IN (SELECT id FROM ai_profiles_consolidated WHERE user_id = ANY($1))
          OR target_id IN (SELECT id FROM ai_profiles_consolidated WHERE user_id = ANY($1))`, [userIds]],
    [`DELETE FROM referral_token_payouts WHERE leader_id IN (SELECT id FROM referral_leaders WHERE user_phone = ANY($1))`, [userIds]],
    [`DELETE FROM referral_withdrawals WHERE leader_id IN (SELECT id FROM referral_leaders WHERE user_phone = ANY($1))`, [userIds]],
    [`DELETE FROM referral_commissions WHERE leader_id IN (SELECT id FROM referral_leaders WHERE user_phone = ANY($1))`, [userIds]],
    [`DELETE FROM referral_referees WHERE leader_id IN (SELECT id FROM referral_leaders WHERE user_phone = ANY($1))`, [userIds]],
    [`DELETE FROM referral_leaders WHERE user_phone = ANY($1)`, [userIds]],
    [`DELETE FROM user_devices WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM events WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM profile_backups WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM guest_trial_sessions WHERE claimed_by_hash = ANY($1) OR token_hash LIKE $2`, [userIds.map((id) => hashClaimer(id)), `${SYNTHETIC_DELETION_PREFIX}%`]],
    [`DELETE FROM short_codes WHERE phone = ANY($1)`, [userIds]],
    [`DELETE FROM generated_images WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM speech_clips WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM speech_listens WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM token_transactions WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM custom_chat_history WHERE session_id LIKE 'synthetic%' OR split_part(session_id,'_',1) = ANY($1)`, [userIds]],
    [`DELETE FROM ai_profiles_consolidated WHERE user_id = ANY($1)`, [userIds]],
    [`DELETE FROM user_id WHERE internal_id = ANY($1)`, [userIds]],
  ];
  for (const [sql, params] of groups) {
    try {
      await pg.query(sql, params as any[]);
    } catch {
      // одноразовая схема/стенд: недостающая таблица не должна ронять уборку
    }
  }
}

// ------------------------------------------------------ сценарий для CLI

export interface SyntheticScenarioCounts {
  readonly stoppedTypes: number;
  readonly firstJobs: number;
  readonly cancelledJobs: number;
  readonly secondJobs: number;
  readonly failedKinds: readonly string[];
  readonly doneJobs: number;
  readonly externalCalls: number;
  readonly hostConfirmations: number;
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`synthetic_assert_failed: ${message}`);
}

const ALL_STOP_TYPES: readonly string[] = [
  'account.core.immediate',
  'auth-verification.stop',
  'calendar.stop',
  'guest-carry.stop',
  'integration.apple.stop',
  'integration.talerid.stop',
  'integration.zoom.stop',
  'peer.stop',
  'product.stop',
  'referral.stop',
  'retention.stop',
  'support.stop',
  'tasks.stop',
  'telegram.stop',
  'voice.stop',
];

async function distinctStopped(pg: PgService, deletionId: string): Promise<string[]> {
  return (await pg.query(
    `SELECT DISTINCT resource_type FROM account_deletion_jobs
      WHERE deletion_id=$1 AND phase='immediate' AND status='done'
      ORDER BY 1`,
    [deletionId],
  )).rows.map((row: any) => row.resource_type);
}

async function distinctFailedKinds(pg: PgService, deletionId: string): Promise<string[]> {
  return (await pg.query(
    `SELECT DISTINCT last_error_kind FROM account_deletion_jobs
      WHERE deletion_id=$1 AND status='failed' AND last_error_kind IS NOT NULL
      ORDER BY 1`,
    [deletionId],
  )).rows.map((row: any) => row.last_error_kind);
}

async function unfinishedCount(pg: PgService, deletionId: string): Promise<number> {
  const row = await oneRow(
    pg,
    `SELECT count(*)::int AS n FROM account_deletion_jobs
      WHERE deletion_id=$1 AND status IN ('pending','running','failed')`,
    [deletionId],
  );
  return row?.n ?? 0;
}

async function externalIdsPresent(pg: PgService, userId: string): Promise<boolean> {
  const row = await oneRow(
    pg,
    `SELECT (
       EXISTS (SELECT 1 FROM user_voice v
                WHERE v.user_id=$1 AND v.elevenlabs_voice_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM products p
                   WHERE p.user_id=$1 AND p.purged_at IS NULL)
     ) AS present`,
    [userId],
  );
  return row?.present === true;
}

/**
 * deleteExplicit с симулятором host-агента (pull-модель продуктов):
 * 503 → подтвердить queued sleep/purge → перемотать failed → повтор.
 * Прод-сигнатура deleteExplicit (Promise<void>) не меняется; deletion_id
 * читается из user_id.
 */
export async function deleteExplicitWithHost(
  stack: SyntheticStack,
  userId: string,
): Promise<{ deletionId: string }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await stack.lifecycle.deleteExplicit(userId);
      const row = await oneRow(
        stack.pg,
        `SELECT deletion_id::text AS d FROM user_id WHERE internal_id=$1`,
        [userId],
      );
      assert(row?.d, 'deletion_id не выставлен после deleteExplicit');
      return { deletionId: row.d as string };
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) throw error;
      await stack.simulateHostAgent();
      await stack.pg.query(
        `UPDATE account_deletion_jobs
            SET next_attempt_at = now()
          WHERE user_id = $1 AND status = 'failed'`,
        [userId],
      );
    }
  }
  throw new Error('synthetic_assert_failed: deleteExplicit не завершился за 8 попыток');
}

/**
 * tick с env-гейтом воркера и перемоткой next_attempt_at (purge-задачи
 * планируются на deletedAt+30д; rewind — тестовая фикстура). retentionMs
 * передаётся ТОЛЬКО сюда аргументом.
 */
export async function tickSynthetic(
  stack: SyntheticStack,
  coordinator: AccountDeletionCoordinator,
  deletionId: string,
  options: { retentionMs: number; batchSize?: number },
): Promise<void> {
  await stack.pg.query(
    `UPDATE account_deletion_jobs
        SET next_attempt_at = now() - interval '1 second'
      WHERE deletion_id = $1 AND status IN ('pending','failed')`,
    [deletionId],
  );
  // products.purge_after = deleted_at+30д (PRODUCT_DELETION_PURGE_DAYS —
  // константа, не retentionMs): queuePurgeForProduct ставит host-задание
  // только при purge_after <= now(). Перемотка — та же тестовая фикстура,
  // что и next_attempt_at (ускорение retention продукта).
  await stack.pg.query(
    `UPDATE products
        SET purge_after = now() - interval '1 day'
      WHERE purged_at IS NULL AND purge_after IS NOT NULL
        AND user_id IN (SELECT user_id FROM account_deletion_jobs
                         WHERE deletion_id = $1)`,
    [deletionId],
  );
  process.env.ACCOUNT_DELETION_WORKER_ENABLED = 'true';
  try {
    await coordinator.tick({
      retentionMs: options.retentionMs,
      batchSize: options.batchSize ?? 2,
    });
  } finally {
    delete process.env.ACCOUNT_DELETION_WORKER_ENABLED;
  }
}

/**
 * Сценарий CLI (Gate B): тот же lifecycle, что в pg-спеке, с assert-ами
 * вместо expect-ов. Возвращает счётчики для stdout (только числа и kinds —
 * никаких userId/телефонов/внешних ID).
 */
export async function runSyntheticScenario(
  stack: SyntheticStack,
  fixture: SyntheticFixture,
  /** Out-параметр: id поколений для уборки в finally (CLI). */
  deletionIdsOut?: string[],
): Promise<SyntheticScenarioCounts> {
  const { pg, failures } = stack;
  const deletionIds: string[] = deletionIdsOut ?? [];
  let hostConfirmations = 0;

  // Фаза 1: первое удаление — все immediate done.
  const first = await deleteExplicitWithHost(stack, fixture.mainUserId);
  deletionIds.push(first.deletionId);
  const stopped = await distinctStopped(pg, first.deletionId);
  assert(
    JSON.stringify(stopped) === JSON.stringify([...ALL_STOP_TYPES].sort()),
    'stopped types != ALL_STOP_TYPES',
  );
  const firstJobs = (await oneRow(
    pg,
    `SELECT count(*)::int AS n FROM account_deletion_jobs WHERE deletion_id=$1`,
    [first.deletionId],
  ))?.n ?? 0;
  assert(await externalIdsPresent(pg, fixture.mainUserId), 'external ids исчезли до purge');

  // Фаза 2: реактивация прод-путём отменяет поколение.
  const reactivated = await stack.identity.resolveOrCreate('phone', {
    phone: SYNTHETIC_MAIN_PHONE,
  });
  assert(reactivated.status === 'ok', `reactivate вернул ${reactivated.status}`);
  await stack.runner.runAccount(first.deletionId);
  const state = await oneRow(
    pg,
    `SELECT state, deletion_id::text AS d FROM user_id WHERE internal_id=$1`,
    [fixture.mainUserId],
  );
  assert(state?.state === 'active' && state?.d == null, 'аккаунт не вернулся в active');
  const cancelledJobs = (await oneRow(
    pg,
    `SELECT count(*)::int AS n FROM account_deletion_jobs
      WHERE deletion_id=$1 AND status='cancelled'`,
    [first.deletionId],
  ))?.n ?? 0;
  assert(cancelledJobs > 0, 'реактивация не отменила задачи поколения');
  await stack.seedHistoryRow(fixture.mainUserId, `${SYNTHETIC_DELETION_PREFIX}second`);
  await reseedConsumedResources(stack, fixture.mainUserId);

  // Фаза 3: второе удаление — новый UUID поколения.
  const second = await deleteExplicitWithHost(stack, fixture.mainUserId);
  deletionIds.push(second.deletionId);
  assert(second.deletionId !== first.deletionId, 'deletion_id не сменился');
  const secondJobs = (await oneRow(
    pg,
    `SELECT count(*)::int AS n FROM account_deletion_jobs WHERE deletion_id=$1`,
    [second.deletionId],
  ))?.n ?? 0;

  // Фаза 4: partial failures на четырёх границах.
  failures
    .inject('minio', 'timeout')
    .inject('host', 'external_unknown')
    .inject('elevenlabs', 'external_5xx')
    .inject('calendar', 'external_5xx');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await tickSynthetic(stack, stack.coordinator, second.deletionId, {
    retentionMs: 1,
    batchSize: 2,
  });
  const failed = await distinctFailedKinds(pg, second.deletionId);
  for (const kind of ['timeout', 'external_unknown', 'external_5xx']) {
    assert(failed.includes(kind), `нет ожидаемого kind ${kind}`);
  }
  assert(await externalIdsPresent(pg, fixture.mainUserId), 'отказ не сохранил внешние id');
  assert((await unfinishedCount(pg, second.deletionId)) > 0, 'нет незавершённых после отказов');

  // Фаза 5: retry доделывает всё; чужое и historical не тронуты.
  for (let round = 0; round < 6; round += 1) {
    failures.clear();
    await tickSynthetic(stack, stack.coordinator, second.deletionId, { retentionMs: 0 });
    hostConfirmations += await stack.simulateHostAgent();
    if ((await unfinishedCount(pg, second.deletionId)) === 0) break;
  }
  assert((await unfinishedCount(pg, second.deletionId)) === 0, 'остались незавершённые задачи');
  assert(!(await externalIdsPresent(pg, fixture.mainUserId)), 'внешние id пережили полный purge');

  const shared = await sharedResourcesSnapshot(pg, fixture.otherUserId);
  assert(
    JSON.stringify(shared) === JSON.stringify(fixture.allSharedResources),
    'ресурсы соседа изменились',
  );
  const hist = await historicalSnapshot(pg, fixture.histUserId);
  assert(
    JSON.stringify(hist) === JSON.stringify(fixture.historicalControl),
    'historical control row изменился',
  );

  return {
    stoppedTypes: stopped.length,
    firstJobs,
    cancelledJobs,
    secondJobs,
    failedKinds: failed,
    doneJobs: (await oneRow(
      pg,
      `SELECT count(*)::int AS n FROM account_deletion_jobs
        WHERE deletion_id = ANY($1::uuid[]) AND status='done'`,
      [deletionIds],
    ))?.n ?? 0,
    externalCalls: failures.totalCalls(),
    hostConfirmations,
  };
}
