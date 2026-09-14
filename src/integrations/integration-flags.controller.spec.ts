import { BadRequestException } from '@nestjs/common';
import { IntegrationFlagsController } from './integration-flags.controller';

describe('IntegrationFlagsController', () => {
  const make = () => {
    const flags = {
      list: jest.fn().mockResolvedValue([{ key: 'meeting:meet', title: 'Meet', note: '', enabled: false }]),
      set: jest.fn().mockResolvedValue([{ key: 'meeting:meet', title: 'Meet', note: '', enabled: true }]),
    };
    return { flags, ctl: new IntegrationFlagsController(flags as any) };
  };

  it('отдаёт снимок всех интеграций', async () => {
    const { ctl } = make();
    expect(await ctl.list()).toEqual({ integrations: [expect.objectContaining({ key: 'meeting:meet' })] });
  });

  it('переключает и возвращает полный список', async () => {
    // Админка рисует состояние всех переключателей: второй запрос за ним был
    // бы лишним.
    const { ctl, flags } = make();
    const r = await ctl.set({ userId: 'admin-3' }, { key: 'meeting:meet', enabled: true });
    expect(flags.set).toHaveBeenCalledWith('meeting:meet', true, 'admin-3');
    expect(r.integrations[0].enabled).toBe(true);
  });

  it('без enabled — 400, и ничего не пишется', async () => {
    // Отсутствующее поле в JSON привело бы к `undefined` в базе, то есть к
    // молчаливому выключению того, что переключали.
    const { ctl, flags } = make();
    await expect(ctl.set({}, { key: 'meeting:meet' })).rejects.toBeInstanceOf(BadRequestException);
    expect(flags.set).not.toHaveBeenCalled();
  });

  it('без ключа — 400', async () => {
    const { ctl, flags } = make();
    await expect(ctl.set({}, { enabled: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(flags.set).not.toHaveBeenCalled();
  });

  it('неизвестная интеграция — 400, а не 500', async () => {
    const { ctl, flags } = make();
    flags.set.mockRejectedValue(new Error('unknown integration: meeting:skype'));
    await expect(ctl.set({}, { key: 'meeting:skype', enabled: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('автор берётся из токена, а не из тела запроса', async () => {
    // Иначе в журнале переключений оказалось бы то, что прислал клиент.
    const { ctl, flags } = make();
    await ctl.set({ userId: 'admin-9' }, { key: 'meeting:meet', enabled: false, updatedBy: 'кто-то' } as any);
    expect(flags.set).toHaveBeenCalledWith('meeting:meet', false, 'admin-9');
  });
});
