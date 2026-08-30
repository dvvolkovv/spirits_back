import { TgBotService } from './tg-bot.service';
import { TgRouterService } from './tg-router.service';

/**
 * Упавший ход не должен выглядеть как молчание.
 *
 * Инцидент 30.08.2026: недельный лимит Claude уронил ход в чате «ИИ агент»,
 * юзер увидел «⚠️ Не получилось обработать запрос: …» — но в БД не появилось
 * ничего, кроме его собственного вопроса с отметкой answer_expected_at.
 * Детектор молчания ищет строку бота после отметки, не находит её никогда и
 * держит алерт «бот молчит N мин» сутки — уже после того, как бот вылечен и
 * отвечает в других чатах.
 *
 * Здесь закрывается класс отказа: любое падение генерации оставляет след в
 * истории чата, и этот след виден детектору.
 */

function makeRouter() {
  const pg = { query: jest.fn(async (_sql: string, _params?: any[]) => ({ rows: [] })) };
  const svc = new TgRouterService(pg as any, null as any, null as any, null as any, null as any);
  return { svc, pg };
}

function makeBot(over: { editMessageText?: jest.Mock; persistTurnFailure?: jest.Mock } = {}) {
  const grammy = { editMessageText: over.editMessageText ?? jest.fn(async () => {}) } as any;
  const router = { persistTurnFailure: over.persistTurnFailure ?? jest.fn(async () => {}) } as any;
  const svc = new TgBotService(
    null as any, null as any, null as any, null as any, router,
    null as any, null as any, null as any, grammy, null as any, null as any,
  );
  const warns: string[] = [];
  (svc as any).logger = { error: () => {}, warn: (m: string) => warns.push(m), log: () => {}, debug: () => {} };
  return { svc, grammy, router, warns };
}

const CFG = { id: 'cfg-1', tg_chat_id: '-100500' } as any;

describe('TgRouterService.persistTurnFailure', () => {
  it('пишет след в историю чата — иначе детектор молчания не увидит разбор', async () => {
    const { svc, pg } = makeRouter();

    await svc.persistTurnFailure(CFG, 'weekly limit');

    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO tg_bot_messages');
    expect(String(params[2])).toContain('weekly limit');
  });

  it('роль system, а не assistant: сбой не должен попадать в контекст следующего хода', async () => {
    // loadHistory берёт role IN ('user','assistant') — assistant-строкой мы бы
    // научили ассистента отвечать текстом собственной ошибки.
    const { svc, pg } = makeRouter();

    await svc.persistTurnFailure(CFG, 'boom');

    const sql = pg.query.mock.calls[0][0] as unknown as string;
    expect(sql).toContain("'system'");
    expect(sql).not.toContain("'assistant'");
  });

  it('ход не тарифицируется: юзер платит за ответ, а не за падение', async () => {
    const { svc, pg } = makeRouter();

    await svc.persistTurnFailure(CFG, 'boom');

    const sql = pg.query.mock.calls[0][0] as unknown as string;
    expect(sql).toContain('tokens_charged');
    expect(sql).toMatch(/VALUES \(\$1, \$2, 'system', \$3, 'text', 0\)/);
  });
});

describe('TgBotService.recordTurnFailure', () => {
  it('юзер видит ошибку, а история получает след — одно без другого не годится', async () => {
    const { svc, grammy, router } = makeBot();

    await (svc as any).recordTurnFailure(CFG, -100500, 77, new Error('weekly limit'));

    expect(grammy.editMessageText).toHaveBeenCalledWith(-100500, 77, expect.stringContaining('weekly limit'));
    expect(router.persistTurnFailure).toHaveBeenCalledWith(CFG, expect.stringContaining('weekly limit'));
  });

  it('нет статус-сообщения — след в БД всё равно остаётся', async () => {
    // Статус мог быть уже удалён или не создан: без записи такой чат снова
    // молчал бы для детектора.
    const { svc, grammy, router } = makeBot();

    await (svc as any).recordTurnFailure(CFG, -100500, null, new Error('boom'));

    expect(grammy.editMessageText).not.toHaveBeenCalled();
    expect(router.persistTurnFailure).toHaveBeenCalled();
  });

  it('провал уведомления не отменяет запись в БД', async () => {
    const { svc, router } = makeBot({
      editMessageText: jest.fn(async () => { throw new Error('message to edit not found'); }),
    });

    await (svc as any).recordTurnFailure(CFG, -100500, 77, new Error('boom'));

    expect(router.persistTurnFailure).toHaveBeenCalled();
  });

  it('падение самой записи не маскирует исходную ошибку — метод не бросает', async () => {
    const { svc, warns } = makeBot({
      persistTurnFailure: jest.fn(async () => { throw new Error('pg down'); }),
    });

    await expect((svc as any).recordTurnFailure(CFG, -100500, 77, new Error('boom'))).resolves.toBeUndefined();
    expect(warns.join('\n')).toContain('pg down');
  });
});
