import { VpmService } from './vpm.service';
import { VmmService } from '../vmm/vmm.service';

/**
 * Номера аккаунтов — не нейросетям (спека 2026-11-02-pii-out-of-prompts-design.md,
 * п. 4). Тестовые аккаунты и аккаунт владельца исключаются из метрик фильтром в
 * SQL — он остаётся как есть, — а в заметке для модели они названы словами.
 *
 * Снимок собирается настоящим buildSnapshot: каждый раздел в нём под своим
 * try/catch, поэтому пустые заглушки базы и сервисов дают снимок без данных,
 * но с заметкой — ровно то, что здесь проверяется.
 */
const TEN_DIGITS = /\d{10,}/;

function promptOf(claude: { textWithCost: jest.Mock }): string {
  return String(claude.textWithCost.mock.calls[0][0]);
}

describe('ВПМ: номера аккаунтов в промпт не попадают', () => {
  const pg = () => ({ query: jest.fn(async () => ({ rows: [{ id: 'run-1' }] })) });

  it('baseline_note — без последовательностей из 10 и более цифр', async () => {
    const svc = new VpmService(pg() as any, {} as any, {} as any, {} as any);
    const snapshot = await (svc as any).buildSnapshot();

    expect(snapshot.baseline_note).not.toMatch(TEN_DIGITS);
  });

  it('тестовые аккаунты названы словами', async () => {
    const svc = new VpmService(pg() as any, {} as any, {} as any, {} as any);
    const snapshot = await (svc as any).buildSnapshot();

    expect(snapshot.baseline_note).toContain('тестовые и служебные аккаунты, включая аккаунт владельца');
  });

  it('во всём промпте модели — ни одной последовательности из 10 и более цифр', async () => {
    const claude = { textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: '[]', costUsd: 0 })) };
    const svc = new VpmService(pg() as any, claude as any, {} as any, {} as any);

    await svc.generate('u-1', 'manual');

    expect(promptOf(claude)).not.toMatch(TEN_DIGITS);
  });
});

// Сторож: у маркетолога номеров в промпте нет и сейчас (context_note говорит
// словами) — проверка держит это при будущих правках.
describe('ВММ: номера аккаунтов в промпт не попадают', () => {
  it('во всём промпте модели — ни одной последовательности из 10 и более цифр', async () => {
    const claude = { textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: '[]', costUsd: 0 })) };
    const pg = { query: jest.fn(async () => ({ rows: [{ id: 'run-1' }] })) };
    const svc = new VmmService(pg as any, claude as any, {} as any, {} as any, {} as any);

    await svc.generate('u-1', 'manual');

    expect(promptOf(claude)).not.toMatch(TEN_DIGITS);
  });
});
