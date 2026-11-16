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
 *
 * Без регулярок: prev — весь накопленный ответ, и /\n\s*\n\s*$/ на длинной
 * серии пустых строк посреди него уходила в откат — 2000 переносов давали
 * 1,9 с, 5000 — 24 с синхронно, и event loop API стоял у всех. Здесь —
 * один проход по пробелам на стыке.
 */
export function blockSeparator(prev: string, next: string): string {
  const body = prev.trimEnd();
  if (!body) return '';
  const nl = countNewlines(prev.slice(body.length))
    + countNewlines(next.slice(0, next.length - next.trimStart().length));
  return nl >= 2 ? '' : nl === 1 ? '\n' : '\n\n';
}

function countNewlines(ws: string): number {
  let n = 0;
  for (const c of ws) if (c === '\n') n++;
  return n;
}

/**
 * Следит за шагами работы в потоке релея: tool() — был шаг, text() — кусок
 * текста, с разделителем, если он первый после шага. soFar — уже накопленный
 * текст ответа (у потребителей это chunks.join('')).
 *
 * Кусок из одних пробелов и переносов проходит как есть и шаг не «съедает»:
 * разделитель получает первый кусок с текстом и считается с учётом этих
 * пробелов — иначе «\n» после шага и «\nГотово» давали две пустые строки.
 */
export class BlockJoiner {
  private afterTool = false;

  constructor(private readonly soFar: () => string) {}

  tool(): void {
    this.afterTool = true;
  }

  text(next: string): string {
    if (!this.afterTool || !next?.trim()) return next;
    this.afterTool = false;
    return blockSeparator(this.soFar(), next) + next;
  }
}
