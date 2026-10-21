// Файлы хода, ответ которого не дошёл до бэкенда.
//
// Список файлов хода уезжает в событии `done`, а оно пишется, только пока
// бэкенд слушает. Если он отвалился раньше (рестарт API при выкате, обрыв
// связи), claude доделывает ход и кладёт файлы на диск, но ссылки на них не
// получает никто. Следующий ход их тоже не отдаёт: туда попадает лишь то, что
// создано или изменено в нём самом.
//
// 20.10.2026 так пропала справка с приложениями: рестарт API оборвал ход, на
// «что молчишь?» ассистент ответил «файл прикреплён ниже» — ссылки не было.
// Появилась она, только когда модель пересохранила файл.
//
// Поэтому файлы недоставленного хода откладываются по ключу сессии и уходят в
// `done` следующего её хода, который до бэкенда дойдёт. Хранится в памяти:
// выкат релея между оборванным ходом и следующим сообщением их забудет —
// тогда будет как до этой правки, не хуже. Доставка не чаще одного раза:
// подтверждения от бэкенда нет, и `done`, ушедший в уже умирающее соединение,
// файлы не вернёт.

export const UNDELIVERED_TTL_MS = 7 * 24 * 3600 * 1000;

export function createUndelivered({ ttlMs = UNDELIVERED_TTL_MS, now = Date.now } = {}) {
  /** sessionId → { at, files: Map<url, файл> } */
  const bySession = new Map();
  const sweep = () => {
    const t = now();
    for (const [sid, e] of bySession) if (t - e.at > ttlMs) bySession.delete(sid);
  };
  return {
    stash(sessionId, files) {
      if (!files.length) return;
      sweep();
      const e = bySession.get(sessionId) || { at: 0, files: new Map() };
      for (const f of files) e.files.set(f.url, f);
      e.at = now();
      bySession.set(sessionId, e);
    },
    take(sessionId) {
      const e = bySession.get(sessionId);
      bySession.delete(sessionId);
      if (!e || now() - e.at > ttlMs) return [];
      return [...e.files.values()];
    },
    size() {
      return bySession.size;
    },
  };
}

// Список для `done`: свои файлы хода плюс перенесённые, без повторов по адресу.
// Свой главнее — он свежее. Перенесённый файл берётся, только пока он на диске
// (statOf вернул не null), и с нынешним размером.
export function withCarried(own, carried, statOf) {
  if (!carried.length) return own;
  const seen = new Set(own.map((f) => f.url));
  const out = [...own];
  for (const f of carried) {
    if (seen.has(f.url)) continue;
    const st = statOf(f.url);
    if (!st) continue;
    seen.add(f.url);
    out.push({ name: f.name, size: st.size, url: f.url });
  }
  return out;
}
