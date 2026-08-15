/**
 * Минимум замеров, ниже которого прогноз «хватит на N сообщений» недостоверен.
 *
 * Выдуманная цифра хуже её отсутствия: пользователь строит на ней решение,
 * а ассистент, назвавший «хватит на 20 сообщений» по двум замерам, ошибётся
 * в разы.
 */
export const MIN_SAMPLES = 5;

/**
 * Медиана расхода за ход. Медиана, а не среднее: у человека, который в
 * основном переписывается, одно сгенерированное видео за 10 000 токенов
 * перекосило бы среднее на порядок и превратило бы прогноз в бессмыслицу.
 *
 * Возвращает null, если замеров меньше MIN_SAMPLES.
 */
export function medianSpend(amounts: number[]): number | null {
  const values = (amounts || [])
    .map((a) => Number(a))
    .filter((a) => Number.isFinite(a) && a > 0)
    .sort((a, b) => a - b);

  if (values.length < MIN_SAMPLES) return null;

  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[mid]
    : (values[mid - 1] + values[mid]) / 2;
}
