import * as fs from 'fs';
import * as path from 'path';
import { ChatContextResetService } from './context-reset.service';

/**
 * Чтение точки «Чистого листа» для тех, кому сбой не повод отказывать: ход,
 * звонок, сборщик контекста, план, лента (spec 2026-11-17-context-reset,
 * «Риски»). Раньше каждый потребитель держал свою копию try/catch — и тексты
 * warn в них уже разошлись.
 *
 * Метод статический и принимает сервис первым: у потребителей он @Optional,
 * а спеки подменяют его объектом с одним `get` — экземплярный метод сломал бы
 * эти подмены.
 */
const RESET = new Date('2026-11-17T00:00:00Z');

function svcWith(query: jest.Mock) {
  return new ChatContextResetService({ query } as any);
}

describe('ChatContextResetService.getOrNull', () => {
  it('сервиса нет (@Optional у потребителя) — точки нет', async () => {
    expect(await ChatContextResetService.getOrNull(undefined, 'u1', '12')).toBeNull();
    expect(await ChatContextResetService.getOrNull(null, 'u1', '12')).toBeNull();
  });

  it('сервис есть и точка есть — точка', async () => {
    const query = jest.fn(async () => ({ rows: [{ reset_at: RESET.toISOString() }] }));

    const at = await ChatContextResetService.getOrNull(svcWith(query), 'u1', 12);

    expect(at).toBeInstanceOf(Date);
    expect(at!.getTime()).toBe(RESET.getTime());
    // Ассистент в базе — всегда текстом.
    expect(query).toHaveBeenCalledWith(expect.any(String), ['u1', '12']);
  });

  it('сервис есть, точки нет — null', async () => {
    const svc = svcWith(jest.fn(async () => ({ rows: [] })));
    expect(await ChatContextResetService.getOrNull(svc, 'u1', '12')).toBeNull();
  });

  it('подменённый объект с одним get (как в спеках потребителей) — работает', async () => {
    const get = jest.fn(async () => RESET);
    expect(await ChatContextResetService.getOrNull({ get } as any, 'u1', '7')).toBe(RESET);
    expect(get).toHaveBeenCalledWith('u1', '7');
  });

  it('сбой чтения — null и warn с парой и причиной', async () => {
    const svc = svcWith(jest.fn(async () => { throw new Error('db down'); }));
    const warn = jest.fn();

    expect(await ChatContextResetService.getOrNull(svc, 'u1', 12, warn)).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('u1_12');
    expect(line).toContain('db down');
  });

  it('сбой без warn-колбэка — null, не бросает', async () => {
    const svc = svcWith(jest.fn(async () => { throw new Error('db down'); }));
    await expect(ChatContextResetService.getOrNull(svc, 'u1', '12')).resolves.toBeNull();
  });
});

/**
 * Копии try/catch у потребителей заменены одним методом. Пин по исходникам:
 * новая копия — новый разошедшийся warn и новый шанс забыть fail-open.
 */
describe('потребители читают точку через getOrNull', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const consumers: Record<string, string> = {
    'chat.service.ts': '../chat.service.ts',
    'chat.controller.ts': '../chat.controller.ts',
    'action-plans.service.ts': '../action-plans/action-plans.service.ts',
    'context.service.ts': '../../context/context.service.ts',
    'voice-call.service.ts': '../../voice-call/voice-call.service.ts',
  };

  it.each(Object.keys(consumers))('%s: без своей копии contextResets.get', (name) => {
    const src = read(consumers[name]);
    expect(src).toContain('ChatContextResetService.getOrNull(');
    expect(src).not.toMatch(/contextResets\.get\(/);
  });
});
