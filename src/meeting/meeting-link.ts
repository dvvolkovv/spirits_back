import { createHash } from 'crypto';
import { isValidRoomCode } from './room-code';

/**
 * Ссылка на комнату Linkeon в тексте сообщения.
 *
 * Точка перед `linkeon.io` внутри необязательной группы обязательна: без неё
 * сюда попал бы `notlinkeon.io` — регулярка нашла бы `linkeon.io` внутри
 * чужого домена и увела бы пользователя на чужую встречу.
 *
 * Поддомен необязателен: комнаты живут на `my.` и `test.`, а лендинг — на
 * голом `linkeon.io`.
 */
const ROOM_LINK_REGEX = /https?:\/\/(?:[a-z0-9-]+\.)?linkeon\.io\/room\/([A-Za-z0-9]+)/i;

/**
 * Ссылка на голосовую комнату Taler ID.
 *
 * Точка перед доменом обязательна по той же причине, что и у Linkeon: без неё
 * `notapi.talerid.io` прошёл бы проверку. Поддомен необязателен — их страница
 * отдаётся и с edge-доменов, а абсолютные ссылки на `api.talerid.io` у
 * пользователей из СНГ режет DPI.
 *
 * Код у них — hex-строка (`36fc367a`), а не наш алфавит без похожих букв,
 * поэтому валидация отдельная.
 */
const TALERID_LINK_REGEX = /https?:\/\/(?:[a-z0-9-]+\.)?talerid\.io\/room\/([A-Fa-f0-9]{6,64})/i;

/**
 * Ссылка на комнату Taler ID на ТОМ хосте, который настроен у нас.
 *
 * Зачем вторая проверка. Клиент комнат ходит по адресу из `TALERID_BASE_URL`:
 * на проде это `api.talerid.io`, на стенде — их стейдж `staging.id.taler.tirol`.
 * Разбор ссылки при этом знал только канонический `talerid.io`, и на стенде
 * встреча Taler ID была недостижима в принципе: ссылку не узнавали, карточку
 * не показывали, а сообщение уходило в модель — 14.09.2026 она на такую
 * ссылку ответила, что «подключилась к комнате и ведёт запись», чего не было.
 *
 * Хост сверяем ТОЧНО, без поддоменов: канонический `talerid.io` уже разобран
 * регуляркой выше вместе со своими поддоменами, а настроенный адрес — это
 * ровно один известный хост, и расширять его до «всё, что кончается на
 * taler.tirol» значило бы открыть дверь `notstaging.id.taler.tirol`.
 */
function taleridLinkOnConfiguredHost(text: string): RegExpExecArray | null {
  const base = process.env.TALERID_BASE_URL;
  if (!base) return null;
  let host: string;
  try {
    host = new URL(base).host.toLowerCase();
  } catch {
    return null;
  }
  // Канонический хост уже проверен выше — второй раз незачем.
  if (host === 'talerid.io' || host.endsWith('.talerid.io')) return null;
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`https?://${escaped}/room/([A-Fa-f0-9]{6,64})`, 'i').exec(text);
}

/**
 * Ссылка на встречу Google Meet.
 *
 * Хост точный, БЕЗ необязательного поддомена — в отличие от linkeon.io и
 * talerid.io. У Meet поддоменов не бывает, а группа `(?:[a-z0-9-]+\.)?`
 * пропустила бы `notmeet.google.com`. Хвост домена закрыт границей `\/`
 * сразу после `com`, иначе прошёл бы `meet.google.com.evil.ru`.
 *
 * Код — три-четыре-три буквы (`abc-defg-hij`). Канонический код у Meet всегда
 * строчный, но в сообщении он может прийти в любом регистре (письмо,
 * скопированное ВЕРСАЛОМ) — отсюда `/i` на всё выражение, а не голый
 * `[a-z]`. Цифр в коде не бывает, поэтому алфавит узкий: так `/lookup/` и
 * прочие пути Meet сюда не попадают.
 * Начало кода прижато к `\/`, конец — отрицательным просмотром, иначе из
 * `abcd-efgh-ijkl` регулярка выкусила бы середину.
 */
const MEET_LINK_REGEX = /https?:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?![a-z0-9-])/i;

/**
 * Ссылка на встречу Zoom.
 *
 * Хост с НЕОБЯЗАТЕЛЬНЫМ поддоменом, в отличие от Meet: у Zoom их не просто
 * много, они обязательны на практике — личные встречи живут на `us04web`,
 * `us05web`, корпоративные на `<компания>.zoom.us`. Точка перед `zoom.us`
 * внутри группы обязательна, иначе прошёл бы `notzoom.us`; хвост закрыт
 * `\/` сразу после `us`, иначе прошёл бы `zoom.us.evil.ru`.
 *
 * `j` — встреча, `w` — вебинар. Id числовой, 9–12 цифр.
 *
 * Личные ссылки вида `/my/<имя>` НЕ поддержаны сознательно: id в них нет, а
 * мост достаёт из пути первую числовую группу (`parse_zoom_join_url`) и на
 * такой ссылке получает `None`. Пусть лучше ссылка останется обычной ссылкой
 * в разговоре, чем ассистент пойдёт в никуда.
 */
const ZOOM_LINK_REGEX =
  /https?:\/\/((?:[a-z0-9-]+\.)?zoom\.us)\/(j|w)\/(\d{9,12})(\?[^\s<>"']*)?/i;

/**
 * Параметры ссылки Zoom, которые нужны для входа.
 *
 * `pwd` — хеш пароля встречи, без него бот не войдёт в защищённую встречу, а
 * защита включена почти всегда. `tk` — токен регистранта, нужен встречам с
 * регистрацией. Всё остальное (utm-метки, `#success`) отбрасываем: ссылка
 * уезжает в базу и в чужой сервис, и мусор в ней только мешает сверять.
 */
const ZOOM_KEEP_PARAMS = ['pwd', 'tk'];

/**
 * Ссылка на встречу Microsoft Teams, личная (Teams for home).
 *
 * `teams.live.com/meet/<id>` с необязательным `?p=<пароль>`. Id числовой и
 * длиннее зумовского — в замерах 13 цифр (`9334354666557`), поэтому диапазон
 * взят с запасом. Точка перед `live.com` внутри группы обязательна, иначе
 * прошёл бы `notteams.live.com`.
 */
const TEAMS_LIVE_LINK_REGEX =
  /https?:\/\/teams\.live\.com\/meet\/(\d{10,20})(\?[^\s<>"']*)?/i;

/**
 * Ссылка на встречу Teams, корпоративная.
 *
 * `teams.microsoft.com/l/meetup-join/19%3ameeting_…%40thread.v2/0?context=…`
 * — короткого опознавателя в ней нет вовсе: идентичность встречи несёт весь
 * адрес целиком, вместе с `context`, где лежат tenant и organizer. Поэтому
 * ссылку не разбираем на части и не нормализуем: любой выброшенный параметр
 * рискует стоить входа.
 *
 * Хост берём с необязательным поддоменом (`teams.microsoft.us` для
 * гособлака сюда не попадает сознательно — это другая площадка со своим
 * поведением, и проверить её нам не на чем).
 */
const TEAMS_JOIN_LINK_REGEX =
  /https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"']+/i;

/**
 * Ссылка на встречу Яндекс Телемоста.
 *
 * Хост точный, без поддоменов: у Телемоста их не бывает, а группа
 * `(?:[a-z0-9-]+\.)?` пропустила бы `nottelemost.yandex.ru`. Путь строго
 * `/j/<номер>` — прочие страницы Яндекса сюда не попадают.
 *
 * Номер длинный: в замерах 14 цифр (`90382708766203`), поэтому диапазон взят
 * с запасом. Параметры ссылки отбрасываем: мост всё равно нормализует адрес
 * до `https://telemost.yandex.ru/j/<номер>`, а тащить в базу метки перехода
 * незачем.
 */
const TELEMOST_LINK_REGEX = /https?:\/\/telemost\.yandex\.ru\/j\/(\d{6,20})/i;

/** Откуда встреча. Свои комнаты и чужие ведут себя одинаково, но входы разные. */
export type MeetingProvider = 'linkeon' | 'talerid' | 'meet' | 'zoom' | 'teams' | 'telemost';

export interface ParsedMeetingLink {
  provider: MeetingProvider;
  /**
   * Короткий опознаватель встречи — то, что человек узнаёт и что уезжает в
   * `voice_calls.external_room`: код своей комнаты, hex Taler ID, код Meet,
   * числовой id Zoom.
   */
  code: string;
  /**
   * Полный адрес входа — ТОЛЬКО там, где его нельзя собрать из кода.
   *
   * У своих комнат, Taler ID и Meet адрес однозначно выводится из кода. У
   * Zoom нет: в ссылке ещё хост аккаунта (`us04web.zoom.us`,
   * `<компания>.zoom.us`) и хеш пароля, и потерять их значит потерять вход.
   * Отсюда отдельное поле, а не «код, в котором иногда лежит ссылка»:
   * второе развалилось бы на первом же провайдере с похожей формой.
   */
  url?: string;
}

/** Нормализованный адрес входа Zoom: без мусорных параметров и без фрагмента. */
function zoomJoinUrl(host: string, kind: string, id: string, query?: string): string {
  const base = `https://${host.toLowerCase()}/${kind.toLowerCase()}/${id}`;
  if (!query) return base;
  const kept: string[] = [];
  for (const pair of query.slice(1).split('&')) {
    const name = pair.split('=')[0];
    // Регистр имени параметра Zoom не меняет, а вот значение `pwd`
    // регистрозависимо — его не трогаем вовсе.
    if (ZOOM_KEEP_PARAMS.includes(name.toLowerCase()) && pair.includes('=')) kept.push(pair);
  }
  return kept.length ? `${base}?${kept.join('&')}` : base;
}

/**
 * Опознаватель корпоративной встречи Teams — отпечаток адреса входа.
 *
 * Не для секретности, а ради формы: код уезжает в `external_room`, в карточку
 * и в логи, и класть туда адрес с tenant, organizer и вложенным JSON нельзя.
 * Шестнадцать знаков — столько же, сколько у кода Taler ID, и фронт такой
 * формат уже разбирает.
 */
function teamsCode(url: string): string {
  return createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Первая распознанная ссылка на встречу в тексте, или null.
 *
 * «Первая» здесь — это порядок проверки провайдеров (linkeon → talerid →
 * meet → teams → zoom), а не позиция ссылки в тексте: при нескольких ссылках разных площадок
 * в одном сообщении побеждает не та, что стоит раньше по тексту, а та, чей
 * провайдер проверяется раньше. Выбор «побеждает первая по позиции» здесь
 * сознательно не сделан — это отдельное продуктовое решение, которого пока
 * не было. Внутри одного провайдера (`ROOM_LINK_REGEX`, без флага `g`) первой
 * идёт первая по тексту, потому что человек, приславший две свои ссылки,
 * почти наверняка имеет в виду ту, о которой говорит дальше.
 */
export function parseMeetingLink(text: string): ParsedMeetingLink | null {
  if (typeof text !== 'string' || !text) return null;

  const own = ROOM_LINK_REGEX.exec(text);
  if (own) {
    const code = own[1].toUpperCase();
    // Проверяем алфавитом: `/room/ABC01D` синтаксически похож на ссылку, но
    // такого кода мы не выдаём — идти с ним в базу незачем.
    //
    // При провале — НЕ return null, а проваливаемся к следующим провайдерам.
    // Иначе битая своя ссылка в сообщении глушит валидную чужую (Taler ID
    // или Meet), стоящую рядом: карточка встречи не показывалась бы вовсе,
    // хотя в тексте была рабочая ссылка на другую площадку.
    if (isValidRoomCode(code)) return { provider: 'linkeon', code };
  }

  const foreign = TALERID_LINK_REGEX.exec(text) || taleridLinkOnConfiguredHost(text);
  if (foreign) {
    // Регистр их кода не трогаем: он hex и приходит в ссылке как есть, а
    // ручка сверяет строку точно. Приведение к верхнему регистру, уместное
    // для нашего алфавита, здесь увело бы в 404.
    return { provider: 'talerid', code: foreign[1] };
  }

  const meet = MEET_LINK_REGEX.exec(text);
  if (meet) {
    // К нижнему регистру: код у Meet строчный, а из письма его вставляют
    // как попало. Он же уедет в external_room и в meeting_url для Attendee,
    // и расхождение регистра развело бы одну встречу на две записи.
    return { provider: 'meet', code: meet[1].toLowerCase() };
  }

  const teamsLive = TEAMS_LIVE_LINK_REGEX.exec(text);
  if (teamsLive) {
    const [full, id] = teamsLive;
    // Код — числовой id: его человек видит в приглашении. Пароль (`?p=`)
    // остаётся в url: без него в защищённую встречу не войти.
    return { provider: 'teams', code: id, url: full };
  }

  const teamsJoin = TEAMS_JOIN_LINK_REGEX.exec(text);
  if (teamsJoin) {
    const url = teamsJoin[0];
    // Короткого опознавателя у корпоративной ссылки нет, а `external_room`
    // и карточка его требуют. Берём отпечаток адреса: он стабилен (одна и та
    // же встреча даёт один код), влезает в шестнадцатеричный формат кода,
    // который фронт уже умеет, и не тащит в базу tenant с organizer.
    return { provider: 'teams', code: teamsCode(url), url };
  }

  const telemost = TELEMOST_LINK_REGEX.exec(text);
  if (telemost) {
    // Код — номер встречи: он же опознаватель для человека. Адрес собираем
    // сами в канонической форме, потому что мост приводит его к ней же.
    const id = telemost[1];
    return { provider: 'telemost', code: id, url: `https://telemost.yandex.ru/j/${id}` };
  }

  const zoom = ZOOM_LINK_REGEX.exec(text);
  if (zoom) {
    const [, host, kind, id, query] = zoom;
    // Код — только числовой id: он короткий, узнаваемый человеком («встреча
    // 766 3900 9495») и годится в опознаватель. Всё, что нужно для входа, —
    // в url.
    return { provider: 'zoom', code: id, url: zoomJoinUrl(host, kind, id, query) };
  }

  return null;
}

/**
 * Номер встречи Zoom из ссылки.
 *
 * Нужен для токена On-Behalf-Of: Zoom выдаёт его на конкретную встречу
 * (`meeting_id`), а у нас в базе лежит адрес входа целиком.
 */
export function zoomMeetingNumber(url: string): string | null {
  const m = ZOOM_LINK_REGEX.exec(String(url || ''));
  return m ? m[3] : null;
}
