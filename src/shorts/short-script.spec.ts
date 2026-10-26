import { CASE_BADGE, SPEECH_SPEED, buildScript } from './short-script';

const reply = {
  hook: 'Снимаете квартиру? Как не потерять залог',
  hookBox: 11,
  question: 'Я Алексей, юрист. Меня спросили, что проверить в договоре аренды.',
  lines: [{ box: 11, text: 'Опасные фразы в договоре.' }, { box: 14, text: 'Нормальный износ.' }],
};

describe('buildScript', () => {
  it('реплики по сценам, финал и число ассистентов — от кода', () => {
    const s = buildScript(reply, { voice: 'madirus', narratorVoice: 'alena', assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет юриста' });
    expect(s.lines.map((l) => [l.id, l.scene, l.box ?? null])).toEqual([
      ['h', 'hook', null], ['q', 'question', null], ['a1', 'answer', 11], ['a2', 'answer', 14], ['f', 'final', null],
    ]);
    expect(s.lines[4]).toEqual({ id: 'f', scene: 'final', voice: 'alena', text: 'Линкеон — восемнадцать ассистентов. Ссылка — в описании и в профиле.' });
    expect(s).toMatchObject({ hook: reply.hook, hookBox: 11, voice: 'madirus', speed: SPEECH_SPEED, final: { assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет юриста' } });
    expect(s.badge).toBeUndefined();
  });

  it('без опоры зацепки и без строки о специалисте — полей нет вовсе', () => {
    const s = buildScript({ ...reply, hookBox: null }, { voice: 'marina', narratorVoice: 'alena', assistantsCount: 18 });
    expect('hookBox' in s).toBe(false);
    expect(s.final).toEqual({ assistantsCount: 18 });
  });

  it('реальный кейс — с подписью в кадре вопроса', () => {
    const s = buildScript(reply, { voice: 'madirus', narratorVoice: 'alena', assistantsCount: 18, badge: CASE_BADGE });
    expect(s.badge).toBe('Реальная история, разговор повторён на демо-аккаунте');
  });
});
