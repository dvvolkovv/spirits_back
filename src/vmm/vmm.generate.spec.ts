import { VmmService } from './vmm.service';

/**
 * Потолок вызова модели у маркетолога. Проверка 01.11.2026 через общий
 * рубильник модели: на Qwen ответ пришёл за 359 с при прежних 360 с —
 * медленная модель срывала бы прогон на последних секундах.
 */
describe('VmmService.generate — потолок вызова модели', () => {
  it('ждёт модель до 600 с', async () => {
    const claude = { textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: '[]', costUsd: 0 })) };
    const pg = { query: jest.fn(async () => ({ rows: [{ id: 'run-1' }] })) };
    const svc = new VmmService(pg as any, claude as any, {} as any, {} as any, {} as any);
    jest.spyOn(svc as any, 'buildSnapshot').mockResolvedValue({});

    await svc.generate('u1', 'manual');

    expect(claude.textWithCost).toHaveBeenCalledTimes(1);
    expect(claude.textWithCost.mock.calls[0][1]).toMatchObject({ timeoutMs: 600_000 });
  });
});
