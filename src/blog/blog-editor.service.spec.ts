import { BlogEditorService } from './blog-editor.service';
import { buildEditorPrompt } from './blog-editor.prompt';

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
});
