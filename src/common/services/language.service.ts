import { Injectable } from '@nestjs/common';
import { PgService } from './pg.service';

export const SUPPORTED_LANGUAGES = ['ru', 'en', 'es', 'de', 'fr', 'zh', 'pt'] as const;
export const DEFAULT_LANGUAGE = 'ru';

/** Названия для системного промпта — модель понимает их однозначнее кодов. */
export const LANGUAGE_NAMES: Record<string, string> = {
  ru: 'русском',
  en: 'English (английском)',
  es: 'Spanish / español (испанском)',
  de: 'German / Deutsch (немецком)',
  fr: 'French / français (французском)',
  zh: 'Simplified Chinese / 简体中文 (упрощённом китайском)',
  // Европейский португальский, а не бразильский: витрина в App Store
  // заведена как Portugal, и интерфейс переведён под неё. Модели это
  // важно — варианты расходятся заметно (utilizador против usuário).
  pt: 'European Portuguese / português de Portugal (европейском португальском)',
};

/// Требование ответа, написанное НА САМОМ языке ответа.
///
/// Нужно потому, что весь системный промпт — по-русски: описание платформы,
/// промпт ассистента, правила ответа. Тысячи русских слов и одна русская
/// строчка «отвечай по-английски» — модель идёт за массой и отвечает
/// по-русски. Особенно заметно у ассистентов с длинным промптом: у Романа
/// он на несколько тысяч знаков, и английский ответ не получался вовсе.
///
/// Строка на целевом языке ломает это: последнее, что видит модель перед
/// ответом, написано на том языке, на котором ответ и ждут.
export const LANGUAGE_REPLY_LINE: Record<string, string> = {
  ru: 'Отвечай по-русски.',
  en: 'Reply in English.',
  es: 'Responde en español.',
  de: 'Antworte auf Deutsch.',
  fr: 'Réponds en français.',
  pt: 'Responde em português de Portugal.',
  zh: '请用简体中文回复。',
};

@Injectable()
export class LanguageService {
  constructor(private readonly pg: PgService) {}

  /** Схлопывает произвольный тег языка до поддерживаемого корня. */
  static normalize(raw?: string | null): string {
    if (!raw) return DEFAULT_LANGUAGE;
    const root = String(raw).toLowerCase().split(/[-_]/)[0];
    return (SUPPORTED_LANGUAGES as readonly string[]).includes(root) ? root : DEFAULT_LANGUAGE;
  }

  /**
   * Языковая директива для системного промпта.
   * Схема — язык профиля как база, подстройка под язык реплики пользователя.
   */
  static buildDirective(lang: string): string {
    const name = LANGUAGE_NAMES[lang] || LANGUAGE_NAMES[DEFAULT_LANGUAGE];
    return (
      `\n--- ЯЗЫК ОБЩЕНИЯ ---\n` +
      `Язык интерфейса пользователя — ${name}. По умолчанию отвечай именно на нём, ` +
      `независимо от языка системных сообщений, tool-результатов, путей файлов и ` +
      `английских промптов в твоём контексте. ` +
      // Переписка названа отдельно не для полноты списка. Человек, сменивший
      // язык на аккаунте с длинной историей, продолжал получать ответы на
      // прежнем: директива перечисляла всё, кроме истории, и та перевешивала.
      // На пустом аккаунте тот же язык работал сразу — потому и выглядело
      // как «настройка не применилась».
      `ЯЗЫК ПРЕДЫДУЩЕЙ ПЕРЕПИСКИ НЕ ИМЕЕТ ЗНАЧЕНИЯ: если раньше разговор шёл ` +
      `на другом языке, всё равно переходи на ${name}. ` +
      // Про русский текст инструкций сказано прямо. Формулировка «независимо
      // от языка системных сообщений» оказалась слишком общей: весь промпт
      // выше — русский, и модель читала его как образец языка ответа.
      `ВСЕ ИНСТРУКЦИИ ВЫШЕ НАПИСАНЫ ПО-РУССКИ ПО ВНУТРЕННИМ ПРИЧИНАМ — это НЕ ` +
      `указание отвечать по-русски. ` +
      `Если пользователь написал последнее сообщение на другом языке — отвечай на ` +
      `языке его последнего сообщения.\n` +
      // Последняя строка — на целевом языке. См. LANGUAGE_REPLY_LINE.
      `${LANGUAGE_REPLY_LINE[lang] || LANGUAGE_REPLY_LINE[DEFAULT_LANGUAGE]}\n`
    );
  }

  /**
   * Язык из profile_data. Фолбэк — русский, в том числе при ошибке БД.
   *
   * requestHint — язык интерфейса, который фронт кладёт в тело чат-запроса.
   * Он используется ТОЛЬКО когда в профиле языка нет: профиль это явный выбор
   * пользователя, синхронный между вебом и мобильным приложением, и запрос его
   * не перебивает. Подсказка закрывает две дыры: гонку у новорега (AuthContext
   * пишет язык в профиль без await, первое сообщение успевает уйти раньше) и
   * профили, заведённые до мультиязычности — на 2026-08-09 таких на проде
   * 158 из 174.
   */
  async resolveUserLanguage(userId: string, requestHint?: string | null): Promise<string> {
    try {
      const res = await this.pg.query(
        `SELECT profile_data->>'language' AS language
           FROM ai_profiles_consolidated
          WHERE user_id = $1
          LIMIT 1`,
        [userId],
      );
      const stored = res.rows[0]?.language;
      if (stored) return LanguageService.normalize(stored);
      return LanguageService.normalize(requestHint);
    } catch {
      return DEFAULT_LANGUAGE;
    }
  }
}
