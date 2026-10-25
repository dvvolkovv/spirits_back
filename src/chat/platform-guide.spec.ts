import { ChatService } from './chat.service';
import {
  customAssistantHelpLine,
  INITIATIVE_RULE,
  platformGuide,
  platformSections,
  telegramPlatformGuide,
  TOOLS_LIST_NOTE,
} from './platform-guide';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';

/**
 * Блок «Что есть в Linkeon» в системном промпте ассистента.
 *
 * Аудит 12.10.2026: ассистенты знали свои инструменты, но не знали платформу.
 * На вопрос «где создать сайт» или «можно ли поговорить голосом» им нечем было
 * ответить, кроме догадки. Блок перечисляет разделы веб-кабинета подписями,
 * которые пользователь видит на своём языке.
 */

const flat = (s: string) => s.replace(/\s+/g, ' ');
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe('текст блока', () => {
  it('русские подписи разделов и кнопок', () => {
    const g = platformGuide('ru');

    for (const label of [
      '«Чат с ассистентом»', '«Прослушать»', '«Чистый лист»', '«Медиа и файлы»', '«Позвонить»',
      '«Нетворкинг»', '«Генератор изображений»', '«Видео»', '«Студия»', '«Ассистенты»',
      '«Telegram-боты»', '«Продукты»', '«Мой профиль»', '«Мой бизнес»', '«Настройки»',
      '«Календари»', '«Уведомления на этом устройстве»', '«Голоса ассистентов»',
      '«Партнёры»', '«Помощь»', '«Связаться с поддержкой»',
      '«Zoom»', '«Мои напоминания»', '«Способы входа»',
    ]) {
      expect(g).toContain(label);
    }
  });

  it('на языке пользователя — его подписи, а не русские', () => {
    const en = platformGuide('en');
    expect(en).toContain('«Studio»');
    expect(en).toContain('«Products»');
    expect(en).toContain('«Listen»');
    expect(en).not.toContain('«Студия»');

    expect(platformGuide('zh')).toContain('«工作室»');
    expect(platformGuide('pt')).toContain('«Estúdio»');
  });

  it('перечень разделов — отдельно от вступления: его берёт и ИИ-поддержка', () => {
    const s = platformSections('ru');
    expect(platformGuide('ru')).toContain(s);
    expect(s).toMatch(/^• «Чат с ассистентом»/);
    expect(s).not.toContain('ЧТО ЕСТЬ В LINKEON');
    expect(s).not.toMatch(/предложи «Связаться с поддержкой»/);
  });

  it('незнакомый язык — русские подписи', () => {
    expect(platformGuide('xx')).toBe(platformGuide('ru'));
    expect(platformGuide('')).toBe(platformGuide('ru'));
  });

  it.each([...SUPPORTED_LANGUAGES])('%s: все подписи на месте', (lang) => {
    const g = platformGuide(lang);

    expect(g).not.toMatch(/undefined|«»|\{|\}/);
  });

  it('новый продукт создаётся только в Студии: ассистент в чате его не заводит', () => {
    expect(flat(platformGuide('ru'))).toMatch(/Новый продукт создаётся только там/);
  });

  it('в звонке отвечает только Роман — про звонок, а не про голос вообще', () => {
    // «Голосом отвечает только Роман» путало бы Telegram-ботов: голосовые
    // ответы у них есть у любого ассистента.
    expect(flat(platformGuide('ru'))).toMatch(/В звонке отвечает только Роман/);
    expect(flat(platformGuide('ru'))).not.toMatch(/Голосом отвечает только Роман/);
  });

  it('чего нет в списке — не выдумывать, а отправить в поддержку', () => {
    expect(flat(platformGuide('ru'))).toMatch(/Чего в списке нет, не выдумывай/);
  });

  it('без пополнения и оплаты: это забота блока баланса, а сборки для сторов ссылок не терпят', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const g = platformGuide(lang);
      expect(g).not.toContain('view=tokens');
      expect(g).not.toMatch(/пополн|оплат|YooKassa|₽/i);
    }
  });
});

const HELP = 'mcp__products__linkeon_help';

describe('справка и инициатива', () => {
  it('с инструментом: подробности — из справки, не по памяти; справка главнее персоны', () => {
    const g = flat(platformGuide('ru', { helpTool: HELP }));
    expect(g).toContain(HELP);
    expect(g).toMatch(/не по памяти/);
    expect(g).toMatch(/справка главнее того, что о платформе сказано в твоей персоне/);
    expect(g).toContain('«Связаться с поддержкой»');
    expect(g).not.toMatch(/Чего в списке нет, не выдумывай/);
  });

  it('без инструмента — прежнее вступление (приветствие Маши, где инструмента нет)', () => {
    expect(platformGuide('ru')).not.toContain(HELP);
    expect(flat(platformGuide('ru'))).toMatch(/Чего в списке нет, не выдумывай/);
  });

  it('правило инициативы — только по запросу', () => {
    expect(platformGuide('ru', { initiative: true })).toContain(INITIATIVE_RULE);
    expect(platformGuide('ru')).not.toContain(INITIATIVE_RULE);
    expect(flat(INITIATIVE_RULE)).toMatch(/одной фразой/);
    expect(flat(INITIATIVE_RULE)).toMatch(/не повторяй/);
    expect(flat(INITIATIVE_RULE)).toMatch(/кризисной ситуации/);
  });

  it('стор: без партнёрской программы — она про деньги', () => {
    expect(platformSections('ru', { store: true })).not.toMatch(/«Партнёры»|«Пригласи друга»/);
    expect(platformSections('ru')).toContain('«Партнёры»');
  });

  it('новые строки карты: Zoom, напоминания, способы входа, мини-приложение', () => {
    const s = flat(platformSections('ru'));
    expect(s).toContain('«Zoom»');
    expect(s).toContain('«Мои напоминания»');
    expect(s).toContain('«Способы входа»');
    expect(s).toMatch(/внутри Telegram/);
  });

  it('свой ассистент — одна строка про справку, без карты', () => {
    const line = customAssistantHelpLine(HELP);
    expect(line).toContain(HELP);
    expect(line).toMatch(/не по памяти/);
    expect(line).not.toContain('ЧТО ЕСТЬ В LINKEON');
  });

  it('Маше (CLI): карта несёт и правило справки, и инициативу напрямую', () => {
    const p = platformGuide('ru', { helpTool: HELP, initiative: true });
    expect(p).toContain(HELP);
    expect(p).toContain(INITIATIVE_RULE);
  });

  it('Telegram: справка и инициатива — по запросу', () => {
    expect(telegramPlatformGuide('ru', { helpTool: HELP, initiative: true })).toContain(INITIATIVE_RULE);
    expect(telegramPlatformGuide('ru', { helpTool: HELP })).toContain(HELP);
    expect(telegramPlatformGuide('ru', { helpTool: HELP })).not.toContain(INITIATIVE_RULE);
    expect(telegramPlatformGuide('ru')).not.toContain(HELP);
  });

  it('ни в одном варианте — ни пополнения, ни оплаты', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const g of [
        platformGuide(lang, { helpTool: HELP, initiative: true }),
        platformGuide(lang, { store: true }),
        telegramPlatformGuide(lang, { helpTool: HELP, initiative: true }),
      ]) {
        expect(g).not.toContain('view=tokens');
        expect(g).not.toMatch(/пополн|оплат|YooKassa|₽/i);
        expect(g).not.toMatch(/undefined|«»/);
      }
    }
  });
});

describe('системный промпт релея', () => {
  function makeService() {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    return new ChatService(
      pg as any, null as any, null as any, null as any, language as any, undefined as any,
    );
  }
  const prefix = (agentId: string, userLanguage = 'ru', storeBuild = false): Promise<string> =>
    (makeService() as any).buildRelayStablePrefix({
      agentId, agentName: 'Роман', agentDescription: '', agentSystemPrompt: 'Ты Роман. ИНСТРУМЕНТЫ: веб-поиск.',
      userId: 'u1', userLanguage, storeBuild,
    });
  const STAFF = { helpTool: HELP, initiative: true };

  it('штатный ассистент получает блок один раз, после своей персоны', async () => {
    const p = await prefix('12');

    expect(count(p, platformGuide('ru', STAFF))).toBe(1);
    expect(p.indexOf(platformGuide('ru', STAFF))).toBeGreaterThan(p.indexOf('ИНСТРУМЕНТЫ: веб-поиск.'));
  });

  it('и пометку, что раздел «ИНСТРУМЕНТЫ» персоны — не полный список', async () => {
    const p = await prefix('12');

    expect(count(p, TOOLS_LIST_NOTE)).toBe(1);
    expect(flat(TOOLS_LIST_NOTE)).toMatch(/Раздел «ИНСТРУМЕНТЫ» в твоей персоне/);
  });

  it('подписи — на языке пользователя', async () => {
    const p = await prefix('12', 'en');

    expect(p).toContain(platformGuide('en', STAFF));
    expect(p).not.toContain('«Студия»');
  });

  it('пользовательскому ассистенту блок не добавляется', async () => {
    const p = await prefix('custom:6f1c2b9e-0000-4000-8000-000000000000');

    expect(p).not.toContain('ЧТО ЕСТЬ В LINKEON');
    expect(p).not.toContain(TOOLS_LIST_NOTE);
  });

  it('штатному — правило инициативы', async () => {
    expect(await prefix('12')).toContain(INITIATIVE_RULE);
  });

  it('стор: карта без партнёрской программы', async () => {
    const p = await prefix('12', 'ru', true);
    expect(p).toContain(platformGuide('ru', { ...STAFF, store: true }));
    expect(p).not.toContain('«Партнёры»');
  });

  it('своему ассистенту — строка про справку, без карты и инициативы', async () => {
    const p = await prefix('custom:6f1c2b9e-0000-4000-8000-000000000000');
    expect(p).toContain(customAssistantHelpLine(HELP));
    expect(p).not.toContain(INITIATIVE_RULE);
  });

  // «Как устроено» на публичном уровне (решение владельца 24.10.2026): называть
  // нейросети платформы можно, называть себя моделью — нельзя.
  it('личность: себя — только своим именем; о нейросетях платформы — по справке', async () => {
    const p = flat(await prefix('12'));
    expect(p).not.toMatch(/Никогда не упоминай, что ты Claude/);
    expect(p).toMatch(/не говори, что ты Claude или другая модель/);
    expect(p).toMatch(/how-it-works/);
  });
});
