import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { relaySessionKey } from './relay-session';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

/**
 * Ход с ВЛОЖЕНИЯМИ уходит в ТУ ЖЕ сессию релея, что и текстовый ход.
 *
 * Инцидент 08.09.2026, пользователь 79030169187: прислал выписку ЕГРИП, получил
 * разбор, а через девять минут на вопрос «выписка на сколько листов?» услышал
 * «точного числа заранее не назвать» — файл к тому моменту десять минут лежал на
 * диске релея. Такой же провал был на каждом файле за три недели до этого.
 *
 * Причина: два ключа сессии на один разговор. Текстовый ход шёл в
 * `<userId>_<assistantId>_<язык>`, загрузка — в `<userId>_<assistantId>`.
 * Путь к файлу объявляется в промпте только той сессии, куда файл прислали;
 * `_<язык>`-сессия резюмится и блок `history` при resume не получает, так что
 * до неё не доходила даже строка `📎 имя` из нашей БД.
 *
 * Тест проверяет ровно поля, уезжающие на релей: сам ключ, персону и историю.
 * Проверять ответ модели тут нечего — сломанный путь возвращал связный текст,
 * просто собранный без файла.
 */

const ANSWER = 'Готово.';

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

/** Поля multipart-запроса к релею — то, что реально уехало. */
function fieldsOf(fd: any): Record<string, string> {
  const boundary = fd.getBoundary();
  const raw = fd.getBuffer().toString('utf8');
  const out: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part);
    const head = part.indexOf('\r\n\r\n');
    if (!name || head < 0) continue;
    out[name[1]] = part.slice(head + 4).replace(/\r\n$/, '');
  }
  return out;
}

const AGENT = {
  id: 12,
  name: 'Роман',
  display_name: 'Роман',
  description: 'бизнес-ассистент',
  system_prompt: 'Ты Роман, помогаешь с налогами и документами.',
  category: 'business',
  is_active: true,
};

interface Pg {
  query: jest.Mock;
  calls: { sql: string; params: any[] }[];
}

function makePg(): Pg {
  const calls: { sql: string; params: any[] }[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
    if (/FROM agents WHERE id/.test(sql)) return { rows: [AGENT] };
    if (/FROM agents a\s+LEFT JOIN agent_translations/.test(sql)) {
      return { rows: [{ display_name: 'Оля', description: 'коуч' }] };
    }
    if (/FROM custom_chat_history/.test(sql) && /SELECT sender_type/.test(sql)) {
      return { rows: [
        { sender_type: 'ai', content: 'Собрал обращение заново.' },
        { sender_type: 'human', content: 'еще раз составь обращение' },
      ] };
    }
    return { rows: [] };
  });
  return { query, calls } as Pg;
}

function makeService(pg: Pg, lang = 'ru'): ChatService {
  // Тот же контракт, что у текстового хода: профиль главный, поле `lang` из
  // запроса — подстраховка на случай, когда язык туда ещё не доехал.
  const language = { resolveUserLanguage: jest.fn(async (_u: string, hint?: string) => hint || lang) };
  return new ChatService(
    pg as any, null as any, null as any, null as any, null as any, null as any,
    null as any, language as any, undefined, undefined, undefined, undefined,
  );
}

function makeReq(body: any = {}) {
  return {
    headers: { authorization: 'Bearer token' },
    files: [{ originalname: 'egrul.pdf', buffer: Buffer.from('x'), mimetype: 'application/pdf', size: 1 }],
    body: { message: 'что тут по листам?', assistantId: '12', ...body },
  } as any;
}

function makeRes() {
  const written: any[] = [];
  return {
    written,
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    write: jest.fn((s: string) => { try { written.push(JSON.parse(s)); } catch {} return true; }),
    end: jest.fn(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as any;
}

const PROFILE = 'Дмитрий, ИП прекращено 2021';

/** Прогоняет upload-and-chat и отдаёт поля, ушедшие на релей. */
async function upload(pg: Pg, body: any = {}): Promise<Record<string, string>> {
  const svc = makeService(pg);
  const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
  const neo4j = { getProfileDescription: jest.fn(async () => PROFILE) };
  const ctrl = new ChatController(svc, jwtSvc as any, neo4j as any, undefined);
  const post = jest.fn(async () => ({ data: sseStream([{ type: 'delta', text: ANSWER }, { type: 'done' }]) }));
  (axios as any).default = { post };
  (axios as any).post = post;

  await ctrl.uploadAndChat(makeReq(body), makeRes());
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  expect(post).toHaveBeenCalled();
  return fieldsOf(post.mock.calls[0][1]);
}

describe('relaySessionKey', () => {
  it('обычный ход: язык — часть ключа', () => {
    expect(relaySessionKey('u1', '12', 'ru')).toBe('u1_12_ru');
    expect(relaySessionKey('u1', '12', 'en')).toBe('u1_12_en');
  });

  it('чистый лист: ключ fresh-сессии перебивает всё', () => {
    expect(relaySessionKey('u1', '12', 'ru', 'u1_12_fresh_1786468316338'))
      .toBe('u1_12_fresh_1786468316338');
  });
});

describe('uploadAndChat: файл уходит в сессию разговора, а не в свою', () => {
  afterEach(() => jest.clearAllMocks());

  it('ключ сессии — тот же, что у текстового хода', async () => {
    const fields = await upload(makePg());

    expect(fields.sessionId).toBe(relaySessionKey('u1', '12', 'ru'));
    // Ровно то, что делал сломанный путь: ключ без языка, отдельная сессия.
    expect(fields.sessionId).not.toBe('u1_12');
  });

  it('язык из запроса доезжает до ключа: пустой язык профиля не разводит сессии', async () => {
    const fields = await upload(makePg(), { lang: 'en' });

    expect(fields.sessionId).toBe('u1_12_en');
  });

  it('чистый лист: файл уходит в fresh-сессию, а не в основную', async () => {
    const fields = await upload(makePg(), { fresh: 'true', freshTs: '1786468316338' });

    expect(fields.sessionId).toBe('u1_12_fresh_1786468316338');
  });

  it('везёт персону ассистента: иначе на файл ответит generic-агент релея', async () => {
    // Релей всегда передаёт --system-prompt, подставляя свой «universal agent»,
    // когда поля нет. При общей сессии это подменяло бы Романа на каждом ходе
    // с файлом — новый системный промпт применяется и при --resume.
    const fields = await upload(makePg());

    expect(fields.systemPrompt).toContain('Роман');
    expect(fields.systemPrompt).toContain(AGENT.system_prompt);
  });

  it('везёт хвост переписки: холодный старт сессии не теряет разговор', async () => {
    const fields = await upload(makePg());

    expect(fields.history).toContain('еще раз составь обращение');
  });

  it('профиль уезжает в системный промпт, а не в текст реплики', async () => {
    // Раньше профиль клеился в начало message и оседал в истории сессии
    // отдельной копией на каждый ход с файлом.
    const fields = await upload(makePg());

    expect(fields.systemPrompt).toContain(PROFILE);
    expect(fields.message).toBe('что тут по листам?');
  });
});
