import { deletionErrorKind } from '../account-deletion/account-deletion.safe';
import { Neo4jService } from './neo4j.service';

/// T17-M1: deleteUserGraphStrict не должен вешать deletion-pipeline.
///
/// Half-open TCP: connectionTimeout драйвера покрывает только установку
/// соединения, а зависший session.run() держит execute() вечно — heartbeat
/// продлевает лизу, advisory lock не отпускается, и весь worker удаления
/// встаёт до рестарта. Поэтому run() ждём с bounded-таймаутом, а по его
/// истечении сессию закрываем принудительно (закрытие Session обрывает
/// Bolt-соединение и отменяет активный RUN на сервере — приём из readRows).
///
/// Ошибка таймаута обязана классифицироваться deletionErrorKind как
/// 'timeout' (safe.ts не изменяем): адаптер account.core.* превратит её в
/// DeletionRetryError('timeout') и runner повторит job через backoff.
///
/// Legacy deleteUserGraph здесь сознательно не тестируется: он глотает
/// ошибки by design и в pipeline не используется.

function makeService(session: any): Neo4jService {
  const service = new Neo4jService();
  // Драйвер — private; подменяем моделью так же, как в других neo4j-спеках.
  (service as any).driver = { session: () => session };
  return service;
}

describe('deleteUserGraphStrict — bounded timeout (T17-M1)', () => {
  it('зависший run(): reject в пределах таймаута, kind timeout, сессия закрыта', async () => {
    const close = jest.fn(async () => undefined);
    // Никогда не разрешающийся promise — модель half-open TCP.
    const run = jest.fn(() => new Promise(() => {}));
    const service = makeService({ run, close });

    const err = await service
      .deleteUserGraphStrict('u-test', 50)
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    // Классификация для адаптера: safe.ts знает этот исход как 'timeout'.
    expect(deletionErrorKind(err)).toBe('timeout');
    // Принудительный обрыв зависшего соединения.
    expect(close).toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      'MATCH (p:Profile {phone: $phone}) DETACH DELETE p',
      { phone: 'u-test' },
    );
  }, 5000);

  it('успешный путь: не ждёт таймаут, закрывает сессию один раз', async () => {
    const close = jest.fn(async () => undefined);
    const run = jest.fn(async () => ({ records: [] }));
    const service = makeService({ run, close });

    const started = Date.now();
    await service.deleteUserGraphStrict('u-test', 60_000);
    const elapsed = Date.now() - started;

    expect(run).toHaveBeenCalledWith(
      'MATCH (p:Profile {phone: $phone}) DETACH DELETE p',
      { phone: 'u-test' },
    );
    expect(close).toHaveBeenCalledTimes(1);
    // Resolve до гонки: метод возвращается сразу, а не через timeoutMs.
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);

  it('драйвер не настроен — warn без PII, без исключения (T17-M4)', async () => {
    const service = new Neo4jService();
    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      service.deleteUserGraphStrict('u-secret-identifier'),
    ).resolves.toBeUndefined();

    // Тихий return выглядел бы как «успех» в журнале job'а: misconfig деплоя
    // молча сохранил бы графовые PII при статусе done. Текст — без
    // идентификаторов пользователя.
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0][0]);
    expect(text).not.toContain('u-secret-identifier');
    expect(text.toLowerCase()).toContain('neo4j');
  });
});
