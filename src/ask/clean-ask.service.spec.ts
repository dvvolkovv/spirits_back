import { CleanAskService } from './clean-ask.service';

/**
 * firstContact() — the engine of the first-contact момент-отклик (spec
 * 2026-08-27-first-contact-experience-design.md). We verify the composed prompt (persona +
 * first-contact rules + conversation) and the mode branching; the relay itself is mocked.
 */
describe('CleanAskService.firstContact', () => {
  const ROMAN = { name: 'Роман', system_prompt: 'Ты — Роман, тёплый личный помощник.' };

  function make(agent: any) {
    const agents = {
      getAgentByName: jest.fn().mockResolvedValue(agent),
      getAgentById: jest.fn().mockResolvedValue(agent),
    } as any;
    const svc = new CleanAskService(agents);
    const relay = jest.spyOn(svc as any, 'callRelay').mockResolvedValue('ОТВЕТ');
    return { svc, agents, relay };
  }

  it('question mode: persona + friendly-interest rules + one-question + carries conversation', async () => {
    const { svc, relay } = make(ROMAN);
    const out = await svc.firstContact(
      [{ from: 'roman', text: 'Привет, расскажи о себе' }, { from: 'user', text: 'Я устал от работы' }],
      false,
    );
    expect(out).toBe('ОТВЕТ');
    const msg = relay.mock.calls[0][0] as string;
    expect(msg).toContain('Роман'); // persona name
    expect(msg).toContain('Ты — Роман, тёплый личный помощник.'); // persona system_prompt
    expect(msg).toMatch(/доброжелат|дружелюб|интерес/i); // friendly, personal interest
    expect(msg).toMatch(/один вопрос|ОДИН/i); // one question at a time
    expect(msg).toContain('Я устал от работы'); // conversation carried
    expect(msg).not.toMatch(/отрази/i); // NOT the finish/reflection instruction
  });

  it('finish mode: reflection + ONE concrete offer + anti-fluff', async () => {
    const { svc, relay } = make(ROMAN);
    await svc.firstContact([{ from: 'user', text: 'Много работы и мало сна' }], true);
    const msg = relay.mock.calls[0][0] as string;
    expect(msg).toMatch(/отрази/i); // reflect what they said
    expect(msg).toMatch(/одну конкретную|давай я/i); // one concrete offer
    expect(msg).toMatch(/без общих|конкретн/i); // anti-fluff
    expect(msg).toContain('Много работы и мало сна');
  });

  it('no persona found → still composes + relays (neutral fallback)', async () => {
    const { svc, relay } = make(null);
    const out = await svc.firstContact([{ from: 'user', text: 'привет' }], false);
    expect(out).toBe('ОТВЕТ');
    expect(relay).toHaveBeenCalledTimes(1);
  });

  it('drops empty messages from the conversation', async () => {
    const { svc, relay } = make(ROMAN);
    await svc.firstContact([{ from: 'user', text: '  ' }, { from: 'user', text: 'реальный ответ' }], false);
    const msg = relay.mock.calls[0][0] as string;
    expect(msg).toContain('реальный ответ');
  });
});
