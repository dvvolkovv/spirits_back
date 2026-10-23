import * as fs from 'fs';
import * as path from 'path';
import { TokensController } from './tokens.controller';

function mockRes() {
  const res: any = {};
  res.status = jest.fn((c: number) => { res._status = c; return res; });
  res.json = jest.fn((b: any) => { res._body = b; return res; });
  return res;
}

describe('GET /webhook/tokens/spending', () => {
  it('отдаёт сводку текущего пользователя и передаёт пояс и число месяцев', async () => {
    const months = [{ month: '2026-10', total: 6193, categories: [{ key: 'replies', tokens: 6193, count: 12 }] }];
    const spending = { monthly: jest.fn(async () => months) };
    const res = mockRes();
    await new TokensController({} as any, spending as any).getSpending({ userId: 'u-1' }, 'Asia/Novosibirsk', '6', res);
    expect(spending.monthly).toHaveBeenCalledWith('u-1', 'Asia/Novosibirsk', '6');
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ months });
  });

  it('сбой сервиса — 500 без подробностей', async () => {
    const spending = { monthly: jest.fn(async () => { throw new Error('db down'); }) };
    const res = mockRes();
    await new TokensController({} as any, spending as any).getSpending({ userId: 'u-1' }, undefined as any, undefined as any, res);
    expect(res._status).toBe(500);
    expect(res._body).toEqual({ error: 'spending_failed' });
  });

  it('ручка закрыта входом', () => {
    const src = fs.readFileSync(path.join(__dirname, 'tokens.controller.ts'), 'utf8');
    expect(src).toMatch(/@Get\('tokens\/spending'\)\s*\n\s*@UseGuards\(JwtGuard\)/);
  });

  it('SpendingService зарегистрирован в модуле', () => {
    const mod = fs.readFileSync(path.join(__dirname, 'tokens.module.ts'), 'utf8');
    expect(mod).toMatch(/providers:\s*\[[^\]]*SpendingService/);
  });
});
