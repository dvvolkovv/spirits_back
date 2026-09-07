/**
 * Текстовый чат чужой комнаты Taler ID.
 *
 * Канал устроен несимметрично, и это не наш выбор: писать надо их REST-ручкой
 * `POST {base}/voice/rooms/{roomName}/chat`, а читать — из самой LiveKit-комнаты,
 * куда их сервер публикует каждое сообщение data-пакетом. GET-ручки чата у них
 * нет вовсе (`/chat` и `/messages` отвечают 404 «Cannot GET», проверено
 * 07.09.2026), поллить нечего и не надо.
 *
 * Модуль намеренно не знает ни про LiveKit, ни про сессию: на вход — байты
 * пакета, на выход — разобранное сообщение. Так его можно проверить без комнаты.
 */

/** Ручка чата отвечает мгновенно; висеть на ней дольше секунды нечего. */
const TIMEOUT_MS = 4_000;

export interface IncomingChat {
  text: string;
  /** Как отправитель подписан у них в комнате. */
  name: string;
  ts: number;
}

export class ExternalRoomChat {
  constructor(
    private readonly url: string,
    private readonly token: string,
    /** Наше имя в комнате — им же отсеиваем собственное эхо. */
    private readonly displayName: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Написать в чат. `false` — не ушло; исключений наружу не бывает. */
  async send(text: string): Promise<boolean> {
    const body = (text || '').trim();
    if (!body) return false;
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: body, name: this.displayName }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        // 401 «No token» и 403 «No access to this room» — их штатные отказы.
        // Модель получит status: rejected и скажет об этом словами; падение
        // тула вместо этого заставило бы её замолчать.
        console.error(`[чат] отправка отбита: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (e: any) {
      console.error(`[чат] отправка не ушла: ${e?.message}`);
      return false;
    }
  }

  /**
   * Разобрать data-пакет комнаты. `null` — это не чат либо это мы сами.
   *
   * Собственное эхо отбрасываем ПО ИМЕНИ, а не по `ts` из ответа на отправку:
   * пакет с эхом приходит раньше, чем резолвится промис `fetch` (снято живьём
   * 07.09.2026 — строка `DATA …` встала в логе выше строки `POST → 201`).
   * К моменту прихода эха никакого `ts` у нас ещё нет, а имя — есть, и сервер
   * возвращает его ровно таким, каким мы его послали.
   */
  parse(payload: Uint8Array): IncomingChat | null {
    let msg: any;
    try {
      msg = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return null;
    }
    if (msg?.type !== 'chat_message') return null;

    const name = String(msg.name ?? '').trim();
    if (this.isSelf(name)) return null;

    const text = String(msg.text ?? '').trim();
    if (!text) return null;

    return { text, name: name || 'участник', ts: Number(msg.ts) || 0 };
  }

  private isSelf(name: string): boolean {
    return name.toLowerCase() === this.displayName.trim().toLowerCase();
  }
}
