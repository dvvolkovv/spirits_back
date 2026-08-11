/**
 * Разбор User-Agent в грубые корзины.
 *
 * Своими руками, а не библиотекой. `ua-parser-js` во второй ветке сменила
 * лицензию на AGPL с платной альтернативой, первая ветка означает заморозку
 * на старой версии, а нужной нам точности от неё и не требуется: нужны
 * платформа, семейство ОС и семейство браузера с мажорной версией.
 *
 * Всё, что не распознано, честно уходит в `unknown` — доля таких видна в
 * сводке отдельной строкой. Классификатор, который относит непонятное в
 * «прочие», выглядит точным и молча врёт.
 *
 * Порядок проверок важен и переставлять его нельзя: Edge представляется как
 * Chrome, Chrome на Android — как Safari, а наша обёртка на Android — как
 * Chrome с маркером `wv`. Более частные случаи проверяются раньше общих.
 */

export type Platform =
  | 'desktop'
  | 'mobile'
  | 'tablet'
  | 'app_flutter'
  | 'app_webview'
  | 'unknown';

export interface ParsedUserAgent {
  platform: Platform;
  osName: string | null;
  osVersion: string | null;
  browserName: string | null;
  browserVersion: string | null;
}

const UNKNOWN: ParsedUserAgent = {
  platform: 'unknown',
  osName: null,
  osVersion: null,
  browserName: null,
  browserVersion: null,
};

/** Мажорная версия из строки вида «141.0.7390.55». */
function major(version: string | null): string | null {
  if (!version) return null;
  const m = /^(\d+)/.exec(version);
  return m ? m[1] : null;
}

function detectOs(ua: string): { name: string | null; version: string | null } {
  let m: RegExpExecArray | null;

  // iPad раньше iOS: на планшете строка содержит «iPad», а не «iPhone».
  if (/\biPad\b/.test(ua)) {
    m = /CPU OS (\d+[._]\d+)/.exec(ua);
    return { name: 'iPadOS', version: m ? m[1].replace('_', '.') : null };
  }
  if (/\b(iPhone|iPod)\b/.test(ua)) {
    m = /CPU iPhone OS (\d+[._]\d+)/.exec(ua);
    return { name: 'iOS', version: m ? m[1].replace('_', '.') : null };
  }
  // Android раньше Linux: строка Android содержит и «Linux».
  if (/\bAndroid\b/.test(ua)) {
    m = /Android (\d+(?:\.\d+)?)/.exec(ua);
    return { name: 'Android', version: m ? m[1] : null };
  }
  if (/\bWindows NT\b/.test(ua)) {
    m = /Windows NT (\d+\.\d+)/.exec(ua);
    return { name: 'Windows', version: m ? m[1] : null };
  }
  if (/\bMac OS X\b/.test(ua)) {
    m = /Mac OS X (\d+[._]\d+)/.exec(ua);
    return { name: 'macOS', version: m ? m[1].replace(/_/g, '.') : null };
  }
  if (/\bLinux\b|\bX11\b/.test(ua)) return { name: 'Linux', version: null };
  return { name: null, version: null };
}

function detectBrowser(ua: string): { name: string | null; version: string | null } {
  let m: RegExpExecArray | null;

  // Обёртка помечает себя «wv» — проверяем раньше Chrome, иначе уедет в него.
  if (/;\s*wv\)/.test(ua)) {
    m = /Chrome\/([\d.]+)/.exec(ua);
    return { name: 'WebView', version: m ? m[1] : null };
  }
  // Edge представляется Chrome и добавляет «Edg» — раньше Chrome.
  if ((m = /\bEdg(?:iOS|A)?\/([\d.]+)/.exec(ua))) return { name: 'Edge', version: m[1] };
  if ((m = /\bOPR\/([\d.]+)/.exec(ua))) return { name: 'Opera', version: m[1] };
  if ((m = /\bYaBrowser\/([\d.]+)/.exec(ua))) return { name: 'Yandex', version: m[1] };
  if ((m = /\bFirefox\/([\d.]+)/.exec(ua))) return { name: 'Firefox', version: m[1] };
  if ((m = /\bChrome\/([\d.]+)/.exec(ua))) return { name: 'Chrome', version: m[1] };
  // Safari последним: он упомянут почти во всех строках на WebKit.
  if (/\bSafari\//.test(ua)) {
    m = /Version\/([\d.]+)/.exec(ua);
    return { name: 'Safari', version: m ? m[1] : null };
  }
  return { name: null, version: null };
}

export function parseUserAgent(raw: string | undefined | null): ParsedUserAgent {
  const ua = (raw ?? '').trim();
  if (!ua) return UNKNOWN;

  // Flutter ходит через Dio и своего агента не ставит — присылает дефолтный
  // Dart. Это единственный клиент, который виден однозначно.
  if (/^Dart\//.test(ua)) {
    return { ...UNKNOWN, platform: 'app_flutter' };
  }

  const os = detectOs(ua);
  const browser = detectBrowser(ua);
  if (!os.name && !browser.name) return UNKNOWN;

  let platform: Platform;
  if (browser.name === 'WebView') platform = 'app_webview';
  else if (os.name === 'iPadOS' || /\bTablet\b/.test(ua)) platform = 'tablet';
  else if (os.name === 'iOS' || os.name === 'Android' || /\bMobile\b/.test(ua)) platform = 'mobile';
  else platform = 'desktop';

  return {
    platform,
    osName: os.name,
    osVersion: os.version,
    browserName: browser.name,
    browserVersion: browser.version,
  };
}

/**
 * Отпечаток устройства: платформа, ОС, браузер и МАЖОРНАЯ версия.
 *
 * Мажорная, а не полная: браузер обновляется каждые пару недель, и по полной
 * версии у одного человека за год накопились бы десятки «устройств».
 */
export function signatureOf(p: ParsedUserAgent): string {
  return [p.platform, p.osName ?? '-', p.browserName ?? '-', major(p.browserVersion) ?? '-'].join('|');
}
