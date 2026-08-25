import { BusinessProfileService } from './business-profile.service';

function make(opts: { claudeReply?: string; profile?: any } = {}) {
  const state: any = { business: opts.profile || {} };
  const pg = {
    query: jest.fn(async (sql: string, params: any[]) => {
      if (/SELECT/i.test(sql)) return { rows: [{ profile_data: { business: state.business } }] };
      state.business = JSON.parse(params[0]);
      return { rows: [], rowCount: 1 };
    }),
  } as any;
  const claudeCli = {
    text: jest.fn(async () => opts.claudeReply ?? '{"fields":{}}'),
  } as any;
  return { svc: new BusinessProfileService(pg, claudeCli), pg, claudeCli, state };
}

describe('extractFromTurn', () => {
  it('пишет извлечённые поля с source=assistant', async () => {
    const { svc, state } = make({ claudeReply: '{"fields":{"legal_form":"ip","tax_mode":"usn_d"}}' });

    await svc.extractFromTurn('u1', '10', 'у меня ИП на УСН доходы', 'Понял, тогда...');

    expect(state.business.legal_form.value).toBe('ip');
    expect(state.business.legal_form.source).toBe('assistant');
    expect(state.business.tax_mode.value).toBe('usn_d');
  });

  it('не зовёт LLM, когда префильтр срезал реплику', async () => {
    const { svc, claudeCli } = make();

    await svc.extractFromTurn('u1', '10', 'спасибо, всё понятно', 'Пожалуйста!');

    expect(claudeCli.text).not.toHaveBeenCalled();
  });

  it('переживает невалидный JSON от модели и ничего не пишет', async () => {
    const { svc, state } = make({ claudeReply: 'извините, не могу' });

    await svc.extractFromTurn('u1', '10', 'у меня ИП', 'Ага');

    expect(state.business).toEqual({});
  });

  it('переживает падение LLM-вызова и не бросает наружу', async () => {
    const { svc } = make();
    (svc as any).claudeCli.text = jest.fn(async () => { throw new Error('relay down'); });

    await expect(
      svc.extractFromTurn('u1', '10', 'у меня ИП', 'Ага'),
    ).resolves.toBeUndefined();
  });

  it('снимает markdown-обёртку вокруг JSON', async () => {
    const { svc, state } = make({ claudeReply: '```json\n{"fields":{"legal_form":"ooo"}}\n```' });

    await svc.extractFromTurn('u1', '10', 'мы ООО', 'Понял');

    expect(state.business.legal_form.value).toBe('ooo');
  });

  it('не трогает поле, выставленное пользователем', async () => {
    const { svc, state } = make({
      claudeReply: '{"fields":{"tax_mode":"osno"}}',
      profile: { tax_mode: { value: 'usn_d', source: 'user', updated_at: 'x' } },
    });

    await svc.extractFromTurn('u1', '10', 'у нас УСН вроде', 'Уточню');

    expect(state.business.tax_mode.value).toBe('usn_d');
  });
});
