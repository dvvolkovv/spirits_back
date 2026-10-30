import { Logger } from '@nestjs/common';
import { ClaudeHealthService } from './claude-health.service';

/**
 * Проба живости локального Claude CLI (noFallback). CLI иногда отдаёт отказ
 * («You've hit your session limit · …») обычным ответом, без ошибки: такая
 * проба — не «Claude жив». Иначе при ключе люди молча сидят на Qwen, проба
 * зелёная, алерта нет (или приходит ложное «🟢 восстановлен»).
 */
describe('ClaudeHealthService — проба живости', () => {
  const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  const probeWith = async (reply: string) => {
    const claudeCli = { text: jest.fn().mockResolvedValue(reply), fallbackStats: jest.fn() };
    const svc = new ClaudeHealthService(pg as any, claudeCli as any);
    await (svc as any).probeLiveness();
    return { svc: svc as any, claudeCli };
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('ответ «ok» — Claude жив', async () => {
    const { svc, claudeCli } = await probeWith('ok');
    expect(svc.cache.llmStatus).toBe('ok');
    expect(svc.cache.llmOutageKind).toBeNull();
    expect(svc.cliConsecutiveDown).toBe(0);
    expect(claudeCli.text.mock.calls[0][1]).toMatchObject({ noFallback: true });
  });

  it('отказ CLI обычным ответом (лимит) — down, вид weekly_limit', async () => {
    const { svc } = await probeWith("You've hit your session limit · resets 3am");
    expect(svc.cache.llmStatus).toBe('down');
    expect(svc.cache.llmOutageKind).toBe('weekly_limit');
    expect(svc.cache.llmError).toMatch(/лимит/i);
    expect(svc.cliConsecutiveDown).toBe(1);
  });

  it('отказ CLI обычным ответом (вход) — down, вид auth', async () => {
    const { svc } = await probeWith('Not logged in · Please run /login');
    expect(svc.cache.llmStatus).toBe('down');
    expect(svc.cache.llmOutageKind).toBe('auth');
  });
});
