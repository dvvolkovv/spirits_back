/**
 * Разделитель между текстом до шага работы (инструмента) и текстом после него.
 *
 * Релей шлёт ответ кусками (delta), а шаг работы — отдельным событием `tool`,
 * без текста. Модель часто пишет «Сейчас посмотрю файл.» → шаг → «Готово: …»
 * без переноса между ними, и в ответе это склеивалось в «файл.Готово»
 * (бэклог edf8fe49, c3e49a84, 16.11.2026). Первый кусок текста после шага
 * получает разделитель — и в поток клиенту, и в историю, поэтому живой показ
 * и перечитанная история совпадают.
 *
 * '' — в начале ответа или если пустая строка на стыке уже есть;
 * '\n' — если на стыке уже стоит одиночный перенос; иначе '\n\n'.
 */
export function blockSeparator(prev: string, next: string): string {
  if (!prev || !prev.trim()) return '';
  if (/\n\s*\n\s*$/.test(prev) || /^\s*\n\s*\n/.test(next)) return '';
  const prevBreak = /\n[ \t]*$/.test(prev);
  const nextBreak = /^[ \t]*\n/.test(next);
  if (prevBreak && nextBreak) return '';
  if (prevBreak || nextBreak) return '\n';
  return '\n\n';
}

/**
 * Следит за шагами работы в потоке релея: tool() — был шаг, text() — кусок
 * текста, с разделителем, если он первый после шага. soFar — уже накопленный
 * текст ответа (у потребителей это chunks.join('')).
 */
export class BlockJoiner {
  private afterTool = false;

  constructor(private readonly soFar: () => string) {}

  tool(): void {
    this.afterTool = true;
  }

  text(next: string): string {
    if (!this.afterTool || !next) return next;
    this.afterTool = false;
    return blockSeparator(this.soFar(), next) + next;
  }
}
