import { IMAGE_TOKENS_HD, IMAGE_TOKENS_STD } from '../misc/image-pricing';
import { computeOwnVoiceSurcharge, computeVeoConcatQuote, computeVeoQuote, needsVeoConcat } from '../video/video.dto';
import { LISTEN_MAX_CHARS, maxCharsFor, RATE_LIMIT_PER_MIN, tokenCostFor } from '../speech/speech.service';
import { LIMITS as PEER_LIMITS } from '../peer/peer.dto';
import { RENT_TOKENS } from '../products/rent.service';
import { DEFAULT_MAX_PRODUCTS } from '../products/limits.service';
import { DELETE_GRACE_DAYS } from '../products/product-actions.service';
import { MAX_ROUTINES_PER_USER } from '../routine-push/routine-store.service';
import { PACKAGES } from '../payments/packages';
import { PRIEM_PACKAGES } from '../payments/priem.service';
import { OFFER_BONUS_PCT, OFFER_MSG_THRESHOLD } from '../offer/offer-bonus';
import { WELCOME_BONUS } from '../identity/identity.service';
import {
  COMMISSION_TIERS,
  PAYOUT_MIN_RUB,
  PAYOUT_RATE_TOKENS_PER_RUB,
  REFEREE_BONUS_TOKENS,
  WITHDRAW_MIN_RUB,
} from '../referral/referral.service';
import { SMS_CODE_MAX_ATTEMPTS, SMS_CODE_TTL_SECONDS } from '../auth/sms-code';
import { SMS_LIMIT_DEFAULTS } from '../auth/sms-limits';
import { MAX_UPLOAD_TOTAL_BYTES } from '../chat/upload-limits';
import { LOW_BALANCE_THRESHOLD, WARN_COOLDOWN_MS } from '../tokens/consumption-rate';
import { MAGIC_LINK_TTL_SECONDS } from '../auth/email.service';

/**
 * Числа для статей справки. Каждое — импорт той константы, по которой идёт
 * списание или проверка, а не копия: поменяли цену в коде — справка назовёт
 * новую со следующего вызова. Сюда — только то, что статьи реально называют.
 *
 * Три исключения держит клиент, и константы бэка для них нет: длины роликов на
 * выбор, число файлов за раз и срок реферальной ссылки. Рядом с ними — где оригинал.
 */

/** «25 000» — пробел между тысячами, как в русском тексте статей. */
export const fmt = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Длины ролика в форме — зеркало VEO_LENGTHS фронта (components/video/VideoCreateForm.tsx). */
const VIDEO_UI_LENGTHS = [8, 12, 16, 24, 32, 48, 60];
/** Файлов за раз — зеркало MAX_ATTACHMENTS фронта (ChatInterface.tsx) и upload.array('files', 10) релея. */
const UPLOAD_MAX_FILES = 10;
/** Сколько дней помнится реферальная ссылка — зеркало REFERRAL_TTL_MS фронта (pages/OnboardingPage.tsx). */
const REFERRAL_LINK_DAYS = 7;

function videoTokens(sec: number, aspect: '9:16' | '16:9'): number {
  const q = needsVeoConcat(aspect, sec) ? computeVeoConcatQuote('veo-3.1-fast', sec) : computeVeoQuote('veo-3.1-fast', sec);
  return q.totalCost;
}

function commissionLine(): string {
  return [...COMMISSION_TIERS]
    .sort((a, b) => a.min - b.min)
    .map((t, i, all) => {
      const next = all[i + 1];
      if (!next) return `${t.pct}% — от ${t.min} оплативших друзей`;
      return i === 0 ? `${t.pct}% — пока оплативших друзей меньше ${next.min}` : `${t.pct}% — от ${t.min} до ${next.min - 1}`;
    })
    .join('; ');
}

export const V = {
  welcomeBonus: fmt(WELCOME_BONUS),
  imageStd: fmt(IMAGE_TOKENS_STD),
  imageHd: fmt(IMAGE_TOKENS_HD),
  videoLengths: VIDEO_UI_LENGTHS.join(', '),
  videoPriceLines: VIDEO_UI_LENGTHS.map(
    (s) => `- ${s} с: вертикальный ${fmt(videoTokens(s, '9:16'))}, горизонтальный ${fmt(videoTokens(s, '16:9'))}`,
  ).join('\n'),
  ownVoiceMin: fmt(computeOwnVoiceSurcharge(Math.min(...VIDEO_UI_LENGTHS))),
  ownVoiceMax: fmt(computeOwnVoiceSurcharge(Math.max(...VIDEO_UI_LENGTHS))),
  speechPer1000: fmt(tokenCostFor(1000)),
  listenMaxChars: fmt(LISTEN_MAX_CHARS),
  speechChunkRu: fmt(maxCharsFor('yandex')),
  speechChunkOther: fmt(maxCharsFor('openai')),
  speechPerMinute: String(RATE_LIMIT_PER_MIN),
  uploadMaxFiles: String(UPLOAD_MAX_FILES),
  uploadMaxMb: String(Math.round(MAX_UPLOAD_TOTAL_BYTES / (1024 * 1024))),
  introMax: fmt(PEER_LIMITS.INTRO_MAX),
  peerMessageMax: fmt(PEER_LIMITS.MESSAGE_MAX),
  pendingMax: String(PEER_LIMITS.MAX_PENDING_OUTGOING),
  requestsPerHour: String(Math.round((PEER_LIMITS.RATE_MAX_PER_WINDOW * 3600) / PEER_LIMITS.RATE_WINDOW_SEC)),
  rentTokens: fmt(RENT_TOKENS),
  maxProducts: String(DEFAULT_MAX_PRODUCTS),
  deleteGraceDays: String(DELETE_GRACE_DAYS),
  maxRoutines: String(MAX_ROUTINES_PER_USER),
  lowBalance: fmt(LOW_BALANCE_THRESHOLD),
  lowBalanceEveryHours: String(Math.round(WARN_COOLDOWN_MS / 3_600_000)),
  rubPackages: PACKAGES.map((p) => `  - ${fmt(p.tokens)} токенов — ${fmt(p.priceRub)} ₽`).join('\n'),
  usdPackages: PRIEM_PACKAGES.map((p) => `  - ${fmt(p.tokens)} токенов — $${p.usd}`).join('\n'),
  offerPct: String(OFFER_BONUS_PCT),
  offerMessages: String(OFFER_MSG_THRESHOLD),
  refereeBonus: fmt(REFEREE_BONUS_TOKENS),
  refLinkDays: String(REFERRAL_LINK_DAYS),
  commissionTiers: commissionLine(),
  payoutRate: fmt(PAYOUT_RATE_TOKENS_PER_RUB),
  payoutMinRub: fmt(PAYOUT_MIN_RUB),
  withdrawMinRub: fmt(WITHDRAW_MIN_RUB),
  smsCodeMinutes: String(Math.round(SMS_CODE_TTL_SECONDS / 60)),
  smsAttempts: String(SMS_CODE_MAX_ATTEMPTS),
  smsPerHour: String(SMS_LIMIT_DEFAULTS.phonePerHour),
  smsPerDay: String(SMS_LIMIT_DEFAULTS.phonePerDay),
  magicLinkMinutes: String(Math.round(MAGIC_LINK_TTL_SECONDS / 60)),
};
