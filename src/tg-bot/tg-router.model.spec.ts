import { TgRouterService } from './tg-router.service';
import { CHAT_MODEL } from '../common/chat-model';

/**
 * Модель, на которой бот отвечает в Telegram.
 *
 * Один и тот же ассистент отвечал в вебе на Opus (через relay r.linkeon.io), а
 * в телеге — на Sonnet 4.6, потому что TG-путь с самого начала строился на
 * локальном CLI и модель там была прибита гвоздями. Со стороны это выглядело
 * как «в телеге он тупее», хотя промпт и память те же. Инвариант, который
 * сторожит этот файл, с тех пор не менялся: веб и телега отвечают ОДНИМ И ТЕМ
 * ЖЕ, что бы это ни было.
 *
 * ЧТО ИЗМЕНИЛОСЬ 23.09.2026. Прежняя редакция требовала обратного — «не
 * хардкодить opus», потому что 'default' сам даунгрейдится при исчерпании
 * лимита подписки, а прибитый id падает и бот молча замолкает. Владелец
 * ознакомлен с этим разменом и выбрал пин: 'default' выбирает Anthropic, и
 * однажды он поедет без спроса. Тест не удалён, а переписан на новый инвариант
 * — старый был верным рассуждением, а не ошибкой, и снятие его должно быть
 * видно в истории.
 *
 * Страховка от того самого молчания — env-откат (CHAT_MODEL=default), поэтому
 * он тоже под тестом: это единственное, что стоит между принятым риском и
 * выкатом посреди инцидента.
 *
 * Гейт «стоит ли вмешаться» при этом обязан остаться на Haiku: он гоняется на
 * КАЖДОЕ сообщение группы и решает да/нет, а не пишет ответ. На Opus он стал бы
 * самой дорогой частью бота, причём бесплатной для владельца — гейт по спеку не
 * списывается.
 */

function makeRouter() {
  const claudeCli = {
    textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: 'ответ', costUsd: 0.01 })),
    text: jest.fn(async (_prompt: string, _opts: any) => 'yes'),
  };
  const svc = new TgRouterService({} as any, null as any, null as any, null as any, claudeCli as any);
  jest.spyOn(svc as any, 'resolveSystemPrompt').mockResolvedValue({ systemPrompt: 'системный промпт' });
  jest.spyOn(svc as any, 'loadHistory').mockResolvedValue([{ role: 'user', content: 'привет' }]);
  return { svc, claudeCli };
}

const cfg: any = { id: 1, tg_chat_id: '-100123' };

/** Модель, с которой роутер позвал CLI за ответом. */
const answerModel = (claudeCli: any) => String(claudeCli.textWithCost.mock.calls[0][1].model || '');

describe('TgRouterService: выбор модели', () => {
  it('отвечает той же моделью, что и веб — общей константой, а не своим литералом', async () => {
    const { svc, claudeCli } = makeRouter();

    await svc.generateReply(cfg, 'Дмитрий');

    // Сверка именно с CHAT_MODEL, а не с текстом модели: смысл теста в том,
    // что telegram и веб не могут разъехаться, а не в конкретной версии.
    expect(answerModel(claudeCli)).toBe(CHAT_MODEL);
  });

  it('по умолчанию это Opus 5.5 — решение владельца 23.09.2026', async () => {
    const { svc, claudeCli } = makeRouter();

    await svc.generateReply(cfg, 'Дмитрий');

    expect(answerModel(claudeCli)).toBe('claude-opus-5-5');
  });

  it('пин снимается из env, без выката — это откат на случай молчания ботов', () => {
    const prev = process.env.CHAT_MODEL;
    process.env.CHAT_MODEL = 'default';
    try {
      jest.isolateModules(() => {
        // Значение читается на загрузке модуля, поэтому проверяем именно
        // свежий импорт: иначе тест подтвердил бы кэш, а не поведение.
        const { CHAT_MODEL: overridden } = require('../common/chat-model');
        expect(overridden).toBe('default');
      });
    } finally {
      if (prev === undefined) delete process.env.CHAT_MODEL;
      else process.env.CHAT_MODEL = prev;
    }
  });

  it('smart-гейт остаётся на Haiku — он бесплатный для владельца и гоняется на каждое сообщение', async () => {
    const { svc, claudeCli } = makeRouter();

    const gated = await (svc as any).smartGate(cfg, { text: 'а что там по деньгам?', fromTgUserName: 'Арман' });

    expect(gated).toBe(true);
    expect(String(claudeCli.text.mock.calls[0][1].model)).toBe('claude-haiku-4-5');
  });
});
