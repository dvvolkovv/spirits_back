import { parseUserAgent, signatureOf } from './user-agent';

/**
 * Настоящие строки User-Agent, снятые с живых клиентов. Ожидаемый разбор
 * выписан рядом явно: правка регулярки «мимоходом» роняет тест, и менять
 * классификацию приходится осознанно.
 *
 * Точность библиотеки нам не нужна — нужны грубые корзины. Экзотика обязана
 * честно падать в unknown, а не получать выдуманную классификацию.
 */
const CASES: Array<{
  название: string;
  ua: string;
  platform: string;
  os_name: string | null;
  browser_name: string | null;
}> = [
  {
    название: 'Chrome на Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    platform: 'desktop',
    os_name: 'Windows',
    browser_name: 'Chrome',
  },
  {
    название: 'Safari на macOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    platform: 'desktop',
    os_name: 'macOS',
    browser_name: 'Safari',
  },
  {
    название: 'Safari на iPhone',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    platform: 'mobile',
    os_name: 'iOS',
    browser_name: 'Safari',
  },
  {
    название: 'Chrome на Android',
    ua: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    platform: 'mobile',
    os_name: 'Android',
    browser_name: 'Chrome',
  },
  {
    название: 'iPad',
    ua: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    platform: 'tablet',
    os_name: 'iPadOS',
    browser_name: 'Safari',
  },
  {
    название: 'наша обёртка на Android — маркер wv',
    ua: 'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36',
    platform: 'app_webview',
    os_name: 'Android',
    browser_name: 'WebView',
  },
  {
    название: 'мобильное приложение на Flutter',
    ua: 'Dart/3.10 (dart:io)',
    platform: 'app_flutter',
    os_name: null,
    browser_name: null,
  },
  {
    название: 'Firefox на Linux',
    ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
    platform: 'desktop',
    os_name: 'Linux',
    browser_name: 'Firefox',
  },
  {
    название: 'Edge на Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    platform: 'desktop',
    os_name: 'Windows',
    browser_name: 'Edge',
  },
  {
    название: 'мусор',
    ua: 'зфыв123!!!',
    platform: 'unknown',
    os_name: null,
    browser_name: null,
  },
  {
    название: 'пустая строка',
    ua: '',
    platform: 'unknown',
    os_name: null,
    browser_name: null,
  },
];

describe('разбор User-Agent', () => {
  for (const c of CASES) {
    it(c.название, () => {
      const got = parseUserAgent(c.ua);
      expect(got.platform).toBe(c.platform);
      expect(got.osName).toBe(c.os_name);
      expect(got.browserName).toBe(c.browser_name);
    });
  }

  // Edge притворяется Chrome, а Chrome на Android — Safari. Проверка на то,
  // что порядок распознавания не переставили: иначе весь Edge уедет в Chrome.
  it('Edge не считается Chrome, а Chrome на Android — не Safari', () => {
    const edge = CASES.find((c) => c.название.startsWith('Edge'))!;
    expect(parseUserAgent(edge.ua).browserName).toBe('Edge');

    const android = CASES.find((c) => c.название.startsWith('Chrome на Android'))!;
    expect(parseUserAgent(android.ua).browserName).toBe('Chrome');
  });
});

describe('подпись устройства', () => {
  const chrome141 =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const chrome141minor =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.55 Safari/537.36';
  const chrome142 =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

  // Без этого у одного человека за год накопились бы десятки «устройств».
  it('минорное обновление браузера не создаёт новое устройство', () => {
    expect(signatureOf(parseUserAgent(chrome141minor))).toBe(signatureOf(parseUserAgent(chrome141)));
  });

  it('мажорное обновление создаёт новое устройство', () => {
    expect(signatureOf(parseUserAgent(chrome142))).not.toBe(signatureOf(parseUserAgent(chrome141)));
  });

  it('у неразобранного тоже есть подпись — такие клиенты не теряются', () => {
    expect(signatureOf(parseUserAgent('зфыв'))).toBeTruthy();
  });
});
