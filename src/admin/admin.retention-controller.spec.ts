import { AdminController } from './admin.controller';

function fakeRes() {
  const r: any = { statusCode: 0, body: undefined };
  r.status = (code: number) => { r.statusCode = code; return r; };
  r.json = (body: any) => { r.body = body; return r; };
  return r;
}

describe('AdminController retention delegation', () => {
  const retention = {
    buildRetentionOutreach: jest.fn().mockResolvedValue({ count: 0 }),
    sendRetentionOutreach: jest.fn().mockResolvedValue({ sent: 0 }),
    buildCuriousReturnOutreach: jest.fn().mockResolvedValue({ count: 0 }),
    sendCuriousReturnOutreach: jest.fn().mockResolvedValue({ sent: 0 }),
  };
  let ctrl: AdminController;

  beforeEach(() => {
    jest.clearAllMocks();
    ctrl = new AdminController({} as any, {} as any, retention as any);
  });

  it.each([
    ['preview', 'buildRetentionOutreach'],
    ['send', 'sendRetentionOutreach'],
    ['curious_preview', 'buildCuriousReturnOutreach'],
    ['curious_send', 'sendCuriousReturnOutreach'],
  ])('%s делегирует в RetentionService', async (action, method) => {
    const res = fakeRes();
    await ctrl.retentionAction({ action, minDays: 2 }, res);
    expect((retention as any)[method]).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('ошибку сервиса возвращает как HTTP 400', async () => {
    retention.sendRetentionOutreach.mockResolvedValueOnce({ error: 'confirm_required' });
    const res = fakeRes();
    await ctrl.retentionAction({ action: 'send' }, res);
    expect(res.statusCode).toBe(400);
  });
});
