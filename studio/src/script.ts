import type { CaptureResult, Script } from './types';

/**
 * То, что студия может проверить сама до озвучки: у каждой реплики ответа
 * есть абзац, и такой абзац снят. Правила текста (цифры, конкуренты,
 * «анонимно»…) проверяет бэкенд во втором плане.
 */
export function validateScript(script: Script, capture: Pick<CaptureResult, 'boxes'>): string[] {
  const problems: string[] = [];
  const hook = script.hook?.trim() ?? '';
  if (!hook) problems.push('нет зацепки');
  // Словом считаем токен с буквой или цифрой — тем же фильтром, что API (short-rules.ts):
  // тире и прочие знаки между репликами не слова.
  if (hook.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length > 8) problems.push('зацепка длиннее 8 слов');
  if (!script.voice?.trim()) problems.push('не задан голос');

  const ids = new Set<string>();
  const known = new Set(capture.boxes.map((b) => b.n));
  for (const l of script.lines) {
    if (ids.has(l.id)) problems.push(`повтор id реплики ${l.id}`);
    ids.add(l.id);
    if (!l.text?.trim()) problems.push(`реплика ${l.id} пустая`);
    if (l.scene === 'answer') {
      if (l.box == null) problems.push(`реплика ${l.id} не привязана к абзацу`);
      else if (!known.has(l.box)) problems.push(`реплика ${l.id} ссылается на абзац ${l.box}, а снято абзацев: ${capture.boxes.length}`);
    } else if (l.box != null) {
      problems.push(`реплика ${l.id} сцены ${l.scene} не должна ссылаться на абзац`);
    }
  }
  if (script.hookBox != null && !known.has(script.hookBox)) {
    problems.push(`зацепка опирается на абзац ${script.hookBox}, а снято абзацев: ${capture.boxes.length}`);
  }
  const count = script.final?.assistantsCount;
  if (!Number.isInteger(count) || count <= 0) problems.push('в финале нет числа ассистентов (final.assistantsCount)');
  const hookLine = script.lines.find((l) => l.scene === 'hook');
  if (hookLine && hookLine.text.trim() !== hook) problems.push('текст реплики hook должен совпадать с зацепкой');
  return problems;
}
