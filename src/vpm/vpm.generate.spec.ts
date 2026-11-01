import { VpmService } from './vpm.service';

/**
 * Потолок вызова модели у ВПМ. Проверка 01.11.2026 через общий рубильник
 * модели: на Qwen ответ пришёл за 253 с из прежних 360 с, у симметричного
 * маркетолога (vmm) на том же Qwen — за 359 с из 360.
 */
describe('VpmService.generate — потолок вызова модели', () => {
  it('ждёт модель до 600 с', async () => {
    const claude = { textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: '[]', costUsd: 0 })) };
    const pg = { query: jest.fn(async () => ({ rows: [{ id: 'run-1' }] })) };
    const svc = new VpmService(pg as any, claude as any, {} as any, {} as any);
    jest.spyOn(svc as any, 'buildSnapshot').mockResolvedValue({});

    await svc.generate('u1', 'manual');

    expect(claude.textWithCost).toHaveBeenCalledTimes(1);
    expect(claude.textWithCost.mock.calls[0][1]).toMatchObject({ timeoutMs: 600_000 });
  });
});
