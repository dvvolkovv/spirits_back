import { BlogEditorService } from './blog-editor.service';
import { buildEditorMessage, buildEditorPrompt } from './blog-editor.prompt';

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
});
