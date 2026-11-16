import { VoiceAvatarService } from './voice-avatar.service';

/**
 * Task 11 — profileAndClone не создаёт клон удалённого аккаунта.
 *
 * Загрузка сэмпла голоса запускает profileAndClone асинхронно (setImmediate):
 * если между загрузкой и клоном аккаунт удалили, ElevenLabs-клон и строка
 * user_voice создались бы для generation, которой больше нет — платный
 * внешний ресурс, который никто не чистит (Task 14 ищет клон по строке).
 * Strict active checks: ДО provider-вызова и ДО DB update.
 */

function makeHarness(state: 'active' | 'deleted') {
  const users = new Map<string, string>([['u-1', state]]);
  const voiceRows: Array<{ user_id: string; status: string }> = [];
  const queries: string[] = [];
  const pg = {
    async query(sql: string, params: any[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      queries.push(s);
      if (/^SELECT 1 FROM user_id WHERE internal_id = \$1 AND state = 'active'/.test(s)) {
        const ok = users.get(String(params[0])) === 'active';
        return { rows: ok ? [{ '?column?': 1 }] : [], rowCount: ok ? 1 : 0 };
      }
      if (/^UPDATE user_voice/.test(s)) {
        // Семантика прод-SQL: UPDATE с EXISTS-гейтом на активный аккаунт.
        if (/EXISTS \(SELECT 1 FROM user_id u WHERE u\.internal_id = \$1 AND u\.state = 'active'\)/.test(s)) {
          if (users.get(String(params[0])) !== 'active') return { rows: [], rowCount: 0 };
        }
        voiceRows.push({ user_id: String(params[0]), status: 'ready' });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const svc = new VoiceAvatarService(pg as any);
  const profile = jest.fn(async () => ({ gender: 'x' }));
  const clone = jest.fn(async () => 'voice-ext-1');
  const markFailed = jest.fn(async () => undefined);
  const deleteClone = jest.fn(async () => undefined);
  (svc as any).profile = profile;
  (svc as any).clone = clone;
  (svc as any).markFailed = markFailed;
  (svc as any).deleteClone = deleteClone;
  const logSpy = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);
  const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  return { svc, users, voiceRows, queries, profile, clone, markFailed, deleteClone, logSpy, warnSpy };
}

describe('VoiceAvatarService.profileAndClone — gate на активный аккаунт', () => {
  it('удалённый аккаунт: provider не вызывается, строка не пишется', async () => {
    const h = makeHarness('deleted');

    await (h.svc as any).profileAndClone('u-1', Buffer.from('mp3'));

    expect(h.profile).not.toHaveBeenCalled();
    expect(h.clone).not.toHaveBeenCalled();
    expect(h.voiceRows).toEqual([]);
    expect(h.queries.some((q) => /^UPDATE user_voice/.test(q))).toBe(false);
    expect(h.markFailed).not.toHaveBeenCalled();
  });

  it('активный аккаунт: клон создаётся и строка пишется, как раньше', async () => {
    const h = makeHarness('active');

    await (h.svc as any).profileAndClone('u-1', Buffer.from('mp3'));

    expect(h.profile).toHaveBeenCalledTimes(1);
    expect(h.clone).toHaveBeenCalledTimes(1);
    expect(h.voiceRows).toEqual([{ user_id: 'u-1', status: 'ready' }]);
    expect(h.deleteClone).not.toHaveBeenCalled();
    expect(h.logSpy).toHaveBeenCalledWith(expect.stringContaining('voice ready'));
  });

  it('удаление посреди клонирования: UPDATE с EXISTS-гейтом не пишет строку', async () => {
    const h = makeHarness('active');
    // Аккаунт удалили, пока Gemini слушал сэмпл (до вызова ElevenLabs clone
    // и до DB update).
    h.profile.mockImplementation(async () => {
      h.users.set('u-1', 'deleted');
      return { gender: 'x' };
    });

    await (h.svc as any).profileAndClone('u-1', Buffer.from('mp3'));

    expect(h.voiceRows).toEqual([]);
    const update = h.queries.find((q) => /^UPDATE user_voice/.test(q));
    expect(update).toBeDefined();
    expect(update).toMatch(/EXISTS \(SELECT 1 FROM user_id u WHERE u\.internal_id = \$1 AND u\.state = 'active'\)/);
    // Провалом это не считается: markFailed писал бы error_message для
    // аккаунта, которого нет.
    expect(h.markFailed).not.toHaveBeenCalled();
  });

  it('I1: клон создан, но gate закрылся — сиротский клон компенсируется deleteClone', async () => {
    const h = makeHarness('active');
    // Аккаунт стал неактивным ПОСЛЕ вызова ElevenLabs clone: UPDATE с
    // EXISTS-гейтом не пишет строку (rowCount 0) → voice_id некому искать
    // (Task 14 чистит клоны по строкам user_voice). Компенсация обязательна,
    // иначе платный клон остаётся у провайдера навсегда.
    h.profile.mockImplementation(async () => {
      h.users.set('u-1', 'deleted');
      return { gender: 'x' };
    });

    await (h.svc as any).profileAndClone('u-1', Buffer.from('mp3'));

    expect(h.clone).toHaveBeenCalledTimes(1);
    expect(h.voiceRows).toEqual([]);
    expect(h.deleteClone).toHaveBeenCalledWith('voice-ext-1');
    // Лог компенсации — без внешних идентификаторов; «voice ready» не врёт.
    expect(h.warnSpy).toHaveBeenCalledWith('voice clone compensated after inactive-gate');
    expect(h.logSpy).not.toHaveBeenCalledWith(expect.stringContaining('voice ready'));
    expect(h.markFailed).not.toHaveBeenCalled();
  });
});
