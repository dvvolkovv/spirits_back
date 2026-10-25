import { clientKind, isStoreBuild } from './client-kind';
import { NO_CLIENT_UI } from './client-ui';

describe('isStoreBuild', () => {
  it.each(['appstore', 'play', 'PLAY', 'AppStore'])('%s — сборка из стора', (v) => {
    expect(isStoreBuild(v)).toBe(true);
  });

  // Неизвестное или пустое — НЕ магазин: так ведут себя веб и старые сборки,
  // где оплата разрешена. Ошибиться в эту сторону дешевле, чем выключить пополнение всему вебу.
  it.each([undefined, null, '', 'apk', 'web', 42])('%s — не стор', (v) => {
    expect(isStoreBuild(v)).toBe(false);
  });

  it('повторённый заголовок (массив) — по первому значению', () => {
    expect(isStoreBuild(['appstore', 'web'])).toBe(true);
  });
});

describe('clientKind', () => {
  it('стор важнее всего', () => {
    expect(clientKind(true, { activity: true, ask: true })).toBe('store');
  });

  it('веб шлёт ui — web', () => {
    expect(clientKind(false, { activity: true, ask: false })).toBe('web');
    expect(clientKind(false, { activity: false, ask: true })).toBe('web');
  });

  it('без ui — мобильное приложение', () => {
    expect(clientKind(false, NO_CLIENT_UI)).toBe('app');
  });
});
