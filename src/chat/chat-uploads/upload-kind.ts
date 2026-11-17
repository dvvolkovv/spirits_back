import { safeFileName } from '../chat-files/file-meta';
import { kindByMime } from '../chat-files/find-files';

/**
 * Вид загрузки пользователя: image | video | audio | document. Сначала
 * семейство mime (image/…, video/…, audio/…), без него — расширение имени.
 *
 * Один источник для панели «Медиа/Файлы» (ChatFilesService.listForSession),
 * блока загрузок ассистента (ChatUploadsService.assistantBlock) и find_files.
 * Логика — та же kindByMime, что уже решает вид исходника в find_files:
 * человек и ассистент обязаны называть файл одинаково.
 *
 * Имя — очищенное (safeFileName), как у name/ext в панели и в find_files:
 * иначе «фото.jpg  » или хвостовой RLO дали бы document при ext=jpg.
 * file-meta ни от чего не зависит — цикла импортов нет.
 */
export function uploadKind(r: { mime: string; originalName: string }): 'image' | 'video' | 'audio' | 'document' {
  return kindByMime(r?.mime, safeFileName(r?.originalName));
}
