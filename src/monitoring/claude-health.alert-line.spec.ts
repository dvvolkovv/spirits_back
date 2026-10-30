import { qwenFallbackAlertLine } from './claude-health.service';

describe('qwenFallbackAlertLine — строка про запасной Qwen в алерте «Claude CLI недоступен»', () => {
  it('ключа нет', () => {
    expect(qwenFallbackAlertLine({ enabled: false, ok: 0, failed: 0, windowMs: 900_000 })).toBe('Запасной Qwen: не настроен');
  });

  it('ключ есть — исходы за окно статистики', () => {
    expect(qwenFallbackAlertLine({ enabled: true, ok: 12, failed: 1, windowMs: 900_000 })).toBe('Запасной Qwen: ответов 12, ошибок 1 за 15 мин');
  });

  it('окно берётся из статистики, а не зашито в строку', () => {
    expect(qwenFallbackAlertLine({ enabled: true, ok: 0, failed: 3, windowMs: 600_000 })).toBe('Запасной Qwen: ответов 0, ошибок 3 за 10 мин');
  });
});
