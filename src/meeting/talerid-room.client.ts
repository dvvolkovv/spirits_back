import { Injectable, Logger } from '@nestjs/common';

/**
 * Публичные ручки голосовых комнат Taler ID.
 *
 * Их комнаты построены на LiveKit, вход публичный и без авторизации: по коду
 * из ссылки отдают токен участника. Проверено живьём 02.09.2026 на комнате
 * `36fc367a` — токен приходит с `canPublish` и `canSubscribe`, а их
 * LiveKit-сервер этот токен принимает (`/livekit/rtc/validate` → 200).
 *
 * Мы у них зарегистрированный партнёр (`linkeon-partner`), но голосовых комнат
 * в наших скоупах нет — сюда ходим ровно как их собственная веб-страница.
 * Значит ручка может закрыться авторизацией или капчей в любой день, и узнаем
 * мы об этом от пользователя. Поэтому: короткий таймаут, 404 как обычный
 * результат, любая неожиданность — null и строка в лог, а не исключение
 * наружу.
 *
 * Исключение — чат комнаты (`chatUrl`): он требует participant-токен, тот
 * самый, что отдаёт `join`. Без него ручка отвечает 401.
 */

/** Комната у них может отвечать долго, но обработчик чата ждать не должен. */
const TIMEOUT_MS = 5_000;

export interface TalerIdRoomInfo {
  code: string;
  title: string;
  roomName: string;
  isActive: boolean;
  requiresPassword: boolean;
  creatorName: string;
  creatorAvatar?: string;
}

export interface TalerIdRoomToken {
  token: string;
  roomName: string;
  /** Адрес их LiveKit — собран из той же базы, что и API. */
  url: string;
}

@Injectable()
export class TalerIdRoomClient {
  private readonly logger = new Logger(TalerIdRoomClient.name);

  /**
   * База берётся из окружения, а не хардкодом.
   *
   * На проде это `https://api.talerid.io`, на стейдже — другой хост
   * (`staging.id.taler.tirol`). Прибить гвоздём боевой домен значит сломать
   * стенд и не заметить.
   */
  private base(): string {
    return (process.env.TALERID_BASE_URL || 'https://api.talerid.io').replace(/\/+$/, '');
  }

  /**
   * Адрес их LiveKit.
   *
   * Их же страница строит его как `wss://${location.hostname}/livekit/` —
   * повторяем ровно это, подставляя хост из базы API.
   */
  private livekitUrl(): string {
    const host = new URL(this.base()).host;
    return `wss://${host}/livekit/`;
  }

  /**
   * Путь БЕЗ префикса `/api` — единственный, который есть в обеих их средах.
   *
   * Раньше здесь стояло `/api/voice/rooms/public/...`. На проде работают оба
   * варианта, а на стенде маршрута с `/api` не существует вовсе: проверено
   * 07.09.2026 — `staging.id.taler.tirol/api/voice/rooms/public/36fc367a`
   * отвечает «Cannot GET», тогда как тот же путь без префикса отвечает
   * «Room not found», то есть маршрут есть и до него дошли.
   *
   * Разница не косметическая. Их 404 мы по своему же замыслу трактуем как
   * «такой комнаты нет» (см. ниже), поэтому со стендовой базой ЛЮБОЙ вход в
   * чужую встречу выглядел бы как несуществующая комната — без единой строки
   * в логе о настоящей причине.
   */
  private async call(path: string, init?: RequestInit): Promise<any | null> {
    const url = `${this.base()}/voice/rooms/public/${path}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal });
      // 404 — рабочий ответ, а не сбой: «в сообщении была ссылка на комнату,
      // которой нет». Отличать его от настоящей поломки обязательно, иначе
      // обычная ссылка в разговоре превращается в ошибку в ленте.
      if (res.status === 404) return null;
      if (!res.ok) {
        this.logger.warn(`talerid room ${path}: HTTP ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (e: any) {
      // Сюда попадает и таймаут (AbortError), и битый JSON, и падение сети.
      this.logger.warn(`talerid room ${path}: ${e?.name === 'AbortError' ? 'таймаут' : e?.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Что за комната. `null` — нет такой, либо их сервис недоступен. */
  async info(code: string): Promise<TalerIdRoomInfo | null> {
    const d = await this.call(encodeURIComponent(code));
    if (!d || typeof d.roomName !== 'string') return null;
    return {
      code: String(d.code ?? code),
      title: String(d.title ?? ''),
      roomName: d.roomName,
      // Флаги отдаём как есть: решение, пускать ли в защищённую паролем или
      // выключенную комнату, принимает вызывающий, а не клиент.
      isActive: d.isActive !== false,
      requiresPassword: d.requiresPassword === true,
      creatorName: String(d.creatorName ?? ''),
      creatorAvatar: typeof d.creatorAvatar === 'string' ? d.creatorAvatar : undefined,
    };
  }

  /**
   * Куда писать в чат комнаты.
   *
   * Ручка берёт roomName, а НЕ код из ссылки: `/voice/rooms/{roomName}/chat`,
   * и требует participant-токен — без него 401 (проверено 07.09.2026).
   *
   * База — из окружения, как и у всех остальных путей этого клиента.
   * `TALERID_BASE_URL` сейчас не выставлена ни на одном стенде, и работает
   * прод-дефолт; в `chat.service.ts` у той же переменной дефолт стендовый.
   * Пока это никому не мешает, но разъезжаться дальше не стоит.
   *
   * Сам метод только собирает адрес: писать будет воркер, у которого есть
   * participant-токен и подключение к комнате. Хранить токен на бэкенде ради
   * этого не нужно.
   */
  chatUrl(roomName: string): string {
    return `${this.base()}/voice/rooms/${encodeURIComponent(roomName)}/chat`;
  }

  /**
   * Токен участника.
   *
   * @param displayName как ассистент будет подписан в их списке участников.
   */
  async join(code: string, displayName: string): Promise<TalerIdRoomToken | null> {
    const d = await this.call(`${encodeURIComponent(code)}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: displayName }),
    });
    if (!d || typeof d.token !== 'string' || !d.token) return null;
    return { token: d.token, roomName: String(d.roomName ?? ''), url: this.livekitUrl() };
  }
}
