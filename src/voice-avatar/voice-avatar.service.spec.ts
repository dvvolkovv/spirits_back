import { VoiceAvatarService } from './voice-avatar.service';

/**
 * Имя клона голоса у ElevenLabs — без идентификатора пользователя (спека
 * 2026-11-02-pii-out-of-prompts-design.md, п. 1). Было `user_<id>`, у
 * телефонных пользователей — номер. Имя нигде не читается: клон связан с
 * пользователем через user_voice.elevenlabs_voice_id.
 */
function harness() {
  const pg = { query: jest.fn(async (_sql: string, _params?: any[]) => ({ rows: [], rowCount: 1 })) };
  const svc = new VoiceAvatarService(pg as any);
  jest.spyOn(svc, 'profile').mockResolvedValue({ gender: 'male' });
  const clone = jest.spyOn(svc, 'clone').mockResolvedValue('voice-1');
  const run = (userId: string) => (svc as any).profileAndClone(userId, Buffer.from('mp3'));
  return { pg, clone, run };
}

describe('VoiceAvatarService: имя клона у ElevenLabs', () => {
  it('имя нового клона — linkeon-<8 hex>, без идентификатора пользователя', async () => {
    const h = harness();

    await h.run('70000000000');

    const name = h.clone.mock.calls[0][1];
    expect(name).toMatch(/^linkeon-[0-9a-f]{8}$/);
    expect(name).not.toContain('70000000000');
  });

  it('имя случайное: у двух клонов одного пользователя — разные', async () => {
    const h = harness();

    await h.run('u-1');
    await h.run('u-1');

    expect(h.clone.mock.calls[0][1]).not.toBe(h.clone.mock.calls[1][1]);
  });

  it('связь с пользователем — voice_id в user_voice, а не имя голоса', async () => {
    const h = harness();

    await h.run('u-1');

    const update = h.pg.query.mock.calls.find(([sql]) => /UPDATE user_voice/.test(String(sql)));
    expect(update?.[1]).toEqual(['u-1', 'voice-1', JSON.stringify({ gender: 'male' })]);
  });
});
