import { discoverRoutinePushDeletion } from '../routine-push/routine-account-deletion.adapter';
import { discoverTelegramDeletion } from '../tg-bot/tg-account-deletion.adapter';
import { discoverProductDeletion } from '../products/product-account-deletion.adapter';
import { discoverCalendarDeletion } from '../calendar/calendar-account-deletion.adapter';
import { discoverIntegrationDeletion } from '../integrations/integration-account-deletion.adapter';
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
};
