// src/guest-trial/guest-trial.cron.spec.ts
import { GuestTrialCron } from './guest-trial.cron';

describe('уборка проб', () => {
  it('зовёт purge', async () => {
    const sessions = { purge: jest.fn(async () => 3) };
    await new GuestTrialCron(sessions as any).purge();
    expect(sessions.purge).toHaveBeenCalled();
  });
  it('сбой базы не роняет планировщик', async () => {
    const sessions = { purge: jest.fn(async () => { throw new Error('нет базы'); }) };
    await expect(new GuestTrialCron(sessions as any).purge()).resolves.toBeUndefined();
  });
});
