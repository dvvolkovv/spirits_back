/**
 * Что умеет клиент чата — сообщает он сам полем `ui` запроса.
 *
 * Веб шлёт `{ activity: true, ask: true }`: рисует шаги работы ассистента и
 * карточки уточняющих вопросов. Мобилка и старые сборки поле не шлют — им не
 * уходят ни события шагов, ни правило про карточки в промпте.
 *
 * Признаём только строгое `true`. Поле приходит и объектом (обычный ход), и
 * строкой с JSON (upload-and-chat — multipart, там всё строки). Мусор равен
 * отсутствию поля: ошибиться в сторону «клиент не умеет» дешевле, чем
 * прислать мобилке событие, которое она вклеит в ответ.
 */
export interface ClientUi {
  activity: boolean;
  ask: boolean;
}

export const NO_CLIENT_UI: ClientUi = { activity: false, ask: false };

export function parseClientUi(raw: unknown): ClientUi {
  let v: unknown = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return { ...NO_CLIENT_UI };
    }
  }
  if (!v || typeof v !== 'object') return { ...NO_CLIENT_UI };
  const o = v as Record<string, unknown>;
  return { activity: o.activity === true, ask: o.ask === true };
}
