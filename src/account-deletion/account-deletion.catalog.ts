import { discoverRoutinePushDeletion } from '../routine-push/routine-account-deletion.adapter';
import { discoverTelegramDeletion } from '../tg-bot/tg-account-deletion.adapter';
import { discoverProductDeletion } from '../products/product-account-deletion.adapter';
import { discoverCalendarDeletion } from '../calendar/calendar-account-deletion.adapter';
import { discoverIntegrationDeletion } from '../integrations/integration-account-deletion.adapter';
import { discoverVoiceDeletion } from '../voice-call/voice-account-deletion.adapter';
import { discoverVoiceDocuments } from '../voice-call/voice-document-account-deletion';
import { discoverChatFiles } from '../chat/chat-files/chat-file-account-deletion.adapter';
import { discoverImageDeletion } from '../misc/image-account-deletion.adapter';
import { discoverVideoDeletion } from '../video/video-account-deletion.adapter';
import { discoverSpeechDeletion } from '../speech/speech-account-deletion.adapter';
import { discoverAvatarDeletion } from '../avatar/avatar-account-deletion.adapter';
import { discoverVoiceAvatarDeletion } from '../voice-avatar/voice-account-deletion.adapter';
import { discoverEventsDeletion } from '../events/events-account-deletion.adapter';
import { discoverTasksDeletion } from '../tasks/tasks-account-deletion.adapter';
import { discoverSupportDeletion } from '../support/support-account-deletion.adapter';
import { discoverPeerDeletion } from '../peer/peer-account-deletion.adapter';
import { discoverContactsDeletion } from '../contacts/contacts-account-deletion.adapter';
import type {
  DeletionDiscoverer,
  DeletionResourceType,
} from './account-deletion.types';

export const DELETION_DISCOVERERS: readonly DeletionDiscoverer[] = [
  discoverRoutinePushDeletion,
  discoverTelegramDeletion,
  discoverProductDeletion,
  discoverCalendarDeletion,
  discoverIntegrationDeletion,
  discoverVoiceDeletion,
  discoverVoiceDocuments,
  discoverChatFiles,
  discoverImageDeletion,
  discoverVideoDeletion,
  discoverSpeechDeletion,
  discoverAvatarDeletion,
  discoverVoiceAvatarDeletion,
  discoverEventsDeletion,
  discoverTasksDeletion,
  discoverSupportDeletion,
  discoverPeerDeletion,
  discoverContactsDeletion,
];

export interface DeletionDependencyRule {
  /** Ждать успешного завершения всех stop-задач этого deletion generation. */
  readonly allStop?: boolean;
  /** Ждать все задачи перечисленных типов этого deletion generation. */
  readonly allOf?: readonly DeletionResourceType[];
  /** Ждать задачи перечисленных типов с тем же resourceKey. */
  readonly sameResourceKey?: readonly DeletionResourceType[];
}

/**
 * Отсутствие правила означает независимую задачу. Runner сопоставляет
 * зависимости только внутри того же deletion generation.
 */
export const DELETION_DEPENDENCIES: Readonly<Partial<Record<
  DeletionResourceType,
  DeletionDependencyRule
>>> = {
  'account.core.immediate': { allStop: true },
  'account.core.purge': { allStop: true },
  'product.purge': { sameResourceKey: ['product.stop'] },
  // Секреты и строки календаря стираются только после успешной остановки
  // подключений (design spec: «Остановка ... происходит до удаления»).
  'calendar.purge': { allOf: ['calendar.stop'] },
  'custom-agent.purge': { allOf: ['telegram.purge'] },
  'voice.purge': {
    sameResourceKey: ['voice.stop'],
    allOf: ['voice-document.purge'],
  },
  // Task 17A: строки tasks/support стираются только после остановки
  // (архивация задач / закрытие тикетов). resourceKey статический
  // ('tasks'/'support', по одному job на аккаунт), поэтому allOf
  // эквивалентно sameResourceKey — форма как у calendar.purge.
  'tasks.purge': { allOf: ['tasks.stop'] },
  'support.purge': { allOf: ['support.stop'] },
  // Task 17B: алиасинг chat_requests выполняется после того, как stop снял
  // собственные pending-заявки поколения — partial unique
  // uniq_chat_requests_pending не видит пар удалённого ни до, ни после alias.
  // resourceKey статический ('peer'), поэтому allOf эквивалентно
  // sameResourceKey — форма как у tasks/support.
  'peer.purge': { allOf: ['peer.stop'] },
};
