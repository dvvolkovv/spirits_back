import { ChatService } from './chat.service';
import { AgentsService } from '../agents/agents.service';

/**
 * Системный промпт Маши (agent.id === 3, локальный claude CLI, не релей).
 *
 * Три вещи, которые он обязан говорить честно:
 *  1. Коллеги — только те, кого пользователь может выбрать. При первом
 *     приветствии Маша их перечисляет; раньше список брался из всей таблицы,
 *     и в приветствие попадали выключенные ассистенты и служебный «Линкеон».
 *  2. Инструментов картинок и видео у Маши нет: её CLI запускается с
 *     `--tools ""` и единственным MCP — продуктами пользователя. Промпт же
 *     обещал generate_image / edit_image / compose_image / upscale_image /
 *     generate_video и требовал «не придумывай отговорки — у тебя есть эти
 *     инструменты»: Маша обещала картинку и не делала её.
 *  3. «ПРАВИЛО ОТВЕТА» объявляет приоритет над всеми инструкциями. Кризисное
 *     правило из промпта ассистента обязано остаться главнее: там прямой
 *     вопрос о безопасности и номера помощи, а не «одна гипотеза и максимум
 *     один вопрос».
 */

const USER = '79030169187';

interface Row { id: number; name: string; display_name: string; description: string | null; is_active: boolean }

const TABLE: Row[] = [
  { id: 2, name: 'Оля', display_name: 'Оля', description: 'Исследование ценностей', is_active: true },
  { id: 3, name: 'Маша', display_name: 'Маша', description: 'Игропрактик', is_active: true },
  { id: 8, name: 'Герман', display_name: 'Герман', description: 'Про осознанность', is_active: false },
  { id: 12, name: 'Роман', display_name: 'Роман', description: 'Бизнес-ассистент', is_active: true },
  { id: 15, name: 'smm_producer', display_name: 'Юлия', description: 'SMM-продюсер', is_active: false },
  { id: 18, name: 'linkeon_voice', display_name: 'Линкеон', description: 'Голосовой ассистент', is_active: true },
];

function makeService() {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT tokens FROM ai_profiles_consolidated')) return { rows: [{ tokens: 100000 }] };
      if (/FROM agents a\s+LEFT JOIN agent_translations/.test(sql)) {
        // Применяем только условия, которые реально стоят в SQL: убери фильтр
        // из запроса — и выключенный ассистент «попадёт» в промпт.
        const flat = sql.replace(/\s+/g, ' ');
        let rows = TABLE.filter((r) => r.id !== Number(params[0]));
        if (/\ba\.is_active\b/.test(flat)) rows = rows.filter((r) => r.is_active);
        if (/a\.name <> ALL\(\$3::text\[\]\)/.test(flat)) {
          rows = rows.filter((r) => !(params[2] as string[]).includes(r.name));
        }
        return { rows: rows.map((r) => ({ display_name: r.display_name, description: r.description })) };
      }
      return { rows: [] };
    }),
  };
  const claudeCli = {
    textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: 'Привет! Я Маша.', costUsd: 0.01 })),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const balanceCtx = { buildContextForPrompt: jest.fn(async () => '') };
  const svc = new ChatService(
    pg as any, undefined as any, undefined as any, {} as any, claudeCli as any, language as any, balanceCtx as any,
  );
  jest.spyOn(svc as any, 'resolveAgent').mockResolvedValue({
    id: 3, name: 'Маша', description: 'Игропрактик', system_prompt: 'Ты Маша.', category: 'personal',
  });
  jest.spyOn(svc as any, 'saveChatHistory').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'addTokenTask').mockResolvedValue(undefined);
  return { svc, claudeCli, calls };
}

function makeRes() {
  const res: any = {
    status: jest.fn(() => res),
    setHeader: jest.fn(),
    write: jest.fn(() => true),
    end: jest.fn(),
    json: jest.fn(),
  };
  return res;
}

async function mashaSystemPrompt() {
  const { svc, claudeCli, calls } = makeService();
  await svc.streamChat(USER, 'Нарисуй мне кота', '3', `${USER}_3`, '', makeRes());
  await new Promise((r) => setImmediate(r));
  expect(claudeCli.textWithCost).toHaveBeenCalledTimes(1);
  return { system: String(claudeCli.textWithCost.mock.calls[0][1].system), calls };
}

/** Строка «Другие ассистенты: …» из промпта. */
function othersLine(system: string): string {
  const m = /Другие ассистенты: (.*?)\. Предложи переключиться/.exec(system);
  expect(m).not.toBeNull();
  return m![1];
}

describe('системный промпт Маши', () => {
  const OLD_DS = process.env.DEEPSEEK_API_KEY;
  beforeAll(() => { delete process.env.DEEPSEEK_API_KEY; });
  afterAll(() => {
    if (OLD_DS === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = OLD_DS;
  });

  describe('«Другие ассистенты»', () => {
    it('без выключенных и без служебного «Линкеона»', async () => {
      const line = othersLine((await mashaSystemPrompt()).system);

      for (const gone of ['Герман', 'Юлия', 'Линкеон']) expect(line).not.toContain(gone);
    });

    it('активные коллеги на месте, себя Маша не перечисляет', async () => {
      const line = othersLine((await mashaSystemPrompt()).system);

      expect(line).toBe('Оля — Исследование ценностей, Роман — Бизнес-ассистент');
    });

    it('запрос тот же, что у релея: служебные имена — параметром', async () => {
      const { calls } = await mashaSystemPrompt();
      const q = calls.find((c) => /FROM agents a\s+LEFT JOIN agent_translations/.test(c.sql));

      expect(q).toBeDefined();
      expect(q!.params).toEqual([3, 'ru', AgentsService.SERVICE_AGENTS]);
    });
  });

  describe('инструменты картинок и видео', () => {
    it('не обещает инструментов, которых у Маши нет', async () => {
      const { system } = await mashaSystemPrompt();

      for (const tool of ['generate_image', 'edit_image', 'compose_image', 'upscale_image', 'generate_video']) {
        expect(system).not.toContain(tool);
      }
      expect(system).not.toMatch(/у тебя есть эти инструменты/);
    });

    it('говорит честно: сама не генерирует и куда направить человека', async () => {
      const flat = (await mashaSystemPrompt()).system.replace(/\s+/g, ' ');

      expect(flat).toMatch(/Картинки и видео ты в этом чате не генерируешь/);
      expect(flat).toMatch(/«Генератор изображений» или «Видео»/);
      expect(flat).toMatch(/переключиться на другого ассистента/);
    });

    it('без снятой модели Imagen', async () => {
      const { system } = await mashaSystemPrompt();

      expect(system).not.toMatch(/Imagen/i);
    });
  });

  it('«ПРАВИЛО ОТВЕТА» уступает кризисному правилу', async () => {
    const { system } = await mashaSystemPrompt();
    const header = system.split('\n').find((l) => l.includes('ПРАВИЛО ОТВЕТА'));

    expect(header).toMatch(/кроме правила о кризисной ситуации/);
  });
});
