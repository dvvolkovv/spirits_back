import { randomUUID } from 'node:crypto';

/**
 * Текстовый чат чужой комнаты Taler ID.
 *
 * Контракт описан у них в `docs/room-chat-api-for-integrators.md` (выкачен на
 * все три их окружения 08.09.2026). Отсюда три вещи, каждая из которых меняет
 * код:
 *
 * 1. Читать можно и по HTTP — `GET .../chat?since=<seq>`, — но НЕ вместо
 *    data-канала. Установленные старые мобильные сборки публикуют чат прямо в
 *    LiveKit, мимо их сервера, и в ленту такие сообщения не попадают вовсе.
 *    Поэтому живой поток мы слушаем из комнаты (`parse`), а `GET` зовём один
 *    раз при входе (`history`) — за тем, чего в потоке быть не может: за
 *    написанным ДО нашего прихода.
 * 2. У сообщения есть `clientMsgId`, который мы задаём сами и получаем обратно
 *    и в ленте, и в эхе. По нему и опознаём свои сообщения — см. `isOwn`.
 * 3. Потолки: 500 знаков на сообщение (иначе 400) и 10 сообщений за 10 секунд
 *    с отправителя (иначе 429).
 */

/** Ручка чата отвечает мгновенно (замер 07.09.2026 — сотни миллисекунд), но
 * `send` вызывается из тула, который OpenAI Realtime исполняет СИНХРОННО и
 * держит разговор, пока тот не вернётся. Четыре секунды — потолок паузы в
 * речи, а не ожидаемое время ответа: без него зависшая ручка молчала бы всю
 * встречу на undici-дефолте в 300 секунд.
 */
const TIMEOUT_MS = 4_000;

/** Их потолок длины. Режем сами: 400 в ответ модель понимает как «не смог». */
const MAX_TEXT = 500;

export interface IncomingChat {
  text: string;
  /** Как отправитель подписан у них в комнате. */
  name: string;
  ts: number;
  /** Номер в ленте встречи. Растёт сквозь встречи, не обнуляется. */
  seq?: number;
}

/**
 * Исход отправки.
 *
 * `rate_limited` отделён от `failed` не ради полноты: тул возвращает его
 * модели, и «слишком часто, подожди» — единственный случай, когда повтор
 * осмыслен. С общим отказом Роман просто извинится и продолжит разговор.
 */
export type SendResult = 'sent' | 'rate_limited' | 'failed';

export class ExternalRoomChat {
  /** Префикс наших clientMsgId. Случайный, чтобы не совпасть с чужим. */
  private readonly ownPrefix: string;
  private counter = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
    /** Наше имя в комнате — только подпись, на опознание своих не влияет. */
    private readonly displayName: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Только для тестов: делает clientMsgId предсказуемыми. */
    seed?: string,
  ) {
    this.ownPrefix = `lnk-${seed ?? randomUUID().slice(0, 8)}-`;
  }

  /** Написать в чат. Исключений наружу не бывает. */
  async send(text: string): Promise<SendResult> {
    const trimmed = (text || '').trim();
    if (!trimmed) return 'failed';
    // Обрезаем молча: отказ ради пятисот первого знака хуже, чем сообщение без
    // хвоста. Модель о потолке предупреждена в описании тула.
    const body =
      trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT - 1)}…` : trimmed;
    const clientMsgId = `${this.ownPrefix}${++this.counter}`;
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: body, name: this.displayName, clientMsgId }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429) {
        console.error('[чат] отправка отбита потолком частоты');
        return 'rate_limited';
      }
      if (!res.ok) {
        // 401 «No token» и 403 «No access to this room» — их штатные отказы.
        // Модель получит status: rejected и скажет об этом словами; падение
        // тула вместо этого заставило бы её замолчать.
        console.error(`[чат] отправка отбита: HTTP ${res.status}`);
        return 'failed';
      }
      return 'sent';
    } catch (e: any) {
      console.error(`[чат] отправка не ушла: ${e?.message}`);
      return 'failed';
    }
  }

  /**
   * Что написали в чате до нашего прихода.
   *
   * Зовётся один раз, при входе: дальше живой поток идёт из data-канала.
   * Без `since` — их ручка отдаёт ленту встречи целиком, это и есть «состояние
   * на момент подключения».
   */
  async history(): Promise<IncomingChat[]> {
    try {
      const res = await this.fetchImpl(this.url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error(`[чат] лента не прочитана: HTTP ${res.status}`);
        return [];
      }
      const d: any = await res.json();
      const rows: any[] = Array.isArray(d?.messages) ? d.messages : [];
      // `own` их сервер считает по токену, и для нас он верен: токен один на
      // всю встречу. Свой clientMsgId проверяем тоже — на случай, если лента
      // переживёт переподключение, после которого own у наших же сообщений
      // станет false (их документ прямо предупреждает об этом).
      return rows
        .filter((r) => r?.own !== true && !this.isOwn(r))
        .map((r) => this.toIncoming(r))
        .filter((m): m is IncomingChat => m !== null);
    } catch (e: any) {
      console.error(`[чат] лента не прочитана: ${e?.message}`);
      return [];
    }
  }

  /**
   * Разобрать data-пакет комнаты. `null` — это не чат либо это мы сами.
   *
   * Опознание своих — по `clientMsgId`, а не по имени, и это принципиально.
   * Эхо приходит РАНЬШЕ, чем резолвится промис отправки (снято живьём
   * 07.09.2026: строка `DATA …` встала в логе выше строки `POST → 201`), так
   * что сверяться с ответом на запрос нельзя. Раньше здесь сравнивалось имя
   * отправителя — работало, но молча глушило бы живого человека, назвавшегося
   * так же, как ассистент.
   */
  parse(payload: Uint8Array): IncomingChat | null {
    let msg: any;
    try {
      msg = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return null;
    }
    if (msg?.type !== 'chat_message') return null;
    if (this.isOwn(msg)) return null;
    return this.toIncoming(msg);
  }

  private isOwn(msg: any): boolean {
    return typeof msg?.clientMsgId === 'string' && msg.clientMsgId.startsWith(this.ownPrefix);
  }

  private toIncoming(msg: any): IncomingChat | null {
    const text = String(msg?.text ?? '').trim();
    if (!text) return null;
    const name = String(msg?.name ?? '').trim();
    const seq = Number(msg?.seq);
    return {
      text,
      name: name || 'участник',
      ts: Number(msg?.ts) || 0,
      ...(Number.isFinite(seq) && seq > 0 ? { seq } : {}),
    };
  }
}
