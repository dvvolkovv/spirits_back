import { fallbackAlertLine } from './claude-health.service';

describe('fallbackAlertLine — строка про запасных в алерте «Claude CLI недоступен»', () => {
  const p = (enabled: boolean, ok = 0, failed = 0) => ({ enabled, ok, failed, downUntil: 0 });

  it('ключей нет', () => {
    expect(fallbackAlertLine({ windowMs: 900_000, providers: { qwen: p(false), kimi: p(false) } }))
      .toBe('Запасные за 15 мин: Qwen — не настроен; Kimi — не настроен');
  });

  it('оба настроены — исходы по каждому', () => {
    expect(fallbackAlertLine({ windowMs: 900_000, providers: { qwen: p(true, 12, 1), kimi: p(true, 3, 0) } }))
      .toBe('Запасные за 15 мин: Qwen — ответов 12, ошибок 1; Kimi — ответов 3, ошибок 0');
  });

  it('окно берётся из статистики, а не зашито в строку', () => {
    expect(fallbackAlertLine({ windowMs: 600_000, providers: { qwen: p(true, 0, 3), kimi: p(false) } }))
      .toBe('Запасные за 10 мин: Qwen — ответов 0, ошибок 3; Kimi — не настроен');
  });

  it('без разбивки по провайдерам — «не настроен», без падения', () => {
    expect(fallbackAlertLine({ windowMs: 900_000 })).toBe('Запасные за 15 мин: Qwen — не настроен; Kimi — не настроен');
  });
});
