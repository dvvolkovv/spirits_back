import { TgRouterService } from './tg-router.service';

/**
 * Модель, на которой бот отвечает в Telegram.
 *
 * Один и тот же ассистент отвечал в вебе на Opus 5 (через relay r.linkeon.io),
 * а в телеге — на Sonnet 4.6, потому что TG-путь с самого начала строился на
 * локальном CLI и модель там была прибита гвоздями. Со стороны это выглядело
 * как «в телеге он тупее», хотя промпт и память те же.
 *
 * 'default', а не 'claude-opus-5': веб получает рекомендованную моделью CLI,
 * которая при исчерпании лимита подписки сама даунгрейдится. Хардкод Opus
 * такого не умеет — на упёртом лимите ход упадёт и бот просто замолчит.
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
  it('отвечает на той же модели, что и веб — CLI default, не Sonnet', async () => {
    const { svc, claudeCli } = makeRouter();

    await svc.generateReply(cfg, 'Дмитрий');

    expect(answerModel(claudeCli)).toBe('default');
  });

  it('не хардкодит opus — иначе исчезает авто-даунгрейд при исчерпании лимита', async () => {
    const { svc, claudeCli } = makeRouter();

    await svc.generateReply(cfg, 'Дмитрий');

    expect(answerModel(claudeCli)).not.toContain('opus');
  });

  it('smart-гейт остаётся на Haiku — он бесплатный для владельца и гоняется на каждое сообщение', async () => {
    const { svc, claudeCli } = makeRouter();

    const gated = await (svc as any).smartGate(cfg, { text: 'а что там по деньгам?', fromTgUserName: 'Арман' });

    expect(gated).toBe(true);
    expect(String(claudeCli.text.mock.calls[0][1].model)).toBe('claude-haiku-4-5');
  });
});
