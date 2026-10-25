import { SYNTH_NOTE, TG_CAPTION_MAX, YT_TITLE_MAX, buildCaptions, buildReviewCaption, clip, tidyTags } from './short-captions';

const links = {
  telegram: 'https://my.linkeon.io/chat?assistant=10&utm_source=telegram&utm_medium=short&utm_campaign=sh_x_0000',
  vk: 'https://my.linkeon.io/chat?assistant=10&utm_source=vk&utm_medium=short&utm_campaign=sh_x_0000',
  youtube: 'https://my.linkeon.io/chat?assistant=10&utm_source=youtube&utm_medium=short&utm_campaign=sh_x_0000',
};
const w = {
  telegram: 'Юрист разобрал договор.',
  vk: '',
  youtube: { title: 'Залог при аренде', description: 'Три пункта.', tags: ['#аренда', 'залог', 'залог', 'юрист'] },
};

describe('clip', () => {
  it('режет по символам и ставит многоточие', () => {
    expect(clip('короткий', 20)).toBe('короткий');
    expect(clip('абвгдеёжзи', 5)).toBe('абвг…');
    expect(Array.from(clip('😀'.repeat(10), 5))).toHaveLength(5);
  });
});

describe('buildCaptions', () => {
  it('ссылка и пометка о синтезированном голосе — у каждой площадки', () => {
    const c = buildCaptions(w, links);
    expect(c.telegram).toBe(`Юрист разобрал договор.\n\n${links.telegram}\n\n${SYNTH_NOTE}`);
    expect(c.vk.startsWith('Юрист разобрал договор.')).toBe(true);
    expect(c.vk).toContain(links.vk);
    expect(c.youtube.description).toBe(`Три пункта.\n\n${links.youtube}\n\n${SYNTH_NOTE}`);
    expect(c.youtube.tags).toEqual(['аренда', 'залог', 'юрист']);
  });

  it('подпись Telegram не длиннее 1000 — режется текст, а не ссылка', () => {
    const c = buildCaptions({ ...w, telegram: 'я'.repeat(2000) }, links);
    expect(Array.from(c.telegram).length).toBeLessThanOrEqual(TG_CAPTION_MAX);
    expect(c.telegram.endsWith(`${links.telegram}\n\n${SYNTH_NOTE}`)).toBe(true);
  });

  it('заголовок YouTube не длиннее 100', () => {
    const c = buildCaptions({ ...w, youtube: { ...w.youtube, title: 'я'.repeat(300) } }, links);
    expect(Array.from(c.youtube.title).length).toBeLessThanOrEqual(YT_TITLE_MAX);
  });
});

describe('tidyTags', () => {
  it('без решёток, повторов и сверх общего предела', () => {
    expect(tidyTags(['#a', 'a', ' b  c '])).toEqual(['a', 'b c']);
    expect(tidyTags(Array.from({ length: 100 }, (_, i) => `тег${i}`)).join(',').length).toBeLessThanOrEqual(450);
  });
});

describe('buildReviewCaption', () => {
  const base = {
    stand: false,
    rubric: 'assistant' as const,
    angle: 'roast' as const,
    assistantName: 'Алексей',
    question: 'Проверьте договор',
    when: 'завтра в 18:00 МСК',
    captions: buildCaptions(w, links),
  };

  it('влезает в 1000 — одним сообщением со всеми подписями', () => {
    const r = buildReviewCaption(base);
    expect(r.extra).toBeNull();
    expect(r.caption).toContain('Рубрика: Ассистент за работой · подача: разнос');
    expect(r.caption).toContain('Выйдет: завтра в 18:00 МСК');
    expect(r.caption).toContain('YouTube — заголовок:');
  });

  it('не влезает — подписи вторым сообщением', () => {
    const r = buildReviewCaption({ ...base, captions: buildCaptions({ ...w, telegram: 'я'.repeat(900) }, links) });
    expect(Array.from(r.caption).length).toBeLessThanOrEqual(TG_CAPTION_MAX);
    expect(r.extra).toContain('Telegram:');
  });

  it('стенд помечен', () => {
    expect(buildReviewCaption({ ...base, stand: true }).caption.startsWith('[СТЕНД]')).toBe(true);
  });
});
