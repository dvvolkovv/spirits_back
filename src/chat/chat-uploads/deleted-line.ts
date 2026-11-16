import { DEFAULT_LANGUAGE, LanguageService } from '../../common/services/language.service';

/**
 * «Файл удалён» на каждом языке из SUPPORTED_LANGUAGES
 * (src/common/services/language.service.ts); сторож полноты —
 * deleted-line.spec.ts. Португальский — европейский, как весь pt в проекте.
 */
export const DELETED_FILE_TEXT: Record<string, string> = {
  ru: 'файл удалён',
  en: 'file deleted',
  es: 'archivo eliminado',
  de: 'Datei gelöscht',
  fr: 'fichier supprimé',
  zh: '文件已删除',
  pt: 'ficheiro eliminado',
};

/**
 * Строка истории вместо ссылки на удалённую пользователем загрузку:
 * `📎 [имя](/webhook/chat-uploads/<id>)` → `📎 имя — файл удалён`.
 * Имя — без markdown-экранирования: ссылки больше нет, а `\[` был бы виден
 * человеку. Язык — из профиля; тег схлопывается LanguageService.normalize
 * (pt-PT → pt), пустой или неизвестный — русский.
 */
export function deletedUploadLine(name: string, lang: string | null | undefined): string {
  const text = DELETED_FILE_TEXT[LanguageService.normalize(lang)] ?? DELETED_FILE_TEXT[DEFAULT_LANGUAGE];
  return `📎 ${name} — ${text}`;
}
