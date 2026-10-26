/**
 * СТОРОЖ СТЫКА «текст отказа агента → причина у сервера».
 *
 * Сервер (src/products/provisioning.service.ts, REKEY_UNKNOWN_RE) по тексту
 * отказа смены ключей решает, что сказать человеку: «продукт работает со
 * старыми ключами, попробуйте ещё раз» (rekey_failed) или «смена прервалась,
 * продукт может не отвечать, напишите в поддержку» (rekey_unknown, плюс
 * logger.error со слагом). Других признаков у сервера нет — только слова.
 * Переформулированный здесь отказ молча переехал бы из второй группы в первую,
 * и владелец сломанного продукта читал бы «попробуйте ещё раз».
 *
 * Регулярка берётся ИЗ ФАЙЛА СЕРВЕРА, а не копией: копия разошлась бы с
 * оригиналом так же молча, как формулировка. Отчёты — настоящие, через runJob
 * и rekeyProduct на симуляторе хоста, а не строки из исходника: сторожится то,
 * что реально уезжает на сервер (вместе с describeFailure и маской redact).
 */
import * as fs from 'fs';
import * as path from 'path';
import { HostJob, JobReport } from './api';
import { HostConfig } from './config';
import { FakeHost, deps as fakeDeps } from './fake-host';
import { HostDeps, runJob } from './index';
import { provision } from './provision';
import { REKEY_BACKUP_SUFFIX, RekeyJob, rekeyProduct } from './rekey';

const SERVER = path.resolve(__dirname, '../../../src/products/provisioning.service.ts');

function serverUnknownRe(): RegExp {
  const m = fs.readFileSync(SERVER, 'utf8').match(/^const REKEY_UNKNOWN_RE = \/(.+)\/([a-z]*);$/m);
  if (!m) throw new Error(`REKEY_UNKNOWN_RE не найдена в ${SERVER} — стык агента и сервера потерян`);
  return new RegExp(m[1], m[2]);
}

const CONFIG: HostConfig = {
  linkeonUrl: 'https://test.linkeon.io',
  hostToken: 'x'.repeat(64),
  pollIntervalMs: 3000,
  pollTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
  reportAttempts: 1,
  reportRetryMs: 0,
};

const JOB: HostJob = {
  jobId: 'j-1', productId: 'p-1', slug: 'bot1', kind: 'bot', name: 'Бот', jobKind: 'rekey',
  runnerToken: '', port: null, secrets: { BOT_TOKEN: 'новый' }, dropNames: [],
};

let host: FakeHost;
beforeEach(async () => {
  host = new FakeHost();
  await provision({ slug: 'bot1', kind: 'bot', name: 'Бот', runnerToken: 'ткн-раннера', secrets: { BOT_TOKEN: 'старый' } }, fakeDeps(host));
});

function hostDeps(rekey: (job: RekeyJob) => Promise<void>, config: Partial<HostConfig> = {}): HostDeps {
  const never = () => Promise.reject(new Error('этот шаг здесь не зовётся'));
  return {
    config: { ...CONFIG, ...config },
    api: { poll: never, complete: never },
    provision: never,
    sleepProduct: never,
    wakeProduct: never,
    domain: never,
    rekey,
    purge: never,
  };
}
const realRekey = (job: RekeyJob) => rekeyProduct(job, fakeDeps(host, { waitPortTimeoutMs: 0, settleMs: 0 }));

async function failureOf(job: HostJob, deps: HostDeps): Promise<string> {
  const report: JobReport = await runJob(job, deps);
  if (report.ok !== false) throw new Error('ожидался отказ');
  return report.error;
}

describe('отказы смены ключей, после которых сервер обязан сказать «исход неизвестен»', () => {
  it('откат не удался — «НА ХОСТЕ ОСТАЛОСЬ» и «откат не удался»', async () => {
    host.healthy = (_name, c) => c.env.BOT_TOKEN !== 'новый';
    host.before = (argv) => {
      if (argv[1] === 'rename' && argv[2] === `bot1${REKEY_BACKUP_SUFFIX}`) throw new Error('Command failed: docker rename\nboom');
    };
    const error = await failureOf(JOB, hostDeps(realRekey));
    expect(error).toMatch(/^НА ХОСТЕ ОСТАЛОСЬ: /);
    expect(error).toContain('откат не удался');
    expect(error).toMatch(serverUnknownRe());
  });

  it('остаток прерванной смены — «от прерванной смены ключей»', async () => {
    await host.run(['docker', 'run', '-d', '--name', `bot1${REKEY_BACKUP_SUFFIX}`, '--restart', 'unless-stopped', 'linkeon-product:base']);
    const error = await failureOf(JOB, hostDeps(realRekey));
    expect(error).toContain('от прерванной смены ключей');
    expect(error).toMatch(serverUnknownRe());
  });

  it('контейнер не запущен — «не запущен (спит или прервана»', async () => {
    await host.run(['docker', 'stop', 'bot1']);
    const error = await failureOf(JOB, hostDeps(realRekey));
    expect(error).toContain('не запущен (спит или прервана');
    expect(error).toMatch(serverUnknownRe());
  });

  it('смена брошена по сроку — «НЕИЗВЕСТНО»', async () => {
    const error = await failureOf(JOB, hostDeps(() => new Promise<void>(() => {}), { provisionTimeoutMs: 10 }));
    expect(error).toContain('НЕИЗВЕСТНО');
    expect(error).toMatch(serverUnknownRe());
  });

  it('смена не началась: прежняя, брошенная по сроку, ещё идёт — «НЕИЗВЕСТНО»', async () => {
    const deps = hostDeps(() => new Promise<void>((resolve) => setTimeout(resolve, 60)), { provisionTimeoutMs: 10 });
    await failureOf(JOB, deps);
    const error = await failureOf({ ...JOB, jobId: 'j-2' }, deps);
    expect(error).toContain('не началась');
    expect(error).toContain('НЕИЗВЕСТНО');
    expect(error).toMatch(serverUnknownRe());
    await new Promise((r) => setTimeout(r, 80));
  });
});

describe('отказы, после которых продукт точно на старых ключах — сервер НЕ должен тревожить', () => {
  it('нездоров с новыми ключами, откат удался — маркеров нет', async () => {
    host.healthy = (_name, c) => c.env.BOT_TOKEN !== 'новый';
    const error = await failureOf(JOB, hostDeps(realRekey));
    expect(error).toContain('продукт возвращён со старыми ключами');
    expect(error).not.toMatch(serverUnknownRe());
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('старый');
  });

  it('незнакомый вид задания (агент старее сервера) — маркеров нет', async () => {
    const error = await failureOf({ ...JOB, jobKind: 'rekey-v2' }, hostDeps(realRekey));
    expect(error).toContain('неизвестный вид задания');
    expect(error).not.toMatch(serverUnknownRe());
  });
});
