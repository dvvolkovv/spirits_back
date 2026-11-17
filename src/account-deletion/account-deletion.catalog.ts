import { discoverRoutinePushDeletion } from '../routine-push/routine-account-deletion.adapter';
import { discoverTelegramDeletion } from '../tg-bot/tg-account-deletion.adapter';
import { discoverProductDeletion } from '../products/product-account-deletion.adapter';
import { discoverCalendarDeletion } from '../calendar/calendar-account-deletion.adapter';
import { discoverIntegrationDeletion } from '../integrations/integration-account-deletion.adapter';
import { discoverVoiceDeletion } from '../voice-call/voice-account-deletion.adapter';
import { discoverVoiceDocuments } from '../voice-call/voice-document-account-deletion';
import { discoverChatFiles } from '../chat/chat-files/chat-file-account-deletion.adapter';
import { discoverChatUploads } from '../chat/chat-uploads/chat-upload-account-deletion.adapter';
import { discoverImageDeletion } from '../misc/image-account-deletion.adapter';
import {
  discoverVideoDeletion,
  discoverVideoUploadsDeletion,
} from '../video/video-account-deletion.adapter';
import { discoverSpeechDeletion } from '../speech/speech-account-deletion.adapter';
import { discoverAvatarDeletion } from '../avatar/avatar-account-deletion.adapter';
import { discoverVoiceAvatarDeletion } from '../voice-avatar/voice-account-deletion.adapter';
import { discoverEventsDeletion } from '../events/events-account-deletion.adapter';
import { discoverTasksDeletion } from '../tasks/tasks-account-deletion.adapter';
import { discoverSupportDeletion } from '../support/support-account-deletion.adapter';
import { discoverPeerDeletion } from '../peer/peer-account-deletion.adapter';
import { discoverContactsDeletion } from '../contacts/contacts-account-deletion.adapter';
import { discoverReferralDeletion } from '../referral/referral-account-deletion.adapter';
import { discoverRetentionDeletion } from '../retention/retention-account-deletion.adapter';
import { discoverBackupDeletion } from '../backup/backup-account-deletion.adapter';
import { discoverDevicesDeletion } from '../devices/devices-account-deletion.adapter';
import { discoverGuestDeletion } from '../guest-trial/guest-account-deletion.adapter';
import { discoverLegacyAuthDeletion } from '../identity/legacy-auth-account-deletion.adapter';
import { discoverLegacySmmDeletion } from '../misc/legacy-smm-account-deletion.adapter';
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
  // Phase 2: исходники загрузок чата (chat_uploads). Одна purge-задача на
  // аккаунт, ключи читаются из таблицы при исполнении; правил зависимостей
  // не нужно (нет stop-фазы и общего состояния, как у chat-file.purge).
  discoverChatUploads,
  discoverImageDeletion,
  // Видео-бакет (MINIO_BUCKET_VIDEOS) — два места.
  // video-job.purge (по строке video_jobs): videos/<jobId>.mp4|jpg и из
  // колонок строки только ключи белого списка (K4b: свои
  // video-uploads/<userId>/…; чужое — пропуск с журналом skipped);
  // локальные public/videos/<jobId>.* и _veoconcat/<jobId> — только из id
  // строки.
  // video-upload.purge (K4): весь каталог личных загрузок
  // video-uploads/<userId>/ (листинг с пагинацией) — фото без строки (не
  // дошли до задачи, стёрты cleanupOldFailedJobs, 2-е/3-е референс-фото Veo
  // в composed_plan). Одна задача на аккаунт; правило зависимостей не
  // нужно — с video-job.purge пересекается только подтверждённым
  // отсутствием объекта.
  discoverVideoDeletion,
  discoverVideoUploadsDeletion,
  discoverSpeechDeletion,
  discoverAvatarDeletion,
  discoverVoiceAvatarDeletion,
  discoverEventsDeletion,
  discoverTasksDeletion,
  discoverSupportDeletion,
  discoverPeerDeletion,
  discoverContactsDeletion,
  discoverReferralDeletion,
  discoverRetentionDeletion,
  // Task 17D: backups, devices, guest-проба и legacy auth. Правил
  // DELETION_DEPENDENCIES не нужно: stop-задачи (guest-carry.stop,
  // auth-verification.stop) стирают Redis-ключи immediate-фазой, а purge
  // выполняется после retention и не разделяет с ними состояние.
  discoverBackupDeletion,
  discoverDevicesDeletion,
  discoverGuestDeletion,
  discoverLegacyAuthDeletion,
  // Task 17E: legacy SMM — чистый SQL (доменных сервисов нет), stop+purge
  // на каждую собственную не-official кампанию.
  discoverLegacySmmDeletion,
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
  // K6: обезличивание текста заявок — после того, как stop отменил висящие
  // заявки поколения: purge не оставляет живому партнёру pending-заявку
  // удалённого (без текста, но одобряемую). resourceKey статический
  // ('contacts') — форма как у peer.
  'contacts.purge': { allOf: ['contacts.stop'] },
  // Task 17C: обезличивание referral-журналов — только после деактивации
  // лидера. stop блокирует requestWithdrawal (strict-гейт is_active), поэтому
  // между pending-проверкой purge и алиасингом не может появиться новая
  // заявка на вывод. resourceKey статический ('referral') — форма как у
  // tasks/support/peer.
  'referral.purge': { allOf: ['referral.stop'] },
  // Task 17E: purge ждёт stop ТОГО ЖЕ resourceKey. Две формы ключа:
  // campaignId (контент кампании стирается после её stop; кампаний
  // несколько — purge одной не ждёт stop остальных) и статический
  // 'legacy-smm' (user-scoped alias billing ждёт user-scoped отзыва
  // credentials/oauth). Поэтому форма sameResourceKey (как
  // product.purge/voice.purge), а не allOf — она покрывает обе формы.
  'legacy-smm.purge': { sameResourceKey: ['legacy-smm.stop'] },
};
