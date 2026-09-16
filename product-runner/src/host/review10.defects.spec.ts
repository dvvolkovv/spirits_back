/**
 * Ревью задачи 10. Каждый тест здесь КРАСНЫЙ на коммите ca56ea1 и описывает
 * дефект, а не вкусовщину. Файл отдельный, чтобы его было чем удалить целиком,
 * когда дефекты закрыты.
 */
import { HostConfig } from './config';
import { HostDeps, provisionOverrides, redact, tick } from './index';
import { HostJob, JobReport, PollOutcome } from './api';

const JOB: HostJob = {
  jobId: 'j-1',
  productId: 'p-1',
  slug: 'shop',
  kind: 'site',
  name: 'Магазин',
  runnerToken: 'r'.repeat(64),
  secrets: {},
};

const CONFIG: HostConfig = {
  linkeonUrl: 'https://test.linkeon.io',
  hostToken: 'x'.repeat(64),
  pollIntervalMs: 3000,
  pollTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
  reportAttempts: 3,
  reportRetryMs: 10_000,
};

const OAUTH = 'sk-ant-oat01-НАСТОЯЩИЙ-ТОКЕН-ПОДПИСКИ';

/** Командная строка в том виде, в каком её кладёт в message execFile. */
function dockerRunMessage(extraSecretArgs: string): string {
  return (
    'Command failed: docker run -d --name shop -v /srv/products/shop:/product '
    + `${extraSecretArgs} -e LINKEON_URL=https://my.linkeon.io -e RUNNER_TOKEN=${JOB.runnerToken} `
    + `-e CLAUDE_CODE_OAUTH_TOKEN=${OAUTH} --memory=1g --cpus=1 linkeon-product:base\n`
    + 'docker: no space left on device'
  );
}

describe('ДЕФЕКТ 1: маска снимается значением секрета, которое задаёт клиент', () => {
  it('секрет со значением «-e CLAUDE_CODE_OAUTH_TOKEN=» выкладывает наш токен в карточку', () => {
    // Значение секрета не проверяется ничем (provision.ts отвергает только
    // нулевой байт) и приезжает от клиента через кабинет.
    //
    // Правило 1 вырезает ИЗВЕСТНЫЕ значения по всему тексту. Клиент задаёт
    // значение, равное префиксу НАШЕГО собственного аргумента, — и правило 1
    // съедает этот префикс у обоих вхождений:
    //
    //   ... -e EVIL=-e CLAUDE_CODE_OAUTH_TOKEN= ... -e CLAUDE_CODE_OAUTH_TOKEN=sk-…
    //   ... -e EVIL=***                         ... ***sk-…
    //
    // После этого правилу 2 нечего сопоставлять: `-e ИМЯ=` перед токеном больше
    // нет. Токен уезжает в products.provision_error и показывается в карточке
    // продукта — ровно та авария, ради которой redact() и написан.
    const evil = '-e CLAUDE_CODE_OAUTH_TOKEN=';
    const job = { ...JOB, secrets: { EVIL: evil } };

    const out = redact(dockerRunMessage(`-e EVIL=${evil}`), job);

    expect(out).not.toContain(OAUTH);
  });

  it('короткое значение с пробелом маскируется только до первого пробела', () => {
    // Доку правила 1 («короче восьми символов не трогаем: такой секрет всё
    // равно закрыт правилом 2») это опровергает: правило 2 режет по \S*, то
    // есть до первого пробела.
    const secret = 'a b c d'; // 7 символов, правило 1 его пропускает
    const job = { ...JOB, secrets: { K: secret } };

    const out = redact(`Command failed: docker run -e K=${secret} linkeon-product:base`, job);

    expect(out).not.toContain('b c d');
  });
});

describe('ДЕФЕКТ 2: фазовые сообщения провижининга уезжают в журнал без маски', () => {
  it('онPhase не маскирует командную строку, а provision кладёт в неё message целиком', () => {
    // provision.ts в catch зовёт
    //   phase(`провижининг отменён, на хосте чисто: ${e?.message ?? e}`)
    // — то есть тот же текст, который для СЕРВЕРА заботливо чистит redact(),
    // для журнала хоста печатается как есть. Заявление коммита «в лог — только
    // слаг, форма и id задания» держится лишь на пути, где провижининг не
    // отказал.
    const logged: string[] = [];

    provisionOverrides(CONFIG, (m) => logged.push(m)).onPhase!(
      `провижининг отменён, на хосте чисто: ${dockerRunMessage('')}`,
    );

    expect(logged.join('\n')).not.toContain(OAUTH);
  });
});

describe('ДЕФЕКТ 3: у провижининга нет срока — зависший шаг вешает агента навсегда', () => {
  it('оборот заканчивается, даже если provision не возвращается никогда', async () => {
    // У каждого HTTP-запроса агента срок есть, и причина названа в api.ts:
    // «процесс жив, просто ничего не делает, и кнопка Новый продукт перестаёт
    // работать молча». У provision срока нет ни здесь, ни внутри: execFileAsync
    // в hostDeps вызывается без timeout. Зависший `docker run` (заклинивший
    // dockerd, NFS-монтирование) останавливает ЕДИНСТВЕННОГО агента машины
    // навсегда: сервер через 10 минут похоронит задание, владелец нажмёт
    // «повторить», новое задание ляжет в очередь — и его никто не заберёт.
    jest.useFakeTimers();
    try {
      const poll = jest.fn(async (): Promise<PollOutcome> => ({ ok: true, job: JOB }));
      const complete = jest.fn(async (_id: string, _r: JobReport) => true);
      const deps: HostDeps = {
        config: CONFIG,
        api: { poll, complete },
        provision: () => new Promise<{ port?: number }>(() => {}),
        log: () => {},
      };

      let settled = false;
      void tick(deps).then(() => {
        settled = true;
      });

      // Вдесятеро больше серверного срока заведения.
      await jest.advanceTimersByTimeAsync(100 * 60 * 1000);

      expect(settled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
