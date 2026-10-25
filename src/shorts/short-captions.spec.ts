import {
  SYNTH_NOTE,
  TG_CAPTION_MAX,
  VK_TEXT_MAX,
  YT_TAGS_TOTAL_MAX,
  YT_TITLE_MAX,
  buildCaptions,
  buildReviewCaption,
  clip,
  tidyTags,
} from './short-captions';

/** Одиночный суррогат без пары — признак того, что эмодзи разрезали пополам. */
const hasLoneSurrogate = (s: string): boolean =>
  Array.from(s).some((ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff);

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
    // Предел — в единицах UTF-16 (.length), не в символах: 😀 весит 2 единицы,
    // поэтому в clip(…, 5) входят только 2 эмодзи-символа (4 единицы) + «…» (1 единица) = 5.
    // Раньше тест мерил длину через Array.from (символы) и ждал 5 символов — это считало
    // эмодзи за 1 единицу, что и была ошибка из Правки 1.
    expect(clip('😀'.repeat(10), 5).length).toBe(5);
    expect(hasLoneSurrogate(clip('😀'.repeat(10), 5))).toBe(false);
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

  it('подпись Telegram из 900 эмодзи укладывается в предел по единицам UTF-16, хвост цел', () => {
    const c = buildCaptions({ ...w, telegram: '😀'.repeat(900) }, links);
    expect(c.telegram.length).toBeLessThanOrEqual(TG_CAPTION_MAX);
    expect(c.telegram.endsWith(`${links.telegram}\n\n${SYNTH_NOTE}`)).toBe(true);
    expect(hasLoneSurrogate(c.telegram)).toBe(false);
  });

  it('подпись VK из 1500 эмодзи укладывается в предел по единицам UTF-16, хвост цел', () => {
    const c = buildCaptions({ ...w, vk: '😀'.repeat(1500) }, links);
    expect(c.vk.length).toBeLessThanOrEqual(VK_TEXT_MAX);
    expect(c.vk.endsWith(`${links.vk}\n\n${SYNTH_NOTE}`)).toBe(true);
    expect(hasLoneSurrogate(c.vk)).toBe(false);
  });
});

describe('tidyTags', () => {
  it('без решёток, повторов и сверх общего предела', () => {
    expect(tidyTags(['#a', 'a', ' b  c '])).toEqual(['a', 'b c']);
    expect(tidyTags(Array.from({ length: 100 }, (_, i) => `тег${i}`)).join(',').length).toBeLessThanOrEqual(450);
  });

  it('дедуп без учёта регистра — остаётся первый вариант написания', () => {
    expect(tidyTags(['Залог', 'залог', 'аренда'])).toEqual(['Залог', 'аренда']);
  });

  it('теги с пробелом считаются с кавычками — сумма не выходит за общий предел', () => {
    const tags = Array.from({ length: 40 }, (_, i) => `семейное право${i}`);
    const result = tidyTags(tags);
    const total = result.reduce((sum, t) => sum + (t.includes(' ') ? t.length + 2 : t.length) + 1, 0);
    expect(total).toBeLessThanOrEqual(YT_TAGS_TOTAL_MAX);
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
    expect(r.caption.length).toBeLessThanOrEqual(TG_CAPTION_MAX);
    expect(r.extra).toContain('Telegram:');
  });

  it('подпись Telegram из эмодзи: символов меньше 1000, единиц UTF-16 больше — подписи вторым сообщением', () => {
    const r = buildReviewCaption({ ...base, captions: buildCaptions({ ...w, telegram: '😀'.repeat(380) }, links) });
    expect(r.caption.length).toBeLessThanOrEqual(TG_CAPTION_MAX);
    expect(r.extra).toContain('Telegram:');
  });

  it('стенд помечен', () => {
    expect(buildReviewCaption({ ...base, stand: true }).caption.startsWith('[СТЕНД]')).toBe(true);
  });

  it('вопрос из эмодзи — подпись укладывается в предел по единицам UTF-16', () => {
    const r = buildReviewCaption({ ...base, question: '😀'.repeat(2000) });
    expect(r.caption.length).toBeLessThanOrEqual(TG_CAPTION_MAX);
    expect(hasLoneSurrogate(r.caption)).toBe(false);
  });
});
