import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { VOICE_CATALOG, isValidVoice } from '../speech/voices';
import { FORMATS, ShortFormat, ShortPlatform, YOUTUBE_MODES, YoutubeMode } from './shorts.types';

/** Голоса SpeechKit, допустимые для narratorVoice — для сообщения об ошибке (не имя файла каталога). */
const YANDEX_VOICE_IDS = VOICE_CATALOG.filter((v) => v.provider === 'yandex').map((v) => v.id);

export interface ShortSettings {
  /** ISO-дни: 1 — понедельник … 7 — воскресенье. */
  slotDays: number[];
  slotHourMsk: number;
  /** За сколько часов до свободного слота крон запускает под него ролик. */
  prepareLeadHours: number;
  /** Ответ короче — съёмка повторяется (спека, «Съёмка», шаг 5). */
  minAnswerChars: number;
  tgChannelChatId: string | null;
  platforms: ShortPlatform[];
  /** Голос Linkeon в финале. */
  narratorVoice: string;
  /** Формат новых роликов: «Сценки» или «Только чат» (запасной, если Omni недоступен). */
  format: ShortFormat;
  /** Предел секунд Omni на ролик со всеми пересъёмками (спека сценок, «Отказы»). */
  maxOmniSeconds: number;
  /** YouTube: manual — набор владельцу, unlisted («по ссылке») / public («публично») — загрузка с этим доступом (спека YouTube). */
  youtubeMode: YoutubeMode;
}

export const SETTINGS_DEFAULTS: ShortSettings = {
  slotDays: [2, 4, 6],
  slotHourMsk: 18,
  prepareLeadHours: 24,
  minAnswerChars: 400,
  tgChannelChatId: null,
  platforms: ['telegram', 'youtube'],
  narratorVoice: 'alena',
  format: 'skit',
  maxOmniSeconds: 48,
  youtubeMode: 'manual',
};

export type ShortSettingsPatch = Partial<ShortSettings>;

/** Площадки публикатора этого плана. VK подключается в плане 4. */
export const SUPPORTED_PLATFORMS: readonly ShortPlatform[] = ['telegram', 'youtube'];

const COLUMNS: Record<keyof ShortSettings, string> = {
  slotDays: 'slot_days',
  slotHourMsk: 'slot_hour_msk',
  prepareLeadHours: 'prepare_lead_hours',
  minAnswerChars: 'min_answer_chars',
  tgChannelChatId: 'tg_channel_chat_id',
  platforms: 'platforms',
  narratorVoice: 'narrator_voice',
  format: 'format',
  maxOmniSeconds: 'max_omni_seconds',
  youtubeMode: 'youtube_mode',
};

const intIn = (v: any, min: number, max: number): boolean => Number.isInteger(v) && v >= min && v <= max;

/**
 * Правка из админки. Незнакомое и кривое поле — ошибка с понятной причиной, а
 * не тихий пропуск: опечатка в имени поля иначе выглядела бы как «сохранено».
 *
 * currentYoutubeMode — режим YouTube сейчас: клиент, который шлёт настройки целиком
 * (так устроена вкладка блога), повторяет и его. Совпавший режим — не попытка его
 * сменить: поле в патч не попадает, без ошибки.
 */
export function validateSettingsPatch(body: any, currentYoutubeMode?: YoutubeMode): ShortSettingsPatch {
  const b = body ?? {};
  for (const k of Object.keys(b)) {
    if (!(k in COLUMNS)) throw new Error(`неизвестная настройка: ${k}`);
  }
  const p: ShortSettingsPatch = {};
  if (b.slotDays !== undefined) {
    const d = b.slotDays;
    if (!Array.isArray(d) || !d.length || d.some((x: any) => !intIn(x, 1, 7)) || new Set(d).size !== d.length) {
      throw new Error('slotDays — непустой список дней недели 1–7 без повторов (1 — понедельник)');
    }
    p.slotDays = [...d].sort((x: number, y: number) => x - y);
  }
  if (b.slotHourMsk !== undefined) {
    if (!intIn(b.slotHourMsk, 0, 23)) throw new Error('slotHourMsk — час 0–23 по Москве');
    p.slotHourMsk = b.slotHourMsk;
  }
  if (b.prepareLeadHours !== undefined) {
    if (!intIn(b.prepareLeadHours, 1, 96)) throw new Error('prepareLeadHours — 1–96 часов');
    p.prepareLeadHours = b.prepareLeadHours;
  }
  if (b.minAnswerChars !== undefined) {
    if (!intIn(b.minAnswerChars, 100, 5000)) throw new Error('minAnswerChars — 100–5000 знаков');
    p.minAnswerChars = b.minAnswerChars;
  }
  if (b.tgChannelChatId !== undefined) {
    const v = b.tgChannelChatId;
    if (v !== null && !(typeof v === 'string' && /^-100\d{6,}$/.test(v))) {
      throw new Error('tgChannelChatId — числовой id канала вида -100… или null');
    }
    p.tgChannelChatId = v;
  }
  if (b.platforms !== undefined) {
    const list = b.platforms;
    if (list?.includes?.('vk')) throw new Error('VK подключается отдельно и пока не готов — оставьте telegram и youtube');
    if (!Array.isArray(list) || !list.length || list.some((x: any) => !SUPPORTED_PLATFORMS.includes(x)) || new Set(list).size !== list.length) {
      throw new Error(`platforms — непустой список из ${SUPPORTED_PLATFORMS.join(', ')} без повторов`);
    }
    p.platforms = list;
  }
  if (b.narratorVoice !== undefined) {
    if (!isValidVoice(b.narratorVoice, 'yandex')) throw new Error(`Голос финала — один из голосов SpeechKit: ${YANDEX_VOICE_IDS.join(', ')}`);
    p.narratorVoice = b.narratorVoice;
  }
  if (b.format !== undefined) {
    if (!FORMATS.includes(b.format)) throw new Error('format — skit («Сценки») или chat («Только чат»)');
    p.format = b.format;
  }
  if (b.maxOmniSeconds !== undefined) {
    // Клип Omni — 8 с: предел меньше одного клипа сценки не снимет ни одной; CHECK базы — 8–400.
    if (!intIn(b.maxOmniSeconds, 8, 400)) throw new Error('maxOmniSeconds — 8–400 секунд Omni на ролик (клип — 8 с)');
    p.maxOmniSeconds = b.maxOmniSeconds;
  }
  if (b.youtubeMode !== undefined && b.youtubeMode !== currentYoutubeMode) {
    // Включает unlisted/public только владелец командой /youtube в боте (settings.update()
    // напрямую, мимо этой проверки) — здесь, через админку, доступен только аварийный откат на manual.
    // Неизменённый режим сюда не доходит (см. currentYoutubeMode выше).
    if (b.youtubeMode === 'unlisted' || b.youtubeMode === 'public') {
      throw new Error('youtubeMode: загрузку на YouTube включает только владелец командой /youtube в боте; через админку можно только manual');
    }
    if (b.youtubeMode !== 'manual') throw new Error('youtubeMode — только manual (набор); unlisted и public включает владелец командой /youtube');
    p.youtubeMode = b.youtubeMode;
  }
  return p;
}

@Injectable()
export class ShortsSettingsService {
  constructor(private readonly pg: PgService) {}

  async get(): Promise<ShortSettings> {
    // Все колонки: сорвавшийся накат 002 или 003 не должен ронять публикацию и одобрение —
    // без новых колонок их поля возьмутся по умолчанию.
    const r = await this.pg.query(`SELECT * FROM short_settings WHERE id = 1`);
    const row = r.rows[0];
    if (!row) return { ...SETTINGS_DEFAULTS };
    return {
      slotDays: Array.isArray(row.slot_days) && row.slot_days.length ? row.slot_days.map(Number) : SETTINGS_DEFAULTS.slotDays,
      slotHourMsk: Number(row.slot_hour_msk ?? SETTINGS_DEFAULTS.slotHourMsk),
      prepareLeadHours: Number(row.prepare_lead_hours ?? SETTINGS_DEFAULTS.prepareLeadHours),
      minAnswerChars: Number(row.min_answer_chars ?? SETTINGS_DEFAULTS.minAnswerChars),
      tgChannelChatId: row.tg_channel_chat_id ?? null,
      platforms: Array.isArray(row.platforms) && row.platforms.length ? row.platforms : SETTINGS_DEFAULTS.platforms,
      narratorVoice: row.narrator_voice || SETTINGS_DEFAULTS.narratorVoice,
      format: row.format === 'chat' ? 'chat' : SETTINGS_DEFAULTS.format,
      maxOmniSeconds: Number(row.max_omni_seconds ?? SETTINGS_DEFAULTS.maxOmniSeconds),
      youtubeMode: YOUTUBE_MODES.includes(row.youtube_mode) ? row.youtube_mode : SETTINGS_DEFAULTS.youtubeMode,
    };
  }

  async update(patch: ShortSettingsPatch): Promise<ShortSettings> {
    const sets: string[] = [];
    const args: any[] = [];
    for (const [key, column] of Object.entries(COLUMNS)) {
      const value = (patch as any)[key];
      if (value === undefined) continue;
      args.push(value);
      sets.push(`${column} = $${args.length}`);
    }
    if (sets.length) {
      await this.pg.query(`UPDATE short_settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`, args);
    }
    return this.get();
  }
}
