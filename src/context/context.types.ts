/**
 * Состав контекста для облачных поверхностей.
 *
 * До этого каждая поверхность лепила промпт сама, и составы разошлись: у
 * голосового звонка не было ни времени, ни календаря, ни задач — при том что
 * всё это лежит на сервере рядом. Отсюда исходная жалоба: на локскрине
 * нарисована встреча в 14:00, человек жмёт трубку, и Роман про неё не знает.
 *
 * Спека: cases/my.linkeon/spec-context-sovereignty.md, раздел 4.
 */

export type SectionName =
  | 'identity' | 'now' | 'today' | 'history'
  | 'cloud_profile' | 'business' | 'device' | 'balance';

export type ConsumerProfile = 'voice-launcher' | 'voice-web' | 'chat' | 'tg';

export interface SectionSpec {
  /** Чем больше, тем позже вытесняется при нехватке общего бюджета. */
  rank: number;
  /** Потолок самой секции в знаках. */
  budget: number;
}

export interface SectionStat {
  name: SectionName;
  chars: number;
  dropped: boolean;
}

export interface BuiltContext {
  text: string;
  sections: SectionStat[];
}

/**
 * Ранги читать так.
 *
 * `now` не вытесняется никогда: без времени ассистент врёт про «сегодня» и
 * «завтра», а стоит эта секция две сотни знаков. `today` идёт сразу за
 * идентичностью — это то, ради чего всё затевалось. `history` вытесняется
 * первой: разговор её восстановит, а пропущенную встречу — нет.
 *
 * `device` (выжимка с устройства, этап B) стоит ВЫШЕ `cloud_profile` — это
 * правило приоритета из спеки §2.3: при расхождении верить устройству, а Neo4j
 * считать тем, что человек сам рассказывал в облачных чатах.
 *
 * ⚠️ У `voice-web` секции `device` нет намеренно: у веба нет устройства, и
 * выжимка с чужого телефона туда попасть не может.
 */
export const PROFILES: Record<ConsumerProfile, Partial<Record<SectionName, SectionSpec>>> = {
  'voice-launcher': {
    now:           { rank: 100, budget: 250 },
    identity:      { rank: 90,  budget: 200 },
    today:         { rank: 80,  budget: 1200 },
    device:        { rank: 70,  budget: 1200 },
    cloud_profile: { rank: 60,  budget: 1200 },
    business:      { rank: 50,  budget: 800 },
    balance:       { rank: 40,  budget: 120 },
    history:       { rank: 30,  budget: 1800 },
  },
  'voice-web': {
    now:           { rank: 100, budget: 250 },
    identity:      { rank: 90,  budget: 200 },
    today:         { rank: 80,  budget: 1200 },
    cloud_profile: { rank: 60,  budget: 1200 },
    business:      { rank: 50,  budget: 800 },
    balance:       { rank: 40,  budget: 120 },
    history:       { rank: 30,  budget: 1800 },
  },
  // Чат и Telegram переезжают сюда после голоса — у них сборка сложная и живая.
  chat: {},
  tg: {},
};

/**
 * Общий потолок на весь контекст.
 *
 * Realtime платит за преамбулу в КАЖДОМ звонке, и она же растит задержку
 * первого ответа. Поэтому потолок общий, а не только посекционный.
 */
export const TOTAL_BUDGET = 6000;

/** Пояс по умолчанию, когда клиент свой не прислал. */
export const FALLBACK_TZ = 'Asia/Yekaterinburg';
