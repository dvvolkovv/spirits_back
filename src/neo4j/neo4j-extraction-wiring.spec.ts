import axios from 'axios';
import { Neo4jService } from './neo4j.service';
import { buildProfileExtractionPrompt } from './profile-extraction-prompt';

/**
 * Сервис отдаёт модели ровно промпт из buildProfileExtractionPrompt — и основным
 * путём (Claude CLI), и запасным (OpenRouter). Свой текст на любом из путей молча
 * выключил бы правило о здоровье на этом трафике. Проверяется поведением, а не
 * чтением исходника: закомментированный вызов или другой текст в фолбэке
 * исходник-сторож пропускал.
 */
describe('Neo4jService.consolidateFromChat: промпт извлечения', () => {
  const savedKey = process.env.OPENROUTER_API_KEY;

  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
    jest.restoreAllMocks();
  });

  /** Сервис без Neo4j: прошлая реплика ассистента — 'PREV'; getSession → null, поэтому запись в граф и эмбеддинг пропускаются. */
  function makeService(cliAnswer: string | null) {
    const pg = { query: jest.fn(async () => ({ rows: [{ content: 'PREV' }] })) };
    const cli = { text: jest.fn(async () => cliAnswer) };
    const svc = new Neo4jService(pg as any, cli as any);
    (svc as any).driver = {};
    (svc as any).getSession = () => null;
    return { svc, cli };
  }

  it('основной путь (Claude CLI) получает промпт из buildProfileExtractionPrompt', async () => {
    const { svc, cli } = makeService('{}');
    await svc.consolidateFromChat('u', 'a', 'USER', 'CUR');
    expect(cli.text).toHaveBeenCalledWith(buildProfileExtractionPrompt('PREV', 'USER', 'CUR'), expect.anything());
  });

  it('запасной путь (OpenRouter) получает тот же промпт', async () => {
    process.env.OPENROUTER_API_KEY = 'test';
    const post = jest
      .spyOn(axios, 'post')
      .mockResolvedValue({ data: { choices: [{ message: { content: '{}' } }] } } as any);
    const { svc } = makeService(null);
    await svc.consolidateFromChat('u', 'a', 'USER', 'CUR');
    expect(post).toHaveBeenCalled();
    expect((post.mock.calls[0][1] as any).messages[0].content).toBe(buildProfileExtractionPrompt('PREV', 'USER', 'CUR'));
  });

  /**
   * Перенос пробы в аккаунт (guest-claim.service.ts) вставляет все пары
   * заранее одним махом, поэтому передаёт предыдущую реплику явно, а не даёт
   * сервису достать её своим запросом (он отдал бы одну и ту же «PREV» на
   * каждую пару). Явная пустая строка — валидное значение «начало диалога»,
   * отличное от «параметр не передан».
   */
  it('явная prevAssistantMessage (пятый аргумент), включая пустую строку — без запроса к базе', async () => {
    const { svc, cli } = makeService('{}');
    await svc.consolidateFromChat('u', 'a', 'USER2', 'CUR2', '');
    expect(cli.text).toHaveBeenCalledWith(buildProfileExtractionPrompt('', 'USER2', 'CUR2'), expect.anything());
  });
});
