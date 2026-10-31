import { ClaudeHealthService } from './claude-health.service';

/**
 * aggregateUsage() суммирует claude_cli_call без фильтра по provider — при
 * рубильнике на Qwen/Kimi их ответы (CLI считает их по прайсу Opus) попадали
 * бы в «расход Claude» (spec 2026-10-31-global-llm-switch, риск «Обзор
 * расхода Claude»). Старые события без поля provider — тоже Claude
 * (coalesce(props->>'provider', 'claude')).
 */
describe('ClaudeHealthService — aggregateUsage считает только Claude', () => {
  it('оба подзапроса (суммы/счёт и топ моделей) фильтруют provider = claude', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [{}] }) };
    const claudeCli = { text: jest.fn(), fallbackStats: jest.fn() };
    const svc = new ClaudeHealthService(pg as any, claudeCli as any);

    await (svc as any).aggregateUsage();

    expect(pg.query).toHaveBeenCalledTimes(2);
    for (const call of (pg.query as jest.Mock).mock.calls) {
      expect(call[0]).toMatch(/coalesce\(props->>'provider', 'claude'\) = 'claude'/i);
    }
  });
});
