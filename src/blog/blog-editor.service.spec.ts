import { BlogEditorService } from './blog-editor.service';
import { buildEditorMessage, buildEditorPrompt, editorKind } from './blog-editor.prompt';

const relayMock = (reply: string) => ({ ask: jest.fn().mockResolvedValue(reply) });
const topicsMock = () => ({ recentTitles: jest.fn().mockResolvedValue(['Старый пост']) });

const POST: any = {
  id: 'p1', rubric: 'case', topicKey: 'аренда', topicHint: 'часто спрашивают про аренду',
};

describe('buildEditorPrompt', () => {
  it('в промпт попадают прошлые заголовки — чтобы редактор не повторялся', () => {
    const p = buildEditorPrompt('case', ['Заголовок А', 'Заголовок Б']);
    expect(p).toContain('Заголовок А');
    expect(p).toContain('Заголовок Б');
  });

  it('промпт требует JSON с тремя полями', () => {
    const p = buildEditorPrompt('news', []);
    expect(p).toContain('title');
    expect(p).toContain('body');
    expect(p).toContain('imagePrompt');
  });

  it('для новостей и кейсов промпты разные', () => {
    expect(buildEditorPrompt('news', [])).not.toBe(buildEditorPrompt('case', []));
  });
});

/**
 * Прошлые заголовки — это НЕ список запретов, а весь контекст читателя.
 *
 * Прежняя формулировка («вот заголовки последних постов — не повторяй их темы
 * и интонацию») запрещала повтор и молча разрешала обратное: писать так, будто
 * предыдущая серия уже прочитана. На проде это дало пост «продукт больше не
 * придётся запускать заново» про вкладку, о которой канал не сказал ни слова,
 * — читатель не знал ни что такое «продукт», ни что было «раньше».
 */
describe('блок про контекст читателя', () => {
  /**
   * Промпт свёрстан переносами строк, и фраза легко оказывается разорванной
   * пополам. Смысл от переноса не меняется, а точное место переноса ничего не
   * значит — сверяем по тексту, а не по вёрстке.
   */
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  const WITH = () => flat(buildEditorPrompt('news', ['Как мы рисовали логотип', 'Встречу теперь можно записать']));

  it('заголовки поданы как весь контекст читателя, а не как чёрный список', () => {
    const p = WITH();
    expect(p).toMatch(/ровно это и ничего больше/i);
    // «не повторяй» само по себе не запрещено, но одним им дело не ограничивается
    expect(p).not.toMatch(/Вот заголовки последних постов канала — не повторяй их темы и интонацию/);
  });

  it('тема вне этого списка требует объяснения с нуля', () => {
    expect(WITH()).toMatch(/с нуля/i);
  });

  it('прямо запрещает «теперь стало лучше», когда про «раньше» читатель не знает', () => {
    const p = WITH();
    expect(p).toMatch(/теперь не придётся заново/i);
    expect(p).toMatch(/не знает, как было раньше/i);
  });

  /**
   * Краевой случай, из-за которого всё и затевалось: канал опубликовал два
   * поста, а начинался с нуля. Подставить пустой перечень — значит сказать
   * редактору «контекст есть, он просто пустой».
   */
  describe('когда канал не опубликовал ещё ничего', () => {
    const EMPTY = () => flat(buildEditorPrompt('news', []));

    it('это сказано прямо, а не молчанием', () => {
      expect(EMPTY()).toMatch(/ни одного поста/i);
    });

    it('редактору велено писать для человека, который видит нас впервые', () => {
      expect(EMPTY()).toMatch(/с нуля/i);
    });

    // Здесь сверяем именно вёрстку: пустая строка-буллет и есть тот самый
    // «пустой перечень», которого быть не должно.
    it('пустой перечень не подставляется', () => {
      expect(buildEditorPrompt('news', [])).not.toMatch(/^-\s*$/m);
    });
  });
});

/**
 * Кейс о Кире-дизайнере вышел на проде про планирование и тревогу — профиль
 * редактор выдумал сам, — и с фразой «На этой неделе чаще всего писали Кире»:
 * внутренняя статистика ушла бы в публичный канал.
 */
describe('промпт кейса', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  const CASE = () => flat(buildEditorPrompt('case', ['Как мы рисовали логотип']));

  it('ассистента описывать только по профилю из темы, без умений сверх описания', () => {
    const p = CASE();
    expect(p).toMatch(/только по профилю из темы/i);
    expect(p).toMatch(/не приписывай ассистенту[^.]*сверх описания/i);
  });

  it('запрещает статистику и популярность, в том числе «чаще всего писали / обращались»', () => {
    const p = CASE();
    expect(p).toMatch(/никогда не упоминай статистику/i);
    expect(p).toContain('«чаще всего писали»');
    expect(p).toContain('«чаще всего обращались»');
  });

  it('не зовёт подсказку «востребованной темой» — это и подталкивало пересказывать популярность', () => {
    expect(CASE()).not.toMatch(/востребован/i);
  });
});

/**
 * Кейсы про Романа и Лиану не собрались: вероятно, редактор вместо поста
 * переспросил, кто это. Спросить в ответ ему некого — ответ читает программа.
 */
describe('ответ редактора — всегда JSON', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ');

  it.each(['news', 'case', 'real'] as const)('%s: всегда JSON, без встречных вопросов; мало данных — короче', (kind) => {
    const p = flat(buildEditorPrompt(kind, []));
    expect(p).toMatch(/всегда JSON/i);
    expect(p).toMatch(/никаких встречных вопросов/i);
    expect(p).toMatch(/данных мало — пиши короче, по тому, что есть/i);
  });
});

/**
 * Замечание владельца — правка главного редактора, а не пожелание. Если
 * подать его как «владелец, кстати, писал», модель вежливо кивнёт и оставит
 * текст как был.
 */
describe('buildEditorMessage', () => {
  /** Как и промпт, сообщение свёрстано переносами — сверяем текст, не вёрстку. */
  const flat = (s: string) => s.replace(/\s+/g, ' ');

  it('без замечаний — только тема и подсказка источника', () => {
    const m = buildEditorMessage('аренда', 'часто спрашивают про аренду', []);
    expect(m).toContain('аренда');
    expect(m).toContain('часто спрашивают про аренду');
    expect(m).not.toMatch(/редактор/i);
  });

  it('замечания доезжают до релея целиком', () => {
    const m = buildEditorMessage('продукты', null, [
      'читатель не знает, что такое продукт — объясни',
      'слишком длинно',
    ]);
    expect(m).toContain('читатель не знает, что такое продукт — объясни');
    expect(m).toContain('слишком длинно');
  });

  it('поданы как правка главного редактора, а не как пожелание', () => {
    const m = flat(buildEditorMessage('продукты', null, ['объясни, что такое продукт']));
    expect(m).toMatch(/главного редактора/i);
    expect(m).toMatch(/не пожелани/i);
  });

  it('порядок замечаний сохраняется — от раннего к свежему', () => {
    const m = buildEditorMessage('k', null, ['ПЕРВОЕ', 'ВТОРОЕ']);
    expect(m.indexOf('ПЕРВОЕ')).toBeLessThan(m.indexOf('ВТОРОЕ'));
  });
});

/**
 * Реальный кейс — правда, а не выдумка: владелец приносит историю, и редактор
 * обязан её пересказать, а не сочинить новую. Прежний промпт знал только
 * выдумку, и реальная история владельца превратилась бы в очередную «Лену».
 */
describe('промпт реального кейса', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  const REAL = () => flat(buildEditorPrompt('real', ['Как мы рисовали логотип']));

  it('отличается от промптов новости и выдуманного кейса', () => {
    expect(buildEditorPrompt('real', [])).not.toBe(buildEditorPrompt('case', []));
    expect(buildEditorPrompt('real', [])).not.toBe(buildEditorPrompt('news', []));
  });

  it('не велит выдумывать и запрещает помечать историю придуманной', () => {
    const p = REAL();
    expect(p).not.toMatch(/вымышлен/i);
    expect(p).not.toMatch(/придумай/i);
    expect(p).toMatch(/не пиши, что история придумана/i);
  });

  it('пишет только по материалу и не додумывает', () => {
    const p = REAL();
    expect(p).toMatch(/только то, что есть в материале/i);
    expect(p).toMatch(/не добавляй деталей, чисел, сроков/i);
  });

  it('герой и рассказчик — как в материале, и уже из первого абзаца видно, чья это история', () => {
    const p = REAL();
    expect(p).toMatch(/ровно как в материале/i);
    expect(p).toMatch(/из первого абзаца/i);
  });

  it('строит пост вокруг сути, если она названа', () => {
    expect(REAL()).toMatch(/строй пост вокруг/i);
  });

  it('не переносит персональные данные и не называет чужие организации', () => {
    const p = REAL();
    expect(p).toMatch(/ИНН/);
    expect(p).toMatch(/даже если они есть в материале/i);
    expect(p).toMatch(/по названию не называй никого/i);
    expect(p).toMatch(/номера счетов/i);
    expect(p).toMatch(/госномер/i);
  });

  it('не обобщает до обещания', () => {
    expect(REAL()).toMatch(/не обобщай до обещания/i);
  });

  it('статистику и популярность запрещает, как и выдуманный кейс', () => {
    expect(REAL()).toMatch(/никогда не упоминай статистику/i);
  });

  it('не дописывает финал за героя', () => {
    expect(REAL()).toMatch(/не дописывай финал/i);
  });

  // Роман — универсальный ассистент, а первые истории — про налоги и страховку:
  // без запрета редактор назвал бы его юристом — ложный факт в посте «из жизни».
  it('не даёт ассистенту специальности сверх материала', () => {
    expect(REAL()).toMatch(/не давай ему специальности/i);
    expect(REAL()).toMatch(/о linkeon пиши не больше/i);
  });

  // Замечание владельца к реальному кейсу чаще всего и есть факт («не так было…»).
  it('правка главного редактора — тоже материал', () => {
    expect(REAL()).toMatch(/правка главного редактора[^.]*тоже материал/i);
  });

  it('при сокращении оставляет главное и ничего не добавляет', () => {
    const p = REAL();
    expect(p).toMatch(/сокращай, а не пересказывай всё подряд/i);
    expect(p).toMatch(/выбрасывать можно, добавлять нельзя/i);
  });

  it('если материал молчит о лице рассказа — третье лицо', () => {
    expect(REAL()).toMatch(/пиши от третьего лица/i);
  });

  it('суть строит пост, даже если похожая мысль в канале уже была', () => {
    expect(REAL()).toMatch(/даже если похожая мысль уже была в канале/i);
  });

  // Рядом с подписью «Дмитрий, основатель Linkeon» сгенерированный человек
  // выглядел бы как его фото — та же подмена выдуманного реальным.
  it('правила касаются и заголовка, а на картинке нет узнаваемого героя', () => {
    const p = REAL();
    expect(p).toMatch(/касается и заголовка/i);
    expect(p).toMatch(/не рисуй героя узнаваемым человеком/i);
  });

  // Если материал героя не называет, правило «чья она» толкало бы модель
  // придумать имя.
  it('чья история — только если материал это называет', () => {
    expect(REAL()).toMatch(/если материал это называет/i);
  });

  it('«объясни продукт с нуля» для реального кейса — одна фраза', () => {
    expect(REAL()).toMatch(/для реального кейса это одна фраза/i);
  });
});

describe('buildEditorPrompt — незнакомый kind', () => {
  it('незнакомый kind — выдуманный кейс, а не «undefined» в тексте промпта', () => {
    const p = buildEditorPrompt('bogus' as any, []);
    expect(p).toContain('Рубрика: КЕЙС');
    expect(p).not.toContain('undefined');
  });
});

/**
 * Правило «не ссылайся на реальных пользователей» жило в общем блоке — то есть
 * и в промпте реального кейса, где оно спорило бы с самой задачей.
 */
describe('правило про реальных пользователей', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ');

  it.each(['news', 'case'] as const)('%s: по-прежнему запрещает ссылаться на реальных пользователей', (kind) => {
    expect(flat(buildEditorPrompt(kind, []))).toMatch(/не ссылайся на реальных пользователей/i);
  });

  it('real: такого запрета нет — история и есть реальная', () => {
    expect(flat(buildEditorPrompt('real', []))).not.toMatch(/не ссылайся на реальных пользователей/i);
  });

  it.each(['news', 'case', 'real'] as const)('%s: выдуманное за реальное не выдавать', (kind) => {
    expect(flat(buildEditorPrompt(kind, []))).toMatch(/не выдавай выдуманное за реальное/i);
  });
});

describe('editorKind', () => {
  it('новость — новость, откуда бы она ни пришла', () => {
    expect(editorKind('news', 'git')).toBe('news');
    expect(editorKind('news', 'manual')).toBe('news');
    expect(editorKind('news', 'real')).toBe('news');
  });

  it('кейс с источником real — реальный кейс', () => {
    expect(editorKind('case', 'real')).toBe('real');
  });

  it('прочие кейсы — выдуманные, как и раньше', () => {
    expect(editorKind('case', 'stats')).toBe('case');
    expect(editorKind('case', 'manual')).toBe('case');
  });

  // Старые строки и моки без source — выдуманный кейс, как было до реальных.
  it('кейс без источника — выдуманный', () => {
    expect(editorKind('case', undefined as any)).toBe('case');
  });
});

describe('buildEditorMessage для реального кейса', () => {
  const STORY = 'Рассказчик — Дмитрий, основатель Linkeon. Роман разобрал полис КАСКО.';
  const KEY = 'реальный-кейс-0123456789ab';

  it('материал подан как материал, а не как подсказка', () => {
    const m = buildEditorMessage(KEY, STORY, [], 'real');
    expect(m).toContain('Материал реального кейса');
    expect(m).toContain(STORY);
    expect(m).not.toMatch(/Подсказка от источника/);
  });

  it('хеш-ключ темы редактору не показывается — он ни о чём не говорит', () => {
    expect(buildEditorMessage(KEY, STORY, [], 'real')).not.toContain('0123456789ab');
  });

  it('замечания владельца доезжают и до реального кейса', () => {
    const m = buildEditorMessage(KEY, STORY, ['короче'], 'real');
    expect(m).toContain('короче');
    expect(m.replace(/\s+/g, ' ')).toMatch(/главного редактора/i);
  });

  it('без kind — прежнее поведение', () => {
    expect(buildEditorMessage('аренда', 'про аренду', [])).toContain('Подсказка от источника: про аренду');
  });

  // COMMON велит отвечать постом «в любом случае» — без материала это приказ
  // сочинить реальную историю из ничего. Пусть пост уйдёт в failed с причиной.
  it('реальный кейс без материала — ошибка, а не пост из ничего', () => {
    expect(() => buildEditorMessage(KEY, null, [], 'real')).toThrow(/нет материала/);
    expect(() => buildEditorMessage(KEY, '   ', [], 'real')).toThrow(/нет материала/);
  });
});

describe('BlogEditorService', () => {
  it('возвращает разобранный черновик', async () => {
    const relay = relayMock('{"title":"З","body":"Т","imagePrompt":"сцена"}');
    const svc = new BlogEditorService(relay as any, topicsMock() as any);
    const draft = await svc.draft(POST);
    expect(draft).toEqual({ title: 'З', body: 'Т', imagePrompt: 'сцена' });
  });

  it('sessionId свой на каждый пост', async () => {
    const relay = relayMock('{"title":"З","body":"Т","imagePrompt":"с"}');
    const svc = new BlogEditorService(relay as any, topicsMock() as any);
    await svc.draft(POST);
    expect(relay.ask.mock.calls[0][2]).toContain('p1');
  });

  it('мусорный ответ релея — ошибка наверх, а не пустой пост', async () => {
    const relay = relayMock('извини, не могу');
    const svc = new BlogEditorService(relay as any, topicsMock() as any);
    await expect(svc.draft(POST)).rejects.toThrow(/не нашёл json/i);
  });

  /**
   * Самая дорогая половина работы: замечание, сохранённое в базу, но не
   * доехавшее до релея, выглядит как принятое — бот отвечает «перепишу», а
   * редактор пишет ровно тот же пост заново.
   */
  it('замечания владельца доезжают до релея', async () => {
    const relay = relayMock('{"title":"З","body":"Т","imagePrompt":"с"}');
    const svc = new BlogEditorService(relay as any, topicsMock() as any);

    await svc.draft({ ...POST, editorNotes: ['читатель не знает, что такое продукт'] });

    const message = String(relay.ask.mock.calls[0][1]).replace(/\s+/g, ' ');
    expect(message).toContain('читатель не знает, что такое продукт');
    expect(message).toMatch(/главного редактора/i);
  });

  it('пост без замечаний уходит редактору без блока правок', async () => {
    const relay = relayMock('{"title":"З","body":"Т","imagePrompt":"с"}');
    const svc = new BlogEditorService(relay as any, topicsMock() as any);

    await svc.draft({ ...POST, editorNotes: [] });

    expect(String(relay.ask.mock.calls[0][1])).not.toMatch(/главного редактора/i);
  });

  it('реальный кейс уходит редактору с правилами реального кейса и материалом', async () => {
    const relay = relayMock('{"title":"З","body":"Т","imagePrompt":"с"}');
    const svc = new BlogEditorService(relay as any, topicsMock() as any);

    await svc.draft({
      ...POST, source: 'real', topicKey: 'реальный-кейс-0123456789ab',
      topicHint: 'Рассказчик — Дмитрий, основатель Linkeon.', editorNotes: [],
    });

    const [systemPrompt, message] = relay.ask.mock.calls[0];
    expect(String(systemPrompt)).toMatch(/РЕАЛЬНЫЙ КЕЙС/);
    expect(String(message)).toContain('Материал реального кейса');
    // Материал и есть весь пост: до релея обязан доехать сам текст, а не только заголовок блока.
    expect(String(message)).toContain('Рассказчик — Дмитрий, основатель Linkeon.');
  });

  it('кейс из статистики по-прежнему пишется выдумкой', async () => {
    const relay = relayMock('{"title":"З","body":"Т","imagePrompt":"с"}');
    const svc = new BlogEditorService(relay as any, topicsMock() as any);

    await svc.draft({ ...POST, source: 'stats', editorNotes: [] });

    const systemPrompt = String(relay.ask.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(systemPrompt).not.toMatch(/РЕАЛЬНЫЙ КЕЙС/);
    expect(systemPrompt).toMatch(/История вымышленная/);
  });

  // Рубрика в вызове editorKind тоже на счету: без неё новость молча получила
  // бы правила выдуманного кейса — «Придумай короткую узнаваемую историю».
  it('новость по-прежнему пишется по правилам новости', async () => {
    const relay = relayMock('{"title":"З","body":"Т","imagePrompt":"с"}');
    const svc = new BlogEditorService(relay as any, topicsMock() as any);

    await svc.draft({ ...POST, rubric: 'news', source: 'git', editorNotes: [] });

    const systemPrompt = String(relay.ask.mock.calls[0][0]);
    expect(systemPrompt).toMatch(/Рубрика: НОВИНКА/);
    expect(systemPrompt).not.toMatch(/Рубрика: КЕЙС|РЕАЛЬНЫЙ КЕЙС/);
  });
});
